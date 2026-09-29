# Terminal 제목·창 배치 계약 — P3p

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-22. [종료·resize 계약](2026-09-22-terminal-control-contract.md) 다음 단계로
rename-terminal과 update-terminal-geometry를 Spring에 이식했다. PTY 행/열 변경과 별개인
협업 화면의 제목·좌표·창 크기를 다룬다.

## 기존 Node 계약

근거는 `legacy/node-server/src/usecases/rename-terminal.ts`, `update-terminal-geometry.ts`,
`domain/terminal-workspace.ts`, `control-plane.ts`, `protocol/src/messages.ts`다.

| 조건                                  | 제목                     | 창 배치                           |
| ------------------------------------- | ------------------------ | --------------------------------- |
| 현재 참여자 + 존재하는 terminal       | 변경 후 terminal-renamed | 수락 후 terminal-geometry-changed |
| 같은 값                               | 알림 없음                | 요청마다 알림                     |
| 없는 terminal                         | 무응답, 변경 없음        | 무응답, 변경 없음                 |
| 생성 확인 전 / 종료 후 / host offline | 허용                     | 허용                              |
| 다른 참여자의 lease / 입력 차단       | 허용, 기존 lease 유지    | 허용, 기존 lease 유지             |
| host 역할 / hello 전 / 잘못된 필드    | bad-message              | bad-message                       |

알림은 요청자를 포함한 같은 방의 참여자에게만 전파한다. Connector에 PTY 명령을 보내지 않는다.
후속 Welcome snapshot은 변경한 값을 보여주며 lifecycle·runtime·mode·metadata·lease는 보존한다.
방 사이에 terminal ID가 같아도 서로의 상태를 변경하지 않는다.

title은 JavaScript trim과 같은 공백 제거 후 UTF-16 길이 **1..80**을 허용한다. Java의 trim/strip을
그대로 쓰면 NBSP/BOM 및 일부 제어문자에서 차이가 생긴다. adapter에 정확한 공백 집합을 명시하고
Node/Spring 공통 계약으로 비교했다. 이모지 40개는 UTF-16 80자로 수락하고 뒤에 한 글자를 더하면 거절한다.

geometry의 x/y는 **-65535..65535**, width/height는 **0 초과..65535**이며 유한한 소수를 허용한다.
필드 누락, 문자열, null, 무한대, 범위 초과는 거절한다. terminalId는 unsigned 32-bit다.

## 책임·리팩터링 리뷰

- TerminalWorkspace가 제목의 값 비교와 geometry 수락을 소유한다. 내부 Entry만 변경하고 외부로
  반환한 Terminal/Geometry는 불변 값으로 유지한다. 이전 snapshot도 변하지 않는다.
- RoomControl은 workspace를 노출하지 않고 의미 있는 두 동작을 제공한다. updateTerminalGeometry의
  반환값은 변경 여부가 아닌 **수락 여부**다. 같은 값도 알리는 기존 의미를 주석과 테스트로 고정했다.
- RoomSessions는 현재 세션/역할 확인, 같은 방 monitor 안의 변경과 알림 전달을 맡는다.
  mode/close/resize의 OPEN·host 연결 선행조건을 이 두 명령에 재사용하지 않는다.
- RoomProtocol이 정규화·wire 검증과 결과 인코딩을 소유한다. snapshot과 배치 이벤트에서 필요한
  geometry 직렬화를 하나로 모았다. 별도 서비스·정책 계층·잠금·이벤트 버스는 추가하지 않았다.
- 알림 송신의 예상된 PeerUnavailable은 해당 수신자만 정리한다. 확정한 상태와 lease를 보존하고
  다른 참여자에게 계속 알린다. 예상 밖 프로그래밍 예외는 숨기지 않는다.

변경 전 소스를 before/src에 보관해 이번 단계의 차이만 비교했다. 기존 Node는 변경하지 않았다.
JSON의 120과 120.0은 같은 수치 의미이므로 Java wire fixture 검증은 숫자 노드를 값으로 비교한다.
제품 직렬화를 테스트의 정수/실수 노드 구분에 맞춰 바꾸지 않았다.

## 검증

공통 `terminal-view.e2e.ts`는 준비 → 행동/완료 관찰 → 결과 assert 순서를 유지한다.
viewFixture는 Alice의 lease와 Bob의 연결, pending/open/exited/offline 상태를 준비하고 실패 시에도
소켓·서버를 정리한다. 무응답 확인은 동일 요청자 연결의 후속 invalid-lease 응답을 사용한다.
임의 sleep이나 입력 허용 상태를 바꾸는 완료 장치를 쓰지 않는다.

- 최초 Node 공통 계약 14개 통과. 기존 Spring JAR에서 같은 제목 요청의 무응답 계약이 실패함을 확인했다.
- Java **191개 통과** 및 bootJar 빌드 성공. lifecycle/runtime/metadata/mode/lease와 이전 snapshot 보존,
  오래된 세션 차단, 알림 실패 격리·예외 전파, host 명령 없음, uint32·소수 좌표와 wire fixture를 포함한다.
- E2E 타입 검사, 의존성 검사, 변경 Java 포맷 검사 통과.
- jdeps에서 domain → JDK, application → domain/JDK 경계를 확인했다.
- 실제 Spring 공통 계약 **154개 / 11개 파일 통과**, Node 전체 E2E **179개 / 14개 파일 통과**.
- 최종 fixture 준비 이벤트 검사를 보강한 뒤 해당 14개 계약을 Node/Spring에서 각각 다시 실행해 통과했다.

근거: `artifacts/migration-baseline/p3p-terminal-view/`의 before/src, main.diff, node-baseline.log,
java-red.log, gradle.log, java-results.json, java-contract.log, node-full.log, typecheck.log,
dependencies.log, jdeps.log, java-format.log, java-view-final.log, node-view-final.log. 최종 JAR 빌드 후 E2E를 실행하며 실행 중 덮어쓰지 않았다.

Spring의 영속 저장·재시작 복원, 참여자 focus/cursor, Java 계층 자동 검사와 전체 브라우저 동작 검증은
후속 범위다. Node가 기본 서버이며 전체 기능 동등성이나 화면에서의 드래그 검증을 완료로 주장하지 않는다.
