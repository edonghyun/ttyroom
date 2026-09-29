# 포트폴리오 준비: 실행 재현·계약 추적·명세 점검

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

## 실행 재현 범위

현재 작업 트리의 추적 파일과 ignore되지 않은 미추적 파일을 별도 임시 디렉터리에 복사했다.
삭제된 경로와 artifacts는 제외하고 node_modules, dist, backend/build, 프로젝트 .gradle 없이 시작했다.
아직 커밋하지 않은 변경이 많으므로 HEAD만 clone한 검증이 아니다.
같은 macOS의 Node/JDK, pnpm 패키지 저장소, 전역 Gradle·Chromium 캐시는 사용했다.
새 OS·네트워크 다운로드·Linux 설치까지 검증한 것으로 해석하지 않는다.

`pnpm install --frozen-lockfile` → `scripts/build-spring.sh --no-daemon` 순서로 실행했다.
빌드는 성공했다. 설치 로그에는 현재 Connector bin 대상 dist가 없다는 경고가 있었고,
빌드 후에도 `pnpm exec ttyroom`은 command not found로 실패했다.
빠른 시작과 시연 문서를 `node connector/dist/index.js join ...`으로 수정했다.
이 최초 점검에서는 패키지의 bin 연결 정책을 변경하지 않았다.
후속 공개 준비에서 `connector/bin/ttyroom.js`를 소스에 포함하고 bin 대상을 변경했다.
아래 수치는 최초 점검 기록이며, 후속 검증은 [검증 기록](VERIFICATION.md)을 참고한다.

원본 설치 로그 (로컬 `artifacts/portfolio-readiness/install.log`),
빌드 로그 (로컬 `artifacts/portfolio-readiness/build.log`),
기존 명령 실패 (로컬 `artifacts/portfolio-readiness/connector-before.log`),
복사 범위 (로컬 `artifacts/portfolio-readiness/clean-copy.json`)를 보관한다.

## 계약과 테스트

[CONTRACTS.md](CONTRACTS.md)에 저장 실패, 저장 대기와 실시간 경로, 알림 실패,
연결 교체, 입력 권한, 출력 replay, PTY 종료 순서, 화면 런타임 종료를 구현·테스트와 연결했다.
단위 테스트의 오류 주입과 프로세스 E2E의 외부 관찰을 구분했다.
대응표는 코드 경로 안내이며 표 작성만으로 모든 테스트를 실행한 것은 아니다.

## 명세 점검 결과

| 항목                  | 발견                                                      | 조치                                                              |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| shared 입력           | binary 설명이 모든 입력에 lease 필수인 것처럼 서술        | exclusive/shared 조건과 host 차단권을 구분해 수정                 |
| 입력 seq              | v2 설명만 있어 현재 동작 불명확                           | v7도 입력 중복 제거·자동 재시도 보장이 없음을 명시                |
| HTTP 요청             | 기본 성공 예시만 있고 길이 단위·본문 bytes·오류 설명 부족 | [HTTP.md](../protocol/HTTP.md)에 구현·공통 테스트 기반 계약 추가  |
| WebSocket 메시지 예시 | 모든 type/kind의 예시와 스키마 검증이 이미 존재           | 기존 drift 테스트 유지. 의미적 설명까지 자동 검증하는 것은 아님   |
| OpenAPI와 docs 사이트 | 아직 없음                                                 | 이번에는 정확한 기존 계약을 먼저 정리. 별도 UI/사이트 구축은 보류 |
| HTTP 장애 응답        | 저장 장애 등의 5xx 공통 응답 계약 미정                    | 미정으로 명시. 임의 오류 형식을 문서에 만들지 않음                |

문서는 구현을 설명하며 이번 작업에서 서버 정책이나 wire 형식을 바꾸지 않았다.

## 검증 결과

- 별도 복사본: Java 355개 통과, 실패·오류·skip 0개. 프로젝트 build 디렉터리 없이 실제 실행했다.
- 별도 복사본: HTTP·정적 웹 E2E 31개 통과, 로그 (로컬 `artifacts/portfolio-readiness/http-static.log`).
- 별도 복사본: 실제 Connector·PTY를 사용하는 Chromium 복구 E2E 5개 통과,
  로그 (로컬 `artifacts/portfolio-readiness/recovery-browser.log`).
- 별도 복사본: run-spring.sh로 시작한 서버의 health·웹 200, 방 생성 201 확인.
- 원래 작업 트리: 수정한 PROTOCOL.md의 예시 drift 검사를 포함한 protocol 테스트 95개 통과.

실행 환경은 Node 26.3.1, pnpm 10.10.0, Java 21이다.
집계 결과 (로컬 `artifacts/portfolio-readiness/results.json`)에 기록했다.
README 최소 지원 버전인 Node 22에서 이번 실행을 반복한 것은 아니다.
원격 CI, npm 공개 배포, 다른 OS에서의 재현은 이번 검증에 포함하지 않았다.
