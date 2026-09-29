# Java 계층 의존성 자동 검사 — P3r

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-22. 문서와 수동 jdeps 확인으로 유지하던 의존성 경계를 Java 테스트로 고정했다.
제품 동작을 변경하지 않으며 기존 Gradle test와 Java CI에서 함께 실행한다.

## 검사 규칙

[ArchitectureTests](../backend/src/test/java/dev/ttyroom/architecture/ArchitectureTests.java)의
일반 JUnit 테스트 5개가 production 바이트코드를 검사한다.

| 대상                   | 허용 / 금지                                                                  |
| ---------------------- | ---------------------------------------------------------------------------- |
| domain                 | domain과 `java..`만 허용                                                     |
| application            | application·domain·`java..`만 허용                                           |
| adapter 하위 경계      | http·ws 등 서로 다른 adapter 간 직접 의존 금지                               |
| production 클래스 위치 | domain·application·adapter 하위 패키지 또는 진입점 TtyRoomApplication만 허용 |
| 조립 진입점            | 다른 production 클래스에서 TtyRoomApplication 역참조 금지                    |

Spring/Jackson/Jakarta 타입을 domain/application의 필드·메서드·제네릭·annotation 등에 넣으면
실패한다. adapter는 Spring과 wire 변환을 소유하며 domain의 불변 결과 타입을 참조할 수 있다.
adapter 간 연동은 application의 동작/포트를 통한다. `adapter` 최상위에 공용 클래스를 두거나
새 패키지로 이동해 규칙을 우회하는 경우도 실패한다.

`java..`는 현재 허용한 Java 표준 타입 범위다. 새 외부 라이브러리나 별도 계층이 필요하면
의존성을 늘리는 이유와 책임 경계를 함께 검토한다. 기존 위반을 무시하는 baseline이나 광범위한
예외 목록은 만들지 않았다. 동적 문자열/리플렉션 참조와 저장·잠금·실패 처리의 실행 의미는
이 정적 검사만으로 증명하지 않으며 기존 동작·계약 테스트로 검증한다.

## 구현 선택과 리뷰

[ArchUnit 공식 안내](https://www.archunit.org/userguide/html/000_Index.html)의 바이트코드 import와
의존성 규칙 API를 사용한다. [1.5.0](https://github.com/TNG/ArchUnit/releases/tag/v1.5.0)을
`testImplementation`으로 고정했으며 자체 소스 정규식 검사나 바이트코드 분석기를 만들지 않았다.
기존 JUnit에서 직접 실행하므로 별도 ArchUnit 테스트 엔진·Gradle 플러그인도 추가하지 않았다.

TtyRoomApplication의 CodeSource 위치 전체를 import한다. `src/test`와 테스트 fixture는 제외하고,
앞으로 추가되는 production 패키지까지 검사한다. `dev.ttyroom` 패키지만 검색하지 않으므로
그 밖으로 옮긴 클래스도 분류 검사에 걸린다. 경로를 cwd나 build/classes 문자열에 고정하지 않는다.

기존 CI의 backend job이 `./gradlew test bootJar --no-daemon`을 실행하므로 workflow 수정 없이
검사가 포함된다. 이 작업에서 원격 CI를 실행한 것은 아니며 동일한 Gradle 작업을 로컬에서 검증했다.

```sh
cd backend
./gradlew test --tests dev.ttyroom.architecture.ArchitectureTests
./gradlew clean test bootJar --no-daemon
```

## 실제 위반 주입과 복구 검증

먼저 현재 production 코드가 5개 규칙을 통과하는 것을 확인했다. 이어 임시 production 클래스를
추가하고 실제 Gradle 검사가 실패하는지 확인했다. 실패 보고서의 클래스·의존 타입까지 검증해,
다른 오류나 컴파일 실패를 성공적인 탐지로 취급하지 않았다.

| 주입한 위반                                                       | 확인한 실패             |
| ----------------------------------------------------------------- | ----------------------- |
| domain의 Spring annotation 및 application 배열/제네릭 타입        | domain 의존성 규칙      |
| application record의 Jackson 제네릭 타입 및 adapter class literal | application 의존성 규칙 |
| HTTP adapter의 WebSocket adapter 필드                             | adapter 간 의존성 규칙  |
| adapter 최상위 클래스 및 `outside` 패키지 클래스                  | production 분류 규칙    |
| HTTP adapter의 TtyRoomApplication class literal                   | 진입점 역참조 규칙      |

모든 임시 코드를 제거한 뒤 **clean test bootJar 성공, Java 217개 통과**를 확인했다.
그중 5개가 새 계층 검사이고 기존 212개 동작 테스트도 통과했다. Java 포맷 검사도 통과했다.

빌드 전후 실행 JAR 안의 production 클래스 **121개가 모두 동일한 SHA-256**임을 확인했다.
실행 JAR에는 ArchUnit과 임시 probe 클래스가 없다. 제품 바이트코드가 같고 테스트/문서만 바뀌어
이번 단계에서 Node/Spring 프로세스 E2E는 다시 실행하지 않았다.

근거: `artifacts/migration-baseline/p3r-architecture/`의 baseline.log, mutations-red.log,
mutations-report.xml, mutations.json, gradle.log, validation.json, java-format.log.
`verify-mutations.py`는 위반 주입 검증을 재현하기 위한 일회성 도구다. 실행 중에는 다른 빌드나 서버
프로세스를 띄우지 않으며 실행 후 clean test로 임시 컴파일 산출물까지 제거한다.

다음 단계는 영속 저장 경계와 저장 실패·재시작 복원 계약을 정의하는 것이다. 저장 성공 전 상태와
알림이 노출되지 않는 기존 Node 규칙을 이식하고, 고빈도 출력·cursor는 저장 경로에서 분리해야 한다.
