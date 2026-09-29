# TTYRoom 백엔드 리팩터링 로드맵

> 상태: 진행 중  
> 기준 브랜치: `main`  
> 작성일: 2026-08-14

## 목표

TTYRoom 백엔드를 패턴의 전시장으로 만드는 것이 아니라, 다음 변경을 더 적은 개념으로 안전하게
수용하는 구조로 만든다.

- Room 단위 명령 순서와 불변식이 한곳에서 보인다.
- 제어 메시지와 고빈도 터미널 데이터의 처리 경계가 분명하다.
- 도메인 모델이 WebSocket, JSON, SQLite, 화면 DTO에 의해 결정되지 않는다.
- 저장 성공, 메시지 전송, 재접속 복구의 실패 의미가 명시적이다.
- 단일 프로세스 MVP의 단순함을 유지하면서 다중 인스턴스 전환 지점을 숨긴다.

## 현재 판단

현재 구조는 이미 `domain / usecases / ports / adapters`와 계약 테스트를 갖추고 있다. 따라서
전면 재작성이나 프레임워크 교체보다 경계가 어긋난 부분을 작은 세로 슬라이스로 바로잡는 편이
안전하다.

좋은 기반:

- `Room`이 Lease, Terminal lifecycle, Host recovery의 핵심 불변식을 소유한다.
- SQLite 저장은 먼저 성공한 뒤 메모리 상태를 commit한다.
- WebSocket Transport와 SQLite Repository가 포트 뒤에 있다.
- control JSON과 terminal binary frame이 프로토콜 수준에서 분리돼 있다.
- output source sequence, replay, snapshot이 재접속 복구 계약을 이룬다.

착수 시 마찰:

- 일부 Room 변경은 `RoomRegistry.change()`를 거치고 일부는 `Room`을 직접 변경해, 비동기 저장과
  live 상태 변경이 같은 aggregate 안에서 교차할 수 있었다.
- `RoomRegistry`는 이름과 위치상 domain collection처럼 보이지만 실제로는 identity map,
  per-room serialization, persistence transaction, lifecycle을 함께 소유한다.
- `Room`이 `@ttyroom/protocol`의 `RoomSnapshot`, `TerminalView`를 직접 사용해 내부 모델과 published
  language가 결합돼 있다.
- `ServerCore`가 composition과 parsing, session guard, role authorization, message routing을 함께
  맡는다.
- 메시지 하나당 클래스 하나가 많아졌지만, 몇몇 클래스는 의존성을 전달하고 event DTO를 만드는
  정도라 호출자가 알아야 할 이름 수를 늘린다.
- use case가 domain decision을 protocol event로 반복 변환하고 직접 broadcast해, 상태 변경과 외부
  알림의 계약이 여러 파일에 흩어져 있다.

## 목표 구조

```text
WebSocket adapter
  -> Inbound endpoint
     -> control message router ---------> Room command application service
     -> binary data router              -> Terminal data relay
                                             |
                                      Room transaction boundary
                                             |
                                         Room aggregate
                                             |
                                      domain outcomes/events
                                             |
                                  protocol mapper + broadcaster
```

### Domain

`Room`은 aggregate root로 유지한다. Host, Terminal, Participant, Lease의 외부 객체 그래프를
노출하지 않고, 필요해질 때 내부 deep module로 분리한다.

- Entity: `Room`, `Host`, `Terminal`, `Participant`
- Value Object 후보: `RoomId`, `TerminalId`, `LeaseId`, `TerminalGeometry`
- Policy: lease acquisition, input authorization, host reconciliation
- Domain outcome: 예상 가능한 거절과 변경 결과
- Domain event: `LeaseGranted`, `TerminalOpened`처럼 의미 있는 과거형 사실만 사용

ID마다 wrapper class를 먼저 만들지는 않는다. 서로 바뀌면 위험하거나 별도 검증 규칙이 생기는
식별자부터 승격한다.

### Application

Application layer는 한 Room에 대한 command 순서, 저장, side effect 순서를 소유한다.

- Room 변경은 단 하나의 transaction boundary를 통과한다.
- 변경 전후 durable record가 다를 때만 repository에 저장한다.
- 저장이 필요한 명령은 `save -> in-memory commit -> outward event/effect` 순서를 지킨다.
- 저장 후 broadcast 전에 죽는 경우는 다음 snapshot/reconciliation이 복구한다. 이 의미를 테스트로
  유지한다.
- binary input/output relay는 control transaction queue에 넣지 않는다.

작은 use-case 클래스를 모두 유지하는 것이 목표가 아니다. Lease control, Terminal lifecycle,
Presence처럼 함께 이해되는 capability 단위의 깊은 application service로 합칠 수 있다. 단, 합치기
전에 현재 public behavior test를 유지한다.

### Ports and adapters

포트는 실제 교체 가능성과 실패 의미가 있는 경계에만 둔다.

- 유지: `RoomRepository`, `Identity`, `Clock`, `Connection/Transport`
- 계약 테스트 유지: Transport ordering/backpressure, Repository failure/close
- 만들지 않음: 모든 domain class에 대한 repository, 모든 함수에 대한 interface, pass-through facade

`StoredRoomRecord`는 장기적으로 persistence contract로 이동시키고, adapter가 domain state와
변환한다. Schema version migration도 이 경계가 소유한다.

## EIP와 메시징 적용 기준

### 지금 적용

| 패턴                | TTYRoom에서의 역할                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Message Channel     | control JSON과 terminal binary data를 별도 채널 의미로 유지                                 |
| Message Router      | parse된 message를 role과 type에 따라 exhaustive dispatch                                    |
| Command Message     | client 요청을 application command로 번역                                                    |
| Event Message       | domain outcome을 `room-event` published language로 번역                                     |
| Idempotent Receiver | output source seq, terminal confirmation, 재접속 명령의 중복 도착 흡수                      |
| Wire Tap            | message type, roomId, latency, rejection reason만 기록하고 terminal payload는 기록하지 않음 |

### 조건부 적용

- Correlation Identifier: request/response 추적이 필요한 terminal open/close부터 도입한다.
- Resequencer: WebSocket ordering 밖에서 실제 out-of-order 전달이 관측될 때만 도입한다.
- Retry: idempotency key와 실패 분류가 있는 외부 side effect에만 적용한다.
- Circuit Breaker: 프로세스 밖의 의존성이 생긴 뒤 적용한다.

### 지금 도입하지 않음

- 내부 generic event bus: 호출 흐름과 타입을 숨기지만 현재 복잡성을 줄이지 않는다.
- Outbox/Inbox: 현재는 단일 프로세스와 transient browser broadcast다. 다중 인스턴스나 외부
  durable consumer가 생길 때 저장 transaction과 함께 도입한다.
- Kafka/NATS/Redis Streams: broker가 해결해야 할 독립 소비자, durable delivery, horizontal
  ownership 문제가 생기기 전에는 운영 복잡성이 더 크다.
- CQRS/Event Sourcing: 현재 snapshot + SQLite record 모델의 요구를 넘어선다.

## SOLID 적용 해석

- SRP: 파일 하나당 클래스 하나가 아니라, 하나의 변경 이유와 지식 소유자를 만든다.
- OCP: 메시지 타입 추가가 router와 한 capability에 국소화되게 하되, registry framework를 만들지
  않는다.
- LSP: 교체 가능한 port adapter는 동일 contract suite를 통과해야 한다.
- ISP: 호출자가 쓰지 않는 저장/전송 기능을 보지 않게 하지만, 한 메서드 interface를 양산하지 않는다.
- DIP: domain은 protocol DTO, SQLite, WebSocket을 모르며 application이 translation을 소유한다.

## 단계별 실행

### 1. Room mutation boundary 통합 — 완료

- `RoomRegistry.change()`가 live/durable 변경을 모두 직렬화한다.
- 변경 전후 durable record가 같으면 SQLite save를 건너뛴다.
- Participant, Lease, focus, Host input state, disconnect mutation의 직접 변경을 제거한다.
- inventory 저장과 Kill Switch 보고가 겹치는 회귀 테스트를 추가한다.

완료 조건:

- Room 상태를 변경하는 production use case에 직접 mutator 호출이 없다.
- live-only 변경은 repository write를 만들지 않는다.
- 같은 Room의 control command 결과가 도착 순서와 일치한다.

### 2. Application transaction의 이름과 위치 정리 — 완료

- `RoomRegistry`와 계약 테스트를 `domain`에서 `usecases`로 이동했다.
- 이름은 `RoomRegistry`로 유지한다. live aggregate identity map과 lifecycle이 public 의미이고,
  per-room mailbox와 persistence transaction은 `change()` 뒤에 숨기는 구현 세부이기 때문이다.
- domain package가 ports를 import하지 않게 만들었다.

완료 조건:

- domain import graph가 protocol type과 Node infrastructure를 제외한 순수 모델 방향으로 수렴한다.
- 저장 실패와 close 중 명령 거절 계약이 application test에 있다.

### 3. Control router와 composition 분리 — 완료

- `ServerCore`는 Transport facade, binary data fast path, disconnect lifecycle만 소유한다.
- `ControlPlane`이 control use-case topology, parsing, session guard, role authorization을 숨긴다.
- `hello`, participant command, host command를 role-scoped exhaustive switch로 분리했다.
- `Session`을 `ParticipantSession | HostSession` discriminated union으로 바꿔 잘못된 role의 use case
  호출을 컴파일 단계에서 차단했다.
- role mismatch는 공통 unsupported error 계약으로 처리하며 characterization test를 추가했다.
- binary input/output relay는 control router 밖의 별도 fast path로 유지했다.

완료 조건:

- 새 control message 추가 시 수정 지점이 router 한 곳과 capability 한 곳으로 제한된다.
- role mismatch와 unauthenticated message의 공통 오류 계약이 중복되지 않는다.

### 4. Domain outcome과 protocol event 분리 — 완료

- `Room`이 `RoomState`, `TerminalState`, `HostState`, `Lease` 등 local domain type을 소유하며
  `@ttyroom/protocol`을 import하지 않게 했다.
- `room-protocol` mapper가 domain state를 wire snapshot/view로 명시적으로 복사한다.
- `RoomEventPublisher`가 application `RoomChange`를 protocol `RoomEvent`로 exhaustive하게 변환한다.
- production use case의 직접 `room-event` envelope 조립을 제거하고 command 성공 이후 publisher 한
  곳에서 broadcast한다.
- SQLite record schema를 protocol schema에서 분리해 SQLite adapter와 schema version이 소유하게
  했다.

완료 조건:

- domain test가 `@ttyroom/protocol` 없이 핵심 불변식을 검증한다.
- use case 안의 반복적인 `room-event` 조립 코드가 capability mapper로 모인다.

### 5. Room 내부 deep module 정리 — 완료

`Room`의 공개 명령과 aggregate 경계는 유지하면서 상태와 규칙의 지식 소유자를 내부 모듈로
분리했다.

- `LeaseControl`이 acquire/release, 재도착 멱등성, 1인 1 lease, lease id 발급을 소유한다.
- `TerminalWorkspace`가 Host/Terminal lifecycle, runtime mapping, metadata, geometry, inventory
  reconciliation과 durable workspace projection을 소유한다.
- `Presence`가 participant lifecycle과 focus를 소유한다.
- 각 모듈이 staged state capture/restore/change merge를 직접 소유해, 저장 대기 중 생긴 관련 없는
  live 변경을 commit이 덮어쓰지 않는다.
- `Room`은 participant 제거 시 lease 회수, Host 제거 시 terminal lease 폐기, terminal mode에 따른
  입력 권한처럼 모듈을 가로지르는 불변식만 조정한다.

세 내부 모듈은 package public API로 노출하지 않으며 application caller는 계속 `Room`의 의도 기반
operation만 호출한다.

완료 조건:

- `Room` public operation은 사용자 의도를 표현한다.
- 내부 모듈 추출 뒤에도 aggregate 간 호출 순서나 mutable collection이 노출되지 않는다.

### 6. 관측성과 분산 전환 조건 — 완료

- `OperationalDiagnostics`가 control command와 repository operation의 결과·지연을 monotonic time으로
  계측한다. diagnostics sink 장애는 control/data path로 전파하지 않는다.
- terminal input은 connection/room/terminal 식별자, byte 수, 처리 결과, 정규화된 거절 사유만
  계측하고 payload, lease/token, shell content는 이벤트 모델에 넣지 않는다.
- 느린 참여자의 output gap은 최초 drop의 `opened`와 전송 재개의 `recovered` 두 상태 전환으로
  집계한다. frame마다 로그를 만들지 않고 from/to seq, drop frame 수, buffered byte만 남긴다.
- CLI는 JSON Lines telemetry를 stderr로 출력한다. 성공한 terminal input과 cursor 이동은 고빈도
  로그 폭주를 피하기 위해 기본 JSON sink에서 제외하며 거절·실패는 유지한다.
- control JSON 원문, parser reason 외의 동적 오류 메시지, terminal payload는 구조화 이벤트에 넣지
  않는다.
- 다중 서버가 필요해지면 Room ownership, broker delivery, outbox/inbox, distributed lease를 별도 ADR로
  결정한다. 현재 구현에는 broker나 generic internal event bus를 추가하지 않는다.

완료 조건:

- control, persistence, terminal input rejection, replay gap의 운영 이벤트 계약이 테스트로 고정된다.
- telemetry 실패가 사용자 요청 실패를 만들지 않는다.
- 기본 운영 로그가 token·terminal content를 포함하지 않고 고빈도 성공 경로에서 무한히 증가하지
  않는다.

## 검증 순서

각 단계는 다음 순서로 끝낸다.

1. 현재 behavior 또는 실패 race를 재현하는 test 추가
2. 최소 구조 변경
3. targeted test
4. server unit + integration test
5. dependency-cruiser + typecheck
6. 전체 workspace test와 e2e 중 영향 범위 실행

리팩터링 patch에는 protocol behavior 변경을 섞지 않는다. 메시지 스키마나 실패 의미가 바뀌면 별도
feature/migration patch로 분리한다.
