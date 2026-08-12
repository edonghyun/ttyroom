# TTYRoom Wire Protocol

언어 중립 명세. TypeScript 구현(`src/messages.ts`의 zod 스키마, `src/data-frame.ts`의 코덱)이
이 문서와 동기되어야 하며, 골든 테스트가 드리프트를 잡는다. 레이아웃·형태 변경은
프로토콜 버전 범프와 이 문서의 갱신을 요구한다.

## 버전과 협상

- 현재 버전: `PROTOCOL_VERSION = 1`
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
- 헤더보다 짧은 프레임, 알 수 없는 frameType은 malformed로 취급하고 연결을 죽이지 않는다.

## 식별자

`terminalId` / `leaseId` / `seq`는 u32 숫자(Room 단위 증가 카운터).
`roomId` / `hostId` / `clientId`는 문자열.

## 연결 수명

```text
연결 수립 → hello (클라이언트 첫 메시지)
  ├─ 거부: error{code} 후 서버가 연결 종료
  └─ 수락: welcome{selfClientId, snapshot} → 이후 이벤트 스트림 (room-event 등)
```

- 재접속은 **새 연결 + 동일 clientId의 hello**다. 전송 계층은 재연결을 숨기지 않는다.
- 서버는 재접속자에게 현재 Room 스냅샷과 터미널별 스크롤백 replay를 제공한다.

## seq · sync 의미론

- 터미널별 출력 `seq`는 단조 증가한다. 브라우저는 seq로 유실을 감지한다.
- `sync { terminalId, seq }` — "터미널 t의 seq n까지 방송 완료". 백프레셔 회복 시
  재동기화 지점이자 테스트의 명시적 동기화 지점.
- `output-gap { terminalId, fromSeq, toSeq }` — 느린 참여자에게 드롭된 출력 구간의 통지.
  수신자는 스크롤백 재동기화로 복구한다.

## 제어 메시지

### 클라이언트(참여자·호스트 공통) → 서버

| type    | 예시                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------- |
| `hello` | `{"type":"hello","protocolVersion":1,"roomId":"r1","token":"t","clientId":"c1","name":"동현","role":"participant"}` |

`role`은 `"participant"` 또는 `"host"`. 호스트의 `clientId`는 `hostId`로도 쓰인다.

### 참여자 → 서버

| type                    | 예시                                                            |
| ----------------------- | --------------------------------------------------------------- |
| `open-terminal-request` | `{"type":"open-terminal-request","hostId":"h1"}`                |
| `acquire-lease`         | `{"type":"acquire-lease","terminalId":3}`                       |
| `release-lease`         | `{"type":"release-lease","terminalId":3,"leaseId":7}`           |
| `resize-request`        | `{"type":"resize-request","terminalId":3,"cols":120,"rows":40}` |

### 호스트 → 서버

| type              | 예시                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `terminal-opened` | `{"type":"terminal-opened","terminalId":3}`                                                               |
| `terminal-closed` | `{"type":"terminal-closed","terminalId":3,"exitCode":0}`                                                  |
| `terminal-meta`   | `{"type":"terminal-meta","terminalId":3,"meta":{"cwd":"/home/kep","gitBranch":"main","fgProcess":"vim"}}` |

### 서버 → 클라이언트

| type            | 예시                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `welcome`       | `{"type":"welcome","selfClientId":"c1","snapshot":{"roomId":"r1","participants":[],"hosts":[],"terminals":[],"leases":[]}}` |
| `room-event`    | `{"type":"room-event","event":{"kind":"participant-joined","participant":{"clientId":"c2","name":"민수"}}}`                 |
| `lease-result`  | `{"type":"lease-result","terminalId":3,"result":{"kind":"granted","leaseId":7}}`                                            |
| `lease-invalid` | `{"type":"lease-invalid","terminalId":3,"reason":"stale lease"}`                                                            |
| `sync`          | `{"type":"sync","terminalId":3,"seq":10}`                                                                                   |
| `output-gap`    | `{"type":"output-gap","terminalId":3,"fromSeq":11,"toSeq":42}`                                                              |
| `error`         | `{"type":"error","code":"invalid-token","message":"token mismatch"}`                                                        |

`lease-result.result`는 `{"kind":"granted","leaseId":n}` 또는
`{"kind":"denied","holderClientId":"..."}`.
`error.code`는 `room-not-found` · `invalid-token` · `unsupported-protocol-version` · `bad-message`.

### 서버 → 호스트

| type             | 예시                                                          |
| ---------------- | ------------------------------------------------------------- |
| `open-terminal`  | `{"type":"open-terminal","terminalId":3,"cols":80,"rows":24}` |
| `close-terminal` | `{"type":"close-terminal","terminalId":3}`                    |
| `resize`         | `{"type":"resize","terminalId":3,"cols":120,"rows":40}`       |

### room-event의 event 종류

`participant-joined` · `participant-left` · `host-connected` · `host-offline` · `host-removed`
· `terminal-opened` · `terminal-closed` · `lease-granted` · `lease-released` · `terminal-meta`
— 각 형태는 `src/messages.ts`의 `roomEventSchema`가 단일 진실이다.
