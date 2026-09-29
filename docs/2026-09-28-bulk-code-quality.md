# 코드·테스트 일괄 정리

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

기존 가이드의 후속 대상으로 남겼던 브라우저 협업 시나리오를 일괄 적용했다.
저장소 전역의 파일 목록·패턴 검색과 계층별 주요 경계 리뷰를 함께 수행했다.
314개 Java/TS/TSX 파일의 목록은 `artifacts/refactoring/bulk/inventory.json`에 있다.
이는 전체 파일의 자동 inventory이며, 모든 줄을 수작업으로 검증했다는 의미는 아니다.

## 적용과 유지 판단

| 범위                          | 적용 또는 유지한 이유                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 브라우저 협업 12개 → 17개     | 드래그/리사이즈, 메뉴 종류, 빈 화면/복사, close 취소/확인, 최소화/Overview를 독립 계약으로 분리. 나머지 시나리오도 중간 상태를 값으로 수집 |
| 브라우저 키보드·actor         | Tab·Escape 단계의 focus/style/control을 당시 snapshot으로 보존. identity 조회를 RoomPage 한곳에 배치. 복제 탭은 실패해도 finally에서 닫음  |
| 브라우저 layout               | WorkspaceLayoutPage가 pointer gesture·ghost·DOM geometry 관찰을 소유. 기대 delta·위치·중복 여부는 테스트가 검증                            |
| 프로토콜 control/input/mode   | unavailableTerminalStates가 명명된 초기 상태를 준비. 테스트 본문의 lifecycle switch를 제거하고 다른 기대 결과는 독립 사례로 분리           |
| 프로토콜 presence/persistence | focus 가능한 상태와 재접속 준비를 fixture가 소유. 일치 runtime 복구와 충돌 runtime 종료의 서로 다른 수신 순서를 별도 본문으로 표현         |
| Connector                     | RateLimiter의 시간별 결과를 복사해 수집한 뒤 마지막에 검증. clock·transport·PTY 수명이라는 기존 소유권은 유지                              |
| Java production               | RoomSessions 명령 dispatch의 중첩된 rename/geometry 변경을 의미 있는 작업으로 정리. 다른 command와 같은 읽기 수준으로 맞춤                 |
| Java 테스트                   | 중첩된 `anySatisfy/isInstanceOfSatisfying`을 `assertOpenedTerminal`로 명명. 기존 fixture·저장 gate·post-commit 검증은 유지                 |
| frontend production           | RoomAppRuntime / session / projection / window-manager / geometry의 기존 경계를 확인. 파일 길이만으로 callback·중간 계층을 추가하지 않음   |
| protocol / legacy Node        | 코덱의 정확한 바이트 배열과 기존 비교 구현을 유지. wire 테스트에서 필요한 raw 표현을 추상화로 숨기지 않음                                  |
| visual reference              | 화면 캡처 순서와 좌표 검증이 목적이므로 일반 protocol fixture로 통합하지 않음. 이번 수정/실행 범위에 포함하지 않음                         |

테스트 본문에 남은 단순 selector와 직접 domain 호출까지 모두 helper로 감싸지 않았다.
도메인의 한 작업이 상태·알림·저장을 함께 보장하는 경우는 하나의 계약으로 유지했다.
테스트 개수의 증가는 기존 관찰을 독립 사례로 나눈 결과다. 신규 기능 TDD 기록이 아니다.

## 중요한 관찰 보존

- drag/resize: 누른 동안 원래 terminal geometry 유지, ghost delta, 놓은 뒤 commit과 ghost 소멸.
- zoom/pan: 75% 크기, pan delta, 확대 상태에서의 drag 좌표, 100% 복귀.
- Overview: 모든 창 표시, 겹침 없음, 원래 inline geometry와 최소화 상태 복귀.
- peer rename/geometry: reload 전 live 전파와 reload 후 복원 모두 유지.
- focus: 다음 입력 전에 현재 focus/outline/제어권을 값으로 보관. 가변 객체 참조를 snapshot으로 사용하지 않음.
- 거절 입력: 원본 표식의 echo도 거절 위반으로 검출. 정상 출력의 echo 회피 규칙과 구별.
- protocol: 수신 순서·추가 알림·중복을 임의로 sort/deduplicate하지 않음. 종료와 offline의 예상 준비 이벤트도 확인.
- production: 저장 전에 commit하거나 post-commit 효과를 먼저 전송하지 않음. 기존 `change` 경계를 그대로 사용.

## 시간 기반 검사의 예외

cursor motion은 500ms 애니메이션 관찰 구간에 24개 pointer 입력을 12ms 간격으로 보낸다.
완료를 추정하기 위한 sleep이 아니라 움직임 자체가 입력이다. 원본 transform 표본을 반환하고
서로 다른 위치 개수라는 기존 지표를 검사한다.

복제 탭의 1.2초 대기는 기존 reconnect contention 관찰 구간이다. 이후 실제 PTY 출력까지 확인한다.
이 관찰이 앞으로 영원히 reconnect가 없다는 보장은 아니다. 이 둘을 없애서 테스트를 짧게 하지는 않았다.

## 검증

동작 보존 GREEN → REFACTOR → GREEN. 변경 전 소스와 실행 로그는
`artifacts/refactoring/bulk/`에 보존한다. 실행 결과는 해당 폴더의 README에 기록한다.

- Java 전체와 web 포함 bootJar: production 변경 반영.
- TypeScript 전체 unit/typecheck 및 dependency-cruiser.
- 실제 PTY·프로세스 통합 테스트.
- Node/Spring 각각 Chromium 브라우저 전체.
- Node/Spring 각각 프로토콜 E2E 전체.
- 변경한 소스의 Prettier/google-java-format 및 diff whitespace 검사.

visual reference 스크린샷, Safari/mobile, 원격 CI/배포 상태는 이번 통과 범위가 아니다.

## 전체 검증에서 발견한 단절 장치 문제

첫 Spring 브라우저 실행은 37개 통과, 복구 1개 timeout이었다. offline 이후 native WebSocket에
정상 close를 요청하는 기존 장치가 `Reconnecting` 전환에 도달하지 못했고 CLOSING 상태의 전송
오류도 기록됐다. 실패 screenshot/trace를 `spring-browser-first-failure`에 보존했다.

전역 WebSocket 생성자 교체와 offline 오류 허용을 제거하고, 복구 테스트에만 실제 서버로
연결하는 `ConnectionFault` route를 설치한다. 단절 시 browser/server 양 끝을 닫고, 복원 전의
연결은 차단한다. 공유 모드도 양쪽에서 준비된 뒤 단절을 시작한다. OS 네트워크 partition 전체를
재현했다고 주장하지 않는다. 제품의 전송 코드를 고친 것으로도 기록하지 않는다.

단절 시나리오 5회 반복 통과 후 Node/Spring 전체 브라우저 각각 38개가 통과했다. 최초 실패를 지우거나
불필요한 console 오류를 추가로 무시하지 않는다.

최종 검증 결과: Java 353, TS 단위 540, native 통합 37, Node/Spring protocol 각 213,
Node/Spring Chromium 각 38 통과. 전체 타입·의존성 및 변경 파일 포맷 검사도 통과했다.
실제 적용한 source/test 21개 파일의 hash는 artifact의 `verified-source-hashes.json`에 있다.
