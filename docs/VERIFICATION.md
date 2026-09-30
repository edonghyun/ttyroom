# 검증 기록

## 2026-09-30 수신 자원 한도와 참가자 fanout T10.2

- Java 전체 **485개 통과**, 실패·오류·skip 0. UTF-8 분할, 누적 한도, 기한 연장 방지,
  늦은 timer, 연결 종료, 1 MiB control inbox 배선·폐기를 포함한다.
- TS 단위 **584개**, 타입·Prettier·의존성 경계 검사 통과.
- 실제 Spring 최대 heap 512 MiB 인증·자원 격리 **22개 통과**. 기존 정상 흐름 외에
  256 KiB 경계 hello, 과대 메시지 1009, 미완성 text/binary 1008, 다른 참가자의 요청 처리를 확인했다.
- `artifacts/t10-2/utf8-red.log`는 구현 전 UTF-8 한도 assertion 실패,
  `isolation-red.log`는 수정 전 JAR에서 4개 종료 대기 실패다. GREEN 및 전체 회귀 로그도 같은 디렉터리에 있다.
- 최대 heap 512 MiB 참가자 1·5·10명 각 3회, **9회 완료**. 입력 180·동시 복구 45개 완료, RSS 수집 실패 0.
  Java 송신 어댑터 측정도 4개 시나리오 × 별도 JVM 3회 통과했다.
- 성능 조건·원본·결과는 [성능 측정](PERFORMANCE.md)에 모은다. 지연 수치는 correctness CI gate가 아니다.

## 2026-09-30 성능 측정과 수신 버퍼 T10.1

macOS·Java 21·Node 26에서 실행했다. 측정 조건·환경·전후 수치는 [성능 안내](PERFORMANCE.md),
개별 관측값은 [공개 원시 JSON](performance/baseline.json)에 둔다. 전체 로그는 `artifacts/t10-1/`이다.

- Java 전체 **472개 통과**, 실패·오류·skip 0. 수신 조각의 누적 한도·복사·초기화·종료와
  완성 전 인증/입력 차단을 포함한다. 성능 tag는 일반 test에서 제외한다.
- TypeScript 단위 **584개 통과**: protocol 102, E2E guard 12, Connector 65, React 187, Node 218.
- Spring v8 인증·취소 프로세스 **17개 통과**, 최대 힙 512 MiB. 64 KiB 분할 hello와 binary를 포함한다.
- 기존 실제 PTY Chromium **42개 통과**, 최대 힙 512 MiB.
- 전후 비교 브라우저 각각 **3회**, 수정 후 512 MiB **3회** 완료. 각 실행은 입력 20개·replay 5개다.
  송신 어댑터 실험은 일반 큐·느린 수신자·replay 두 크기를 별도 JVM 3개에서 반복했다.
- 타입·의존성·Prettier 검사와 Java AOSP 포맷, diff 공백 검사 통과.

최초 512 MiB 실패 3회와 추가 진단의 heap OOM은 삭제하지 않았다. 수정 전 첫 비교와 부하를 겹치지
않게 한 추가 비교도 모두 남겼다. 결과 요약은 추가 비교를 사용한다. 하네스의 history 준비 실패는
제품 결함과 구분한다. 보고서 실패 보존·분할 hello의 RED/GREEN과 추가 회귀 테스트의 성격도 구분했다.
공개 CI의 최종 실행과 커밋은 [T10.1 issue](https://github.com/edonghyun/ttyroom/issues/10)에 기록한다.
다중 사용자 용량·장시간 누수·원격망 지연·운영 SLO 검증은 포함하지 않는다.

## 2026-09-30 HTTP 명세 검증 T11.1

기준 커밋 `cc9e2c6`, Java 21·macOS에서 실행했다. 로그는 로컬 `artifacts/t11-1/`에 둔다.
제품 실행 코드를 바꾸지 않아 실제 프로세스 검증은 T9.5에서 검증한 동일 JAR의 불변 복사본을 사용했다.

- Java 전체 **463개 통과**, 실패·오류·skip 0. 명시적 라우트와 OpenAPI 경로의 일치,
  저장 실패 503 다섯 작업, 공유 v8 코덱 예시를 포함한다.
- TS 단위 **581개 통과**: protocol 102, HTTP 명세 guard 9, Connector 65, React 187, Node 비교 서버 218.
- 실제 Spring HTTP·wire 명세 **9개**, 기존 등록 **4개**, 합계 **13개 통과**.
  성공·거절 응답의 스키마·상태·Content-Type·no-store·빈 204와 문서 hello/취소 오류를 검증했다.
- 타입·Prettier·의존성 경계 검사 통과. Java AOSP 포맷 적용.

최초 guard 테스트는 필수 헤더가 없는 204를 잘못 통과시키는 assertion 실패였다.
수정 후 GREEN을 확인했다. Java resource 설정의 자기 의존 실패는 준비 오류로 따로 보관했다.
기존 서버의 응답을 새 명세와 비교한 성공은 특성화이며 새 제품 기능의 TDD로 주장하지 않는다.

OpenAPI 구조·예시 검사는 pnpm test, 실제 HTTP 응답은 기존 registration CI 단계,
Java 경로·503·wire fixture는 Java test에 연결했다.
최종 커밋과 공개 CI는 [T11.1 issue](https://github.com/edonghyun/ttyroom/issues/11)에 기록한다.
전체 설명 문장, 모든 요청 조합, 공개 운영 보안을 자동 증명하는 검증은 아니다.

## 2026-09-30 credential 취소 T9.5

Java 21·macOS, 기준 커밋 `3240614`에서 검증했다. 원본 로그는 로컬 `artifacts/t9-5/`에 둔다.
API가 없던 최초 테스트는 HTTP 404/204 차이로 RED를 확인했다. 이 뒤 추가한 경합·저장 실패 테스트는
회귀 검증이며 모두 RED부터 실행했다고 표현하지 않는다.

- Java 전체 **455개 통과**, 실패·오류·skip 0. 입장/취소 공유 fixture 정리 후 전체 재검증.
- Spring v8 프로세스 **15개 통과**: 입장 13개와 취소·재시작 2개.
- Spring v8 Chromium **42개 통과**: 실제 Connector·PTY·두 브라우저 조합.
  Alice 취소 후 권한 오류 표시·자동 재등록 없음·Bob의 lease 획득과 같은 PTY 출력 확인.
- 기존 HTTP 등록 프로세스 **4개 통과**.
- TypeScript 타입·의존성 경계 검사 통과. Java AOSP 포맷 적용.

E2E는 복사한 불변 JAR를 사용했다. 취소/교체의 양쪽 순서는 Java application 테스트에서
저장 gate와 실제 명령 lock queue로 통제했다. 프로세스·브라우저 검증과 이 경합 검증을 구분한다.
원격 CI 결과와 최종 커밋은 [T9.5 issue](https://github.com/edonghyun/ttyroom/issues/9)에 연결한다.
이 검증은 로컬 협업의 credential 취소 계약이며 공개 운영 보안 검증이 아니다.

## 2026-09-30 클라이언트 credential 연동 T9.4

Java 21·macOS에서 검증했다. 기준 커밋은 `604117b`, 구현 커밋은 [`9b752b6`](https://github.com/edonghyun/ttyroom/commit/9b752b67d56a4697b1007967720d5da1c5c56975)이다.
로그와 변경 파일 SHA-256 목록은 로컬 `artifacts/t9-4/`에 보관한다. 공개 CI의 최종 실행은 [T9.4 issue](https://github.com/edonghyun/ttyroom/issues/8)에 연결한다.

- Java 전체 **436개 통과**, 실패·오류·skip 0. 서버 기본 버전 8의 실패 테스트 후 구현했다.
- TS 단위 **571개 통과**: protocol 101, Connector 65, React 187, Node 비교 서버 218.
- 네이티브/어댑터 통합 **37개 통과**: Connector 16, Node 21.
- Node v7 공통 프로세스도 수정 후 **213개 통과**했다.
- Spring v7 공통 프로세스 **213개 통과**: 기존 205개와 정적 웹 8개.
- Spring v8 인증 **13개**, HTTP 등록 **4개 통과**.
- Spring v8 Chromium 브라우저 **41개 통과**. 실제 등록·숨김 stdin·Connector·PTY 조합을 사용한다.
  입장 상태 리팩터링 뒤에는 등록·복구 **8개**와 런타임 단위를 다시 검증했다.
- 전체 타입·Prettier·의존성 경계 검사 통과. Java AOSP 포맷 적용.

최초 브라우저 실행은 40개 통과·1개 실패였다. 예전 명령 문자열 기대값을 교정하고, 별도로 드러난
클립보드 권한 거절의 허위 Copied 표시를 RED → 수정 → GREEN으로 해결했다.
Node 공통 프로세스 최초 실행은 fixture의 명시적 버전 설정을 기존 파서가 거절하여
33개 통과·180개 준비 실패였다. v7 설정 허용·v8 거절을 고정한 테스트 후 설정 경계를 수정했다.
새 API 부재로 실패한 테스트와 실제 행동 실패는 [작업 이력](WORK_LOG.md#reactconnector-credential-입장)에 구분했다.

제품 브라우저 CI는 Spring v8을 검증한다. Node v7은 공통 프로세스·단위·통합과 고정 wire fixture로 검증한다.
현재 React·Connector를 v7 서버에 연결하는 브라우저 조합은 지원하지 않는다.
HTTP 취소·활성 연결 종료·최종 취소 경합은 T9.5 범위이며 공개 운영 인증 완료로 주장하지 않는다.

재현 순서는 다음과 같다. Java 21의 JAVA_HOME을 지정하고 의존성 설치를 먼저 완료한다.

```sh
./scripts/build-spring.sh
pnpm typecheck
pnpm test
pnpm test:integration
./scripts/test-spring.sh protocol
./scripts/test-spring.sh registration
./scripts/test-spring.sh authentication
./scripts/test-spring.sh browser
pnpm --filter @ttyroom/server build
pnpm test:e2e
pnpm format
pnpm depcruise
```

## 2026-09-30 v8 입장 T9.3

최초 인증 커밋 `8e1daf4`를 Java 21·macOS에서 검증했다. 원본 로그와
변경 파일 SHA-256 목록은 로컬 `artifacts/t9-3/`에 둔다. 기준 커밋은 `11235ac`이다.

- Java 전체 **432개 통과**, 실패·오류·skip 0. 파서 8개·입장 11개·설정 7개가 추가됐다.
- Spring v8 프로세스 **13개 통과**: 주체 인증·신원 필드 거절·v7 격리·교체·새 PID의 host 복원.
- Spring 등록 프로세스 **4개 통과**. HTTP 권한·응답·재시작 계약을 유지한다.
- Spring v7 공통 프로세스 **205개·17개 파일 통과**. API-only JAR이므로 정적 웹 8개는 제외했다.
- TS 단위 **544개 통과**: protocol 95, Connector 58, React 175, Node 비교 서버 216.
- 전체 타입·포맷·의존성 경계 검사 통과. Java는 AOSP 포맷으로 정리했다.

새 동작의 RED와 기존 동작의 특성화, fixture 기대값·파일 소유권 수정은
[작업 이력](WORK_LOG.md#v8-입장과-연결-교체)에 구분했다. 첫 v8 프로세스 실행에서 발생한
구버전 디코더 사용 실패 3개는 의존성 빌드를 먼저 완료한 뒤 전체를 재실행해 해소했다.
첫 v7 전체 실행은 버전 오류 후 연결 종료의 회귀 1개로 204개 통과·1개 실패였다.
파서 회귀 테스트와 수정 후 전체를 다시 실행했다. 최종 Java 빌드 뒤 JAR를 복사했으며 실행 중 JAR·protocol 산출물을 다시 쓰지 않았다.
JAR SHA-256: `b5ce0071b3dda26f8a1943c0e9df9f90f2faa1bc3b12ae68123265c8da4e5e49`.

Java 21의 JAVA_HOME과 의존성 설치를 마친 저장소 루트에서 순서대로 실행한다.

```sh
pnpm --filter @ttyroom/connector... build
backend/gradlew -p backend test bootJar
./scripts/test-spring.sh authentication
./scripts/test-spring.sh registration
./scripts/test-spring.sh protocol --exclude src/static-web.e2e.ts
pnpm typecheck
pnpm test
pnpm format
pnpm depcruise
```

위 API-only 검증은 브라우저를 제외했다. 이후 공개 CI에서 기존 출력 순서 경합을 확인해 아래 검증을 추가했다.
현재 React·Connector의 v8 연동, 공개 취소 API, 운영 배포는 이번 완료 범위가 아니다.
취소 경합은 내부 Java command queue를 제어한 검증이다.

### CI에서 드러난 초기 출력 순서 경합

[최초 CI](https://github.com/edonghyun/ttyroom/actions/runs/36595733437)는 Spring 브라우저 4개,
같은 커밋 재실행에서는 3개가 빈 출력으로 실패했다. 로컬 38개·추가 반복 20회는 통과했다.
진단 fixture를 추가한 [CI](https://github.com/edonghyun/ttyroom/actions/runs/36597749150)의
2개 실패에서는 출력 seq 1·2가 terminal-opened보다 먼저 도착했다. 진단 추가 중 발견한
Playwright callback overload 타입 오류는 `0d74f22`에서 수정했다. 재실행 성공으로 원인 해결을 대신하지 않았다.

해당 터미널의 생성 확인과 초기 출력만 기존 bounded inbox에서 순서를 보존하도록 수정했다.
수정 후 웹 포함 JAR로 실행한 로컬 결과는 다음과 같다.

- Java 전체 **436개 통과**. 순서 RED 2개와 종료·큐 상한 보강 2개가 추가됐다.
- Chromium 브라우저 **38개 통과**. 실제 Connector·PTY, 초기 출력·탭 복제·재접속·서버 재시작 포함.
- Spring 생성·입장 프로세스 **33개**, inventory·replay 복구 **10개**, v8 입장 **13개 통과**.
- Java 포맷, TypeScript 타입·전체 포맷 검사 통과. TS 제품 코드는 변경하지 않았다.

```sh
./scripts/build-spring.sh
./scripts/test-spring.sh browser
./scripts/test-spring.sh protocol src/terminal-creation.e2e.ts src/admission.e2e.ts src/terminal-recovery.e2e.ts
./scripts/test-spring.sh authentication
```

후속 검증 JAR SHA-256: `e5e42aecd7a6cc945d3c3321c3496fba1b905c059d2a00722e034bf444e36f5e`.
변경 파일 해시와 로그는 `artifacts/t9-3/announcement-*`에 둔다. 공개 CI 전체의 최종 상태는
[완료 이슈](https://github.com/edonghyun/ttyroom/issues/7)의 검증 커밋·실행 링크로 확인한다.

## 2026-09-30 등록 API 권한 T9.2

[HTTP 계약](../protocol/HTTP.md#spring-등록-api)의 관리 credential과 참가자·host 등록을 검증했다.
macOS·Java 21에서 API-only JAR를 빌드했다. 원본 로그는 로컬 `artifacts/t9-2/`에 둔다.

- Java 전체 **406개 통과**, 실패·오류·skip 0. HTTP 어댑터 21개·등록 저장 3개를 추가하고
  기존 credential 모델·파일 복원 테스트에 MANAGER 역할 사례가 각각 1개 늘었다.
- Spring v7 공통 프로세스 **205개·17개 파일 통과**. API-only JAR이므로 정적 웹 8개는 실행 대상에서 제외했다.
- Spring 등록 프로세스 **4개 통과**: 실제 JAR의 HTTP 응답·권한·재등록·새 PID의 관리 권한 복원.
- Node 공통 HTTP **23개 통과**: 공통 필드·오류·본문 제한을 유지한다. Node에는 등록 API를 추가하지 않았다.
- E2E 타입 검사·포맷·의존성 경계 검사 통과. Java는 AOSP 포맷으로 정리했다.

새 방 생성의 no-store 계약 1개와 후속 등록 테스트 12개의 실패를 구현 전에 확인했다.
후속 실패에는 미구현 경로의 상태 assertion, 등록 fixture 준비, 저장 예외가 포함된다.
JDK 경로 오류는 도구 설정 실패로 구분했다. 이후 추가한 본문 제한·복원 검증은 처음부터
통과한 보강 테스트이며 RED로 집계하지 않는다. [작업 이력](WORK_LOG.md#등록-api-권한-경계) 참조.

첫 전체 Spring 프로세스 실행 중 빌드가 같은 JAR를 교체해 일부 시작이 실패했다.
완료된 JAR를 고정 경로에 복사해 전체 205개를 재실행해 통과했다. 실행 중 해당 파일은 변경하지 않았다.
검증 JAR의 SHA-256은 `627de9bae23b83c96ebfd6a38b360d330cfa810848a0d0a2b43ca0deaa78ba5e`다.

Java 21의 JAVA_HOME을 설정한 저장소 루트에서 순서대로 실행한다. E2E 종료 전 JAR를 재빌드하지 않는다.

```sh
backend/gradlew -p backend test bootJar
./scripts/test-spring.sh registration
./scripts/test-spring.sh protocol --exclude src/static-web.e2e.ts
pnpm --filter @ttyroom/e2e test:e2e src/http-api.e2e.ts
```

프로세스 E2E에는 빌드된 protocol·Connector가 필요하다. 최초 설치는 [개발 안내](DEVELOPMENT.md)를 따른다.
이번 로컬 검증에 브라우저·패키징된 정적 웹·v8 입장·취소 경합·운영 배포는 포함하지 않았다.
기존 v7 hello는 유지하며 이 결과를 사칭 차단 완료로 해석하지 않는다.

## 2026-09-29 credential 저장 T9.1

내부 발급·취소를 방별 명령 순서와 SQLite 저장에 연결했다. 변경 내용과 저장 버전은
[인증 설계의 T9.1 기록](AUTHENTICATION.md#발급취소의-저장과-복원)을 따른다.

- Java 전체 **380개 통과**, 실패·오류·skip 0. 새 저장 계약 19개와 기존 361개다.
- `test bootJar -PwebDist=../web/dist` 성공. 테스트 fixture 정리 후 전체 Java를 다시 실행했다.
- 새 JAR의 `admission.e2e.ts` 17개·`persistence.e2e.ts` 4개, 총 **21개 통과**.
- macOS·Java 21 환경. 기존 React 빌드 자산을 JAR에 포함했으며 웹 코드는 바꾸지 않았다.
- credential 저장 검증은 Java에서 실제 SQLite 파일을 닫고 새 Directory/저장소로 복원하는 방식이다.
  프로세스 E2E 21개는 기존 v7 입장·재시작 계약이며 credential 등록 API 검증이 아니다.
- Node·브라우저 전체·취소와 실제 입장의 경합은 이번 실행 범위가 아니다.

```sh
backend/gradlew -p backend test bootJar -PwebDist=../web/dist
./scripts/test-spring.sh protocol src/persistence.e2e.ts src/admission.e2e.ts
```

JAR 명령은 기존 `web/dist`가 있는 환경 기준이다. 처음에는 [제품 빌드 안내](DEVELOPMENT.md)를 따른다.
로컬 `artifacts/credential-persistence/`에 두 차례의 기능 RED/GREEN, 리뷰의 중복 digest 실패,
최종 Java·프로세스 로그, JAR SHA-256과 테스트 집계를 보관한다. 실패를 먼저 확인한 항목과
처음부터 통과한 보강 검증을 구분하며 당시 로그의 민감 값은 공개하지 않는다.

## 2026-09-29 대표 설계 설명 T8.3

작업 기준은 `1cc3018`이며 이번 변경은 문서에 한정된다. 설계 설명을 실제 코드와
대조하고 다음 기존 테스트를 재실행했다. 새로운 동작의 RED → GREEN이 아니다.

| 대상                      | 이번 실행 결과              | 범위                                      |
| ------------------------- | --------------------------- | ----------------------------------------- |
| Java RoomPersistenceTests | 35개 통과, 실패·오류·skip 0 | 저장 대기·실패·순서와 commit 후 전달 실패 |
| Node 프로세스 계약        | 2개 파일, 14개 통과         | terminal-recovery 10개 + persistence 4개  |
| Spring 프로세스 계약      | 같은 2개 파일, 14개 통과    | Node와 동일한 wire·프로세스 복원 계약     |

macOS에서 Java 21과 현재 pnpm 환경으로 실행했다. Java는 `--rerun-tasks`로 다시
컴파일·실행했고 Node 서버도 TypeScript를 다시 빌드했다. Spring 프로세스 검증에는
T8.2에서 빌드한 기존 JAR를 사용했다. 이후 운영 소스 변경은 없다. JAR SHA-256은
`41cef7df0eb9d4c8a6e69e437b994825d936a57ebf87ae89a6401b90dc56ba68`이다.

Java 21의 JAVA_HOME과 의존성 설치를 마친 저장소 루트에서 재현한다.
Spring JAR가 없거나 소스가 바뀌었다면 [웹 포함 빌드](DEVELOPMENT.md)를 먼저 실행한다.

```sh
backend/gradlew -p backend test --tests dev.ttyroom.application.RoomPersistenceTests --rerun-tasks
pnpm --filter @ttyroom/server exec tsc -p tsconfig.build.json
pnpm test:e2e src/terminal-recovery.e2e.ts src/persistence.e2e.ts
./scripts/test-spring.sh protocol src/terminal-recovery.e2e.ts src/persistence.e2e.ts
```

Node 빌드 전에 protocol 산출물이 필요하다. 최초 환경에서는
[개발 환경 안내](DEVELOPMENT.md)의 의존성 빌드를 먼저 따른다.
로컬 원본은 `artifacts/design-cases/`의 `java-persistence.log`, `node-contracts.log`,
`spring-contracts.log`에 보관한다. 변경 문서의 형식·상대 링크·참조한 테스트 이름도 확인했다.
브라우저 전체·실제 PTY resilience·Java 전체 테스트는 이번 단계에서 재실행하지 않았다.
그 범위는 아래 원격 CI와 앞선 시연 기록의 별도 근거다. 성능·운영·배포 검증은 아니다.

## GitHub Actions 검증 — ae395b2

[실행 36567089186](https://github.com/edonghyun/ttyroom/actions/runs/36567089186)은
소스 `ae395b2f86ded2ff101e3882556630d40a696c90`을 대상으로 하며 **6개 작업 모두 성공**했다.
2026-09-29 21:26 KST에 완료되었고, 아래 수치는 이 실행의 로그에서 다시 확인했다.
Ubuntu의 Java 21·Node 22 환경에서 실행했으며 아래 결과는 각 job 로그에서 확인했다.

| 작업                               | 확인한 결과                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| check                              | 타입·형식·의존성 검사, TypeScript 단위 544개 통과                                 |
| Spring backend — Java 21           | Gradle test 및 bootJar 성공, 7개 task 실행. Java 테스트 개수는 별도 집계하지 않음 |
| full                               | Connector·Node 통합 37개, Node 프로토콜 213개 통과                                |
| Browser — node                     | 정적 웹 계약 8개, Chromium 브라우저 38개 통과                                     |
| Browser — spring                   | 정적 웹 계약 8개, Chromium 브라우저 38개 통과                                     |
| Spring backend — process contracts | 정적 웹을 제외한 프로세스 계약 205개 통과                                         |

Node 프로토콜 213개에는 정적 웹 8개가 포함되며, browser job의 같은 8개와 합산해
서로 다른 테스트 수로 주장하지 않는다. 과거 macOS 검증과 이번 Linux CI도 별개의 실행이다.
셸은 테스트 전용 설정을 사용하므로 개인 셸 설정 호환성이나 공개 서비스 운영 검증은 아니다.
직전 소스 `8a5a0b8`의 [실행 36565833540](https://github.com/edonghyun/ttyroom/actions/runs/36565833540)도
6개 작업 모두 성공했다. 직전 실행의 원본 로컬 복사 로그는 `artifacts/sprint-planning/`에 보관하며,
최신 실행의 원본은 위 GitHub Actions 링크에서 확인할 수 있다.

### 이전 실패 알림과 수정 이력

| 실패 실행                                                                                | 확인한 원인                                                                                                                                | 적용된 수정                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`dd5001a` / 36564895875](https://github.com/edonghyun/ttyroom/actions/runs/36564895875) | 깨끗한 runner에서 protocol 산출물이 없어 typecheck와 양쪽 browser job의 web 빌드가 `TS2307: Cannot find module '@ttyroom/protocol'`로 실패 | [`3d3a90c`](https://github.com/edonghyun/ttyroom/commit/3d3a90cc1b22aca694b0e7cbfe3bfecbca63da3c): typecheck 전에 protocol 빌드, web 빌드에 workspace 의존성 포함     |
| [`3d3a90c` / 36565123232](https://github.com/edonghyun/ttyroom/actions/runs/36565123232) | 빌드는 통과했지만 Linux zsh 초기 설정·compinit 안내가 PTY 테스트 입력을 소비해 양쪽 browser job의 출력·종료 검증 실패                      | [`8a5a0b8`](https://github.com/edonghyun/ttyroom/commit/8a5a0b894ba47a4b740a2f07c3df9db0117cfdf1): browser fixture에 전용 `ZDOTDIR`, `.zshrc`, `GLOBAL_RCS` 해제 적용 |

위 두 실패는 수정 전 소스의 실행 기록이다. 이후 두 실행에서 같은 검증이 성공했으며,
기존 실패 알림은 최신 소스의 실패를 뜻하지 않는다. 실패 실행을 삭제하거나 알림을 끄지 않고
실패 원인과 수정 뒤 검증을 연결해 보존한다.

## 2026-09-29 공개 준비

첫 GitHub 실행에서 protocol 선행 빌드 누락을 발견해 CI 순서를 수정했다.
이후 Linux 브라우저 실행에서는 zsh 초기 설정 안내가 PTY 입력을 소비하는 실패를 확인했다.
브라우저 fixture에 전용 셸 설정을 추가했다. 각 실패와 후속 실행은 GitHub Actions 이력에 남긴다.

- 현재 작업 트리: TypeScript 단위 테스트 544개, 타입 검사, 의존성 경계 검사 통과.
- Java 361개 통과 결과를 확인했고 Gradle 재실행은 UP-TO-DATE였다. 이 공개 준비에서 361개를 새로 실행했다고 집계하지 않는다.
- 커밋 archive로 만든 산출물 없는 복사본: 첫 설치 후 기존 CLI 패키지 테스트 1개 실패를 재현했다.
- 소스에 포함되는 CLI 진입점으로 수정한 뒤 새 archive 복사본에서 frozen install → 전체 TypeScript 빌드 → 통합 테스트 37개 통과. bin 연결 경고도 사라졌다.
- macOS, Node 26.3.1, pnpm 10.10.0 및 기존 패키지 캐시를 사용했다. 새로운 OS에서의 실행은 아니다.
- 브라우저 전체 E2E는 아래의 이전 실행 기록과 구분한다. 원격 CI 결과는 저장소의 Actions에서 확인한다.

첫 설치 검증의 RED/GREEN 로그는 로컬 `artifacts/publish-cli-red.log`, `artifacts/publish-cli-green.log`에 보관한다.

## 2026-09-28 수명주기·실패 경계의 브라우저 검증

2026-09-28 로컬 Chromium 검증. 운영 코드 추가 변경 없이 현재 소스로 빌드했다.

## 빌드와 실행

- Connector TypeScript 빌드.
- web typecheck 및 Vite production 빌드.
- Spring bootJar에 현재 web/dist 포함.
- Node 기준 서버 TypeScript 빌드 및 동일한 web/dist 복사.
- Node, Spring 순서로 전체 Playwright 브라우저 테스트 실행.

## 결과

| 대상                            | 결과      | 원본 로그                   |
| ------------------------------- | --------- | --------------------------- |
| Node 서버 + 현재 web/Connector  | 38개 통과 | `browser-node.log` (로컬)   |
| Spring JAR + 현재 web/Connector | 38개 통과 | `browser-spring.log` (로컬) |
| 의존성 규칙                     | 위반 0개  | 실행 도구 출력 확인         |

협업 창 이동·크기·최소화, 제어권과 실제 PTY 입력/출력, 키보드 접근성,
참가자 재접속 출력 replay, gap 복구, 영속 서버 재시작 후 PTY 복원이 포함된다.

검증한 주요 소스와 Spring JAR의 SHA-256은
로컬 `verified-files.json`에 기록했다.
직전 단계의 Java 355개, web 175개, Connector 58개 단위 테스트는 이번 단계에서
다시 실행한 수치가 아니다. 이번에는 브라우저 E2E와 최신 빌드 통합을 검증했다.
프로토콜 E2E 전체, Safari, 모바일, 원격 CI, 배포 검증은 포함하지 않았다.

원본 로그와 빌드 식별 파일은 로컬 `artifacts/refactoring/lifecycle-verification/`에 보관하며 공개 저장소에는 포함하지 않는다. 공개 저장소에서는 현재 코드와 CI 실행 결과로 재검증할 수 있다. 위 수치는 2026-09-28 실행 기록이다.
