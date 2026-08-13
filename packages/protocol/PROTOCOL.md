# TTYRoom Wire Protocol

언어 중립 명세. TypeScript 구현(`src/messages.ts`의 zod 스키마, `src/data-frame.ts`의 코덱)이
이 문서와 동기되어야 하며, 골든 테스트가 드리프트를 잡는다. 레이아웃·형태 변경은
프로토콜 버전 범프와 이 문서의 갱신을 요구한다.

## 버전과 협상

- 현재 버전: `PROTOCOL_VERSION = 7`. 버전은 1 이상의 정수만 유효하다 (0·음수는 hello 파싱 단계에서 거부).
- v7은 참가자의 canvas cursor 좌표를 Room 안의 다른 참가자에게만 일시 중계하는
  `move-cursor` / `participant-cursor` 메시지를 추가한다. cursor는 Room snapshot에 저장하지 않는다.
- v6는 서버 재시작 뒤 살아 있는 PTY를 복구하는 Host inventory·ready·output replay handshake와
  PTY 수명 `runtimeId`를 추가했다.
- v5는 Room이 소유하는 terminal title을 request·event에 추가했다.
  구형 서버가 `rename-terminal`을 `bad-message`로 거부하므로 협상 버전을 올렸다.
- v4는 Room이 소유하는 terminal geometry를 snapshot·request·event에 추가했다.
  구형 서버가 `update-terminal-geometry`를 `bad-message`로 거부하므로 협상 버전을 올렸다.
- 새 reader는 구형 persisted v1
  `RoomSnapshot.name` 누락을 `"Quick Room"`, `HostView.remoteInputAllowed` 누락을 `true`,
  `ParticipantView.focusedTerminalId` 누락을 `null`, `TerminalView.geometry` 누락을
  `{"x":24,"y":24,"width":640,"height":420}`로
  정규화하고, 구형 reader는 zod object의 알 수 없는 필드 제거 규칙으로 새 필드를 무시한다.
- 클라이언트(참여자·호스트)는 연결 후 첫 메시지 `hello`에 `protocolVersion`을 싣는다.
- 서버가 수용하지 못하는 버전이면 `error { code: "unsupported-protocol-version" }`를 보내고
  연결을 종료한다. 클라이언트는 업그레이드 안내를 표시한다
  (npx 배포 특성상 버전 스큐가 실제로 발생한다).

## 전송 모델

클라이언트당 WebSocket 연결 하나에 두 종류의 프레임을 멀티플렉싱한다.

- **제어 프레임** — WebSocket text 프레임. JSON 하나가 메시지 하나.
- **데이터 프레임** — WebSocket binary 프레임. 아래 바이너리 레이아웃.

서버는 데이터 프레임의 헤더만 읽고 payload는 불투명하게 라우팅·저장한다
(해석 금지, 불투명 저장 허용 — E2E 암호화를 얹어도 서버는 무변경).

## 데이터 프레임 (바이너리)

모든 정수는 unsigned 32-bit big-endian (u32BE). frameType은 1바이트.

출력 (Agent → 서버 → 브라우저):

| 오프셋 | 크기 | 필드       | 값            |
| ------ | ---- | ---------- | ------------- |
| 0      | 1    | frameType  | `0x01`        |
| 1      | 4    | terminalId | u32BE         |
| 5      | 4    | seq        | u32BE         |
| 9      | n    | payload    | 불투명 바이트 |

입력 (브라우저 → 서버 → Agent):

| 오프셋 | 크기 | 필드       | 값            |
| ------ | ---- | ---------- | ------------- |
| 0      | 1    | frameType  | `0x02`        |
| 1      | 4    | terminalId | u32BE         |
| 5      | 4    | seq        | u32BE         |
| 9      | 4    | leaseId    | u32BE         |
| 13     | n    | payload    | 불투명 바이트 |

- 입력 프레임은 반드시 발신자가 현재 보유한 `leaseId`를 지참한다. 서버는 터미널의
  유효 임대와 대조해 불일치 시 프레임을 폐기하고 발신자에게 `lease-invalid`를 보낸다.
- 입력 프레임의 `seq`는 발신자가 터미널별로 증가시키는 카운터다. v2에서 수신 측
  (서버·Agent)은 입력 `seq`를 해석하지 않는다 — 향후 확장을 위한 예약 필드.
- 헤더보다 짧은 프레임, 알 수 없는 frameType은 malformed로 취급하고 연결을 죽이지 않는다.

## 식별자

`terminalId` / `leaseId`는 u32 숫자(Room 단위 증가 카운터). `seq`는 u32 숫자(터미널 단위 증가 카운터).
`roomId` / `hostId` / `clientId`는 문자열.
터미널 치수 `cols` / `rows`는 1..65535 (u16 범위 — pty가 u16으로 받는다).

## 연결 수명

```text
연결 수립 → hello (클라이언트 첫 메시지)
  ├─ 거부: error{code} 후 서버가 연결 종료
  └─ 수락: welcome{selfClientId, snapshot} → 이후 이벤트 스트림 (room-event 등)
```

- 재접속은 **새 연결 + 동일 clientId의 hello**다. 전송 계층은 재연결을 숨기지 않는다.
- 서버는 재접속자에게 현재 Room 스냅샷과 터미널별 스크롤백 replay를 제공한다.
- Host는 `welcome` 직후 살아 있는 PTY와 로컬 출력 범위를 `host-inventory`로 보고한다.
  서버는 저장된 `runtimeId`와 일치하는 PTY만 활성화하고 `host-ready.replayAfterSeq`를 응답한다.
  Agent는 그 이후 출력만 재전송한 뒤 `terminal-replay-complete`를 보낸다. 이 handshake가
  끝나기 전에는 원격 입력을 받지 않는다. 충돌하거나 이미 종료된 terminalId는 서버가
  `close-terminal`로 정리해 로컬 고아 PTY를 남기지 않는다.

## seq · sync 의미론

- 터미널별 출력 `seq`는 단조 증가한다. 브라우저는 seq로 유실을 감지한다.
- `sync { terminalId, seq }` — "터미널 t의 seq n까지 방송 완료". 백프레셔 회복 시
  재동기화 지점이자 테스트의 명시적 동기화 지점.
- `output-gap { terminalId, fromSeq, toSeq }` — 느린 참여자에게 드롭된 출력 구간의 통지.
  수신자는 해당 터미널 렌더링을 복원 상태로 전환하고 `resync-output-request`를 보낸다.
- `resync-output-request { terminalId }`의 응답은 요청한 터미널의 현재 retained scrollback
  출력 프레임 전부(오래된 순서부터)와 마지막 `sync`다. 다른 터미널 출력은 replay하지 않는다.
  클라이언트는 요청 시 해당 터미널 표시 버퍼를 비우고 replay를 대체 상태로 적용한다.

## 제어 메시지

### 클라이언트(참여자·호스트 공통) → 서버

| type    | 예시                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------- |
| `hello` | `{"type":"hello","protocolVersion":7,"roomId":"r1","token":"t","clientId":"c1","name":"동현","role":"participant"}` |

`role`은 `"participant"` 또는 `"host"`. 호스트의 `clientId`는 `hostId`로도 쓰인다.

### 참여자 → 서버

| type                       | 예시                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `open-terminal-request`    | `{"type":"open-terminal-request","hostId":"h1"}`                                                          |
| `close-terminal-request`   | `{"type":"close-terminal-request","terminalId":3}`                                                        |
| `set-terminal-mode`        | `{"type":"set-terminal-mode","terminalId":3,"mode":"shared"}`                                             |
| `resync-output-request`    | `{"type":"resync-output-request","terminalId":3}`                                                         |
| `focus-terminal`           | `{"type":"focus-terminal","terminalId":3}`                                                                |
| `move-cursor`              | `{"type":"move-cursor","position":{"x":120.5,"y":80}}`                                                    |
| `rename-terminal`          | `{"type":"rename-terminal","terminalId":3,"title":"API logs"}`                                            |
| `acquire-lease`            | `{"type":"acquire-lease","terminalId":3}`                                                                 |
| `release-lease`            | `{"type":"release-lease","terminalId":3,"leaseId":7}`                                                     |
| `resize-request`           | `{"type":"resize-request","terminalId":3,"cols":120,"rows":40}`                                           |
| `update-terminal-geometry` | `{"type":"update-terminal-geometry","terminalId":3,"geometry":{"x":120,"y":80,"width":720,"height":480}}` |

### 호스트 → 서버

| type                       | 예시                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `terminal-opened`          | `{"type":"terminal-opened","terminalId":3,"runtimeId":"runtime-3"}`                                                       |
| `terminal-closed`          | `{"type":"terminal-closed","terminalId":3,"exitCode":0}`                                                                  |
| `terminal-meta`            | `{"type":"terminal-meta","terminalId":3,"meta":{"cwd":"/home/kep","gitBranch":"main","fgProcess":"vim"}}`                 |
| `host-input-state`         | `{"type":"host-input-state","remoteInputAllowed":false}`                                                                  |
| `host-inventory`           | `{"type":"host-inventory","terminals":[{"terminalId":3,"runtimeId":"runtime-3","firstRetainedSeq":4,"lastOutputSeq":9}]}` |
| `terminal-replay-complete` | `{"type":"terminal-replay-complete","terminalId":3,"lastOutputSeq":9}`                                                    |

### 서버 → 클라이언트

| type                        | 예시                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `welcome`                   | `{"type":"welcome","selfClientId":"c1","snapshot":{"roomId":"r1","name":"Payment Debug","participants":[],"hosts":[],"terminals":[],"leases":[]}}` |
| `room-event`                | `{"type":"room-event","event":{"kind":"participant-joined","participant":{"clientId":"c2","name":"민수"}}}`                                        |
| `participant-cursor`        | `{"type":"participant-cursor","clientId":"c2","position":{"x":120.5,"y":80}}`                                                                      |
| `lease-result`              | `{"type":"lease-result","terminalId":3,"result":{"kind":"granted","leaseId":7}}`                                                                   |
| `lease-invalid`             | `{"type":"lease-invalid","terminalId":3,"reason":"remote-input-disabled"}`                                                                         |
| `terminal-request-rejected` | `{"type":"terminal-request-rejected","request":"close","terminalId":3,"reason":"host-offline"}`                                                    |
| `sync`                      | `{"type":"sync","terminalId":3,"seq":10}`                                                                                                          |
| `output-gap`                | `{"type":"output-gap","terminalId":3,"fromSeq":11,"toSeq":42}`                                                                                     |
| `error`                     | `{"type":"error","code":"invalid-token","message":"token mismatch"}`                                                                               |

`lease-result.result`는 `{"kind":"granted","leaseId":n}` 또는
`{"kind":"denied","holderClientId":"..."}`.
`lease-invalid.reason`은 `not-holder` · `terminal-closed` · `remote-input-disabled`.
`terminal-request-rejected.request`는 `close` · `set-mode` · `resync-output`, `reason`은
`terminal-not-found` · `terminal-not-open` · `host-offline`이다.
`error.code`는 `room-not-found` · `invalid-token` · `unsupported-protocol-version` · `bad-message`.

### 서버 → 호스트

| type             | 예시                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `open-terminal`  | `{"type":"open-terminal","terminalId":3,"cols":80,"rows":24}`             |
| `close-terminal` | `{"type":"close-terminal","terminalId":3}`                                |
| `resize`         | `{"type":"resize","terminalId":3,"cols":120,"rows":40}`                   |
| `host-ready`     | `{"type":"host-ready","terminals":[{"terminalId":3,"replayAfterSeq":5}]}` |

### room-event의 event 종류

`room-event.event`에 실리는 형태. `kind`가 판별자다.

| kind                        | 예시                                                                                                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `participant-joined`        | `{"kind":"participant-joined","participant":{"clientId":"c2","name":"민수"}}`                                                                                                                                                                                  |
| `participant-left`          | `{"kind":"participant-left","clientId":"c2"}`                                                                                                                                                                                                                  |
| `participant-focus-changed` | `{"kind":"participant-focus-changed","clientId":"c2","focusedTerminalId":3}`                                                                                                                                                                                   |
| `host-connected`            | `{"kind":"host-connected","host":{"hostId":"h1","name":"dev-server","online":true,"remoteInputAllowed":true}}`                                                                                                                                                 |
| `host-offline`              | `{"kind":"host-offline","hostId":"h1"}`                                                                                                                                                                                                                        |
| `host-removed`              | `{"kind":"host-removed","hostId":"h1"}`                                                                                                                                                                                                                        |
| `host-input-state-changed`  | `{"kind":"host-input-state-changed","hostId":"h1","remoteInputAllowed":false}`                                                                                                                                                                                 |
| `terminal-opened`           | `{"kind":"terminal-opened","terminal":{"terminalId":3,"hostId":"h1","title":"term-3","geometry":{"x":88,"y":88,"width":640,"height":420},"mode":"exclusive","status":"open","exitCode":null,"meta":{"cwd":"/home/kep","gitBranch":"main","fgProcess":"vim"}}}` |
| `terminal-mode-changed`     | `{"kind":"terminal-mode-changed","terminalId":3,"mode":"shared"}`                                                                                                                                                                                              |
| `terminal-geometry-changed` | `{"kind":"terminal-geometry-changed","terminalId":3,"geometry":{"x":120,"y":80,"width":720,"height":480}}`                                                                                                                                                     |
| `terminal-renamed`          | `{"kind":"terminal-renamed","terminalId":3,"title":"API logs"}`                                                                                                                                                                                                |
| `terminal-closed`           | `{"kind":"terminal-closed","terminalId":3,"exitCode":0}`                                                                                                                                                                                                       |
| `lease-granted`             | `{"kind":"lease-granted","lease":{"terminalId":3,"leaseId":7,"holderClientId":"c1"}}`                                                                                                                                                                          |
| `lease-released`            | `{"kind":"lease-released","terminalId":3}`                                                                                                                                                                                                                     |
| `terminal-meta`             | `{"kind":"terminal-meta","terminalId":3,"meta":{"cwd":"/home/kep","gitBranch":null,"fgProcess":null}}`                                                                                                                                                         |

## 뷰 타입 형태

RoomSnapshot과 room-event가 공유하는 객체 형태. 표기 `A | null`은 JSON null 허용.

- **ParticipantView** — `clientId`: string, `name`: string,
  `focusedTerminalId`: u32 | null (구형 payload 기본값 `null`)
- **HostView** — `hostId`: string, `name`: string, `online`: boolean,
  `remoteInputAllowed`: boolean (구형 v1 payload 기본값 `true`)
- **TerminalMeta** — `cwd`: string | null, `gitBranch`: string | null, `fgProcess`: string | null
- **TerminalGeometry** — `x`: -65535..65535, `y`: -65535..65535,
  `width`: 0보다 크고 65535 이하, `height`: 0보다 크고 65535 이하. 모두 유한 number.
- **TerminalView** — `terminalId`: u32, `hostId`: string, `title`: trim 후 1..80자 string,
  `geometry`: TerminalGeometry (구형 payload 기본값 `{"x":24,"y":24,"width":640,"height":420}`),
  `mode`: `"exclusive"` | `"shared"`, `status`: `"open"` | `"exited"`,
  `exitCode`: int | null, `meta`: TerminalMeta
- **LeaseView** — `terminalId`: u32, `leaseId`: u32, `holderClientId`: string
- **RoomSnapshot** — `roomId`: string, `name`: string (구형 v1 payload 기본값 `"Quick Room"`),
  `participants`: ParticipantView[], `hosts`: HostView[],
  `terminals`: TerminalView[], `leases`: LeaseView[]

## Web prerequisite 동작 계약

Room bootstrap HTTP 계약:

- `POST /api/rooms`는 JSON body `{"name":"Payment Debug"}`를 선택적으로 받는다.
  body 또는 `name`을 생략하면 `"Quick Room"`을 사용한다. 이름은 trim 후 1..80자다.
- 성공 응답은 HTTP 201과 `{"roomId", "name", "token", "joinUrl"}`이다. `name`은 이후
  `welcome.snapshot.name`과 동일하다.

- `close-terminal-request`는 열린 터미널의 owning online host에만 `close-terminal`로 전달한다.
  서버는 요청만으로 터미널 상태를 바꾸지 않는다. 실제 PTY 종료 뒤 host가 보낸
  `terminal-closed`가 상태 변경과 `terminal-closed` room event의 유일한 원인이다.
- host는 최초 연결과 Kill Switch 토글마다 `host-input-state`를 보낸다. 서버는 snapshot과
  `host-input-state-changed` event에 이를 반영하며, `false` 동안 모든 remote input frame을
  폐기하고 요청자에게 `lease-invalid{reason:"remote-input-disabled"}`를 보낸다.
- `set-terminal-mode`는 participant가 명시적으로 보낸다. 터미널이 열려 있고 owning host가
  online일 때만 적용하며, 변경 시 `terminal-mode-changed`를 Room 전체에 방송한다.
- `update-terminal-geometry`는 participant가 drag·resize·Arrange commit 시 최종 논리 좌표를
  보낸다. 서버는 Room의 최신 geometry를 교체하고 `terminal-geometry-changed`를 참가자 전체에
  방송한다. 동시 갱신은 서버 수신 순서의 last-write-wins이며 이후 welcome snapshot도 최신값을 담는다.
- `rename-terminal`은 participant가 trim 후 1..80자인 표시 이름을 보낸다. 서버는 Room의 최신
  이름을 교체하고 `terminal-renamed`를 참가자 전체에 방송한다. 이후 welcome snapshot도 최신값을 담는다.
