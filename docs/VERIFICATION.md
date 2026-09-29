# 검증 기록

## GitHub Actions 검증 — 8a5a0b8

[실행 36565833540](https://github.com/edonghyun/ttyroom/actions/runs/36565833540)은
소스 `8a5a0b894ba47a4b740a2f07c3df9db0117cfdf1`을 대상으로 하며 **6개 작업 모두 성공**했다.
Ubuntu의 Java 21·Node 22 환경에서 실행했으며 아래 결과는 각 job 로그에서 확인했다.

| 작업                               | 확인한 결과                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| check                              | 타입·형식·의존성 검사, TypeScript 단위 544개 통과                              |
| Spring backend — Java 21           | Gradle test 및 bootJar 성공. 이 로그만으로 Java 실행 개수를 새로 집계하지 않음 |
| full                               | Connector·Node 통합 37개, Node 프로토콜 213개 통과                             |
| Browser — node                     | 정적 웹 계약 8개, Chromium 브라우저 38개 통과                                  |
| Browser — spring                   | 정적 웹 계약 8개, Chromium 브라우저 38개 통과                                  |
| Spring backend — process contracts | 정적 웹을 제외한 프로세스 계약 205개 통과                                      |

Node 프로토콜 213개에는 정적 웹 8개가 포함되며, browser job의 같은 8개와 합산해
서로 다른 테스트 수로 주장하지 않는다. 과거 macOS 검증과 이번 Linux CI도 별개의 실행이다.
셸은 테스트 전용 설정을 사용하므로 개인 셸 설정 호환성이나 공개 서비스 운영 검증은 아니다.
원본 로컬 복사 로그는 `artifacts/sprint-planning/`에 보관한다.

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
