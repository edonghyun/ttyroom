# TTYRoom 백엔드

React 화면과 Connector를 포함한 기본 실행은 [루트 빠른 시작](../README.md#빠른-시작--spring--react--connector)을
따른다. 아래 명령은 Node 설치 없이 사용하는 Java 단독 개발 경로다.

Java 21 + Spring Boot 4.0.8 + Gradle Wrapper 9.7.1. 버전은 고정하며 Wrapper 다운로드의 SHA-256도 검사한다. [Spring 공식 호환 범위](https://docs.spring.io/spring-boot/4.0/system-requirements.html)를 기준으로 선택했다.

```sh
cd backend
./gradlew bootRun       # 개발 실행
./gradlew test          # Java 동작 + 계층 의존성 테스트
./gradlew test bootJar  # 테스트 + 실행 JAR 생성

# 빌드된 JAR 실행
TTYROOM_PORT=3000 TTYROOM_STATE_PATH=.ttyroom/rooms.sqlite \
  java -jar build/libs/ttyroom-backend.jar
```

Java 21 JDK가 필요하다. `JAVA_HOME`을 해당 JDK 경로로 지정한다. 이 프로젝트의 빌드·실행에는 pnpm이 필요하지 않다. 루트 pnpm workspace와 독립적으로 Gradle Wrapper를 사용한다.

현재 구현은 HTTP 방 생성·WebSocket 입장, Host inventory와 출력 replay, 터미널 생성·종료·resize·메타데이터·제목·창 배치, exclusive/shared 입력, 참여자 focus/cursor 동기화다. 다음 기능과 리팩터링은 [책임·동시성·실패 처리 기준](ARCHITECTURE.md)에 따라 검토한다.

- `127.0.0.1`에만 bind하며 `TTYROOM_PORT`를 읽는다. 기본 3000, 0은 임의 포트다. 외부 노출 정책은 후속 단계에서 정한다.
- `GET /healthz`는 200, plain text `ok`를 반환한다.
- 초기화가 끝나면 `TTYRoom server listening at http://127.0.0.1:PORT`를 출력한다.
- 잘못된 포트 설정은 Spring 시작 오류로 처리한다.
- Spring 종료 유예는 5초다. 기존 E2E 실행기는 250ms 후 강제 종료할 수 있으므로 프로세스 smoke는 graceful drain 보장이 아니다.

`POST /api/rooms`는 이름을 검증하고 방과 초대 URL을 생성한다. 응답 형식은 [HTTP 계약](../protocol/HTTP.md)을 따른다. 방과 토큰 SHA-256 해시는 메모리 또는 설정한 SQLite 파일에 보관한다. 토큰 원문은 초대 응답에만 사용하며 인증 비교는 고정 길이 digest의 constant-time 비교를 사용한다.

`TTYROOM_STATE_PATH`가 없거나 빈 문자열이면 메모리 모드다. 경로를 지정하면 부모 디렉터리를
생성하고 SQLite 파일에서 모든 방을 복원한 뒤 readiness를 알린다. 상대 경로는 실행 디렉터리 기준이다.
저장소 열기·레코드 복원 실패는 시작 오류로 처리하며 메모리로 대체하지 않는다. 같은 파일은 한 서버가
소유하는 구성으로 사용한다.

새 프로세스에서도 초대·host 식별·terminal 상태와 다음 ID를 복원한다. 연결·lease·focus·출력 history는
초기화한다. 살아 있는 Connector가 재접속하여 PTY inventory와 단절 중 출력을 다시 전달한다.
[부팅 연결·재시작 검증](../docs/2026-09-28-sqlite-startup.md)에 근거와 한계를 기록했다.

`TTYROOM_CONFIG_PATH`로 JSON 설정을 선택하며, 생략하면 실행 디렉터리의 `ttyroom.config.json`을
읽는다. 기본 파일이 없을 때만 기본값을 쓴다. `TTYROOM_*` 값이 파일보다 우선한다. 유예·출력 보관량·
송신 드롭·수신 바이너리 한도를 적용하며 잘못된 값은 시작 오류로 처리한다.
[설정 키·우선순위](../docs/2026-09-28-server-settings.md)를 참고한다.
출력 속도 변경은 Connector 협상이 없어 아직 지원하지 않는다.

웹 빌드 결과를 `bootJar -PwebDist=../web/dist`로 묶으면 Spring에서 React 화면도 제공한다. 기본
Java 빌드와 bootRun은 API-only이며 Node를 호출하지 않는다. 실제 Chromium·Connector로 검사하는
[브라우저 E2E](../docs/2026-09-28-spring-browser-e2e.md)도 연결했다.

## 실제 JAR 프로세스 검사

저장소 루트에서 실행한다. JSON argv에는 실제 Java 경로와 JAR의 **절대 경로**를 넣는다. 실행기가 임시 디렉터리를 cwd로 사용하기 때문이다.

```sh
TTYROOM_E2E_SERVER_COMMAND='["java","-jar","/absolute/path/to/main/backend/build/libs/ttyroom-backend.jar"]' \
  pnpm --filter @ttyroom/e2e exec tsx src/backend-smoke.ts
```

시작 로그와 HTTP readiness, 새 PID로 재시작, 기존 포트 재사용을 검사하고 프로세스를 정리한다. 구현한 기능의 공통 프로토콜 계약은 같은 실행 경계로 검증하며 목록은 [E2E 안내](../e2e/README.md)를 따른다.

## Java 계층 의존성 검사

`./gradlew test`에 [ArchitectureTests](src/test/java/dev/ttyroom/architecture/ArchitectureTests.java)가
포함된다. 계층 검사만 실행하려면 `./gradlew test --tests dev.ttyroom.architecture.ArchitectureTests`를
사용한다. ArchUnit은 테스트 의존성이며 실행 JAR에는 들어가지 않는다.
[허용 의존성·탐지 범위·위반 주입 검증](../docs/2026-09-22-java-architecture-tests.md)을 함께 기록했다.
기존 Java CI도 같은 test 작업을 실행하므로 별도 실행 단계를 요구하지 않는다.

## 검증과 설계 근거

- [Java 테스트 작성 기준](TESTING.md): 준비·행동·관찰·검증, fixture 수명과 동시성 조건.
- [백엔드 설계](ARCHITECTURE.md): 방별 명령 순서, 저장 후 commit, 수신자별 실패 처리.
- [핵심 계약과 테스트](../docs/CONTRACTS.md): 코드와 단위·프로세스·브라우저 검증의 연결.
- [검증 기록](../docs/VERIFICATION.md): 실행 소스·환경·범위별 결과.
- [보안 모델](../docs/SECURITY_MODEL.md): 현재 토큰·역할 신뢰와 외부 운영 전 과제.

단계별 개발 결과와 당시의 미구현 항목은 [구현 이력](history/implementation-notes.md)에 보관한다.
