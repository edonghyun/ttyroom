# 검증 기록

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
