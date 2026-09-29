# HTTP API 계약

방 생성의 공통 필드와 Spring 전용 등록 API를 구분해 정리한다.
실시간 협업은 [WebSocket/binary 명세](PROTOCOL.md)를 사용한다.
기본 로컬 주소는 `http://127.0.0.1:3000`이다.

## GET /healthz

서버가 요청을 처리하면 200, text/plain 본문 `ok`를 반환한다.
종단 간 Connector·PTY 건강 상태를 검사하는 응답은 아니다.

## POST /api/rooms

사전 인증 없이 방과 초대 토큰을 생성한다. 성공은 201, application/json이다.
반복 요청은 서로 다른 방을 만든다. idempotency key는 지원하지 않는다.

```sh
curl -i http://127.0.0.1:3000/api/rooms \
  -H 'Content-Type: application/json' \
  --data '{"name":"Pair debugging"}'
```

| 입력              | 계약                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 본문              | 최대 16,384 bytes. 경계 초과는 400이다.                                                                                 |
| 빈 본문 또는 `{}` | 이름은 Quick Room이다. 공백만 있는 본문은 invalid json이다.                                                             |
| name              | 생략 가능. 제공하면 문자열이어야 하며 JavaScript trim 후 UTF-16 code unit 1..80이다. 이모지는 보통 2 units다.           |
| 추가 필드         | 무시한다.                                                                                                               |
| Content-Type      | 기존 호환성 때문에 JSON 지정이 없어도 본문을 JSON으로 파싱한다. 클라이언트는 application/json을 지정하는 편이 명확하다. |

성공 응답 예시의 값은 설명용이다.

```json
{
  "roomId": "b3bb1eca-9e65-4b54-87ad-d491f16c9f09",
  "name": "Pair debugging",
  "token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "joinUrl": "http://127.0.0.1:3000/r/b3bb1eca-9e65-4b54-87ad-d491f16c9f09#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}
```

roomId는 UUID v4, token은 URL-safe 32자 문자열이다. joinUrl의 fragment에 토큰이 들어간다.
v8 참가자는 이 토큰으로 HTTP 등록을 요청하고 발급된 credential을 WebSocket hello로 전달한다. 토큰은 초대 권한이므로 실제 응답을
공개 로그·문서 예시에 넣지 않는다. 현재 joinUrl은 요청 Host를 사용해 http URL로 만든다.
프록시의 HTTPS scheme을 자동 반영하는 배포 계약은 정의하지 않았다.

| 상태 | JSON 본문                            | 조건                                          |
| ---- | ------------------------------------ | --------------------------------------------- |
| 400  | `{"error":"request body too large"}` | 본문 한도 초과                                |
| 400  | `{"error":"invalid json"}`           | 파싱 실패, 공백 본문, 뒤에 JSON이 추가된 본문 |
| 400  | `{"error":"invalid room name"}`      | object가 아닌 본문, 잘못된 name 타입·길이     |
| 404  | `{"error":"not found"}`              | 미지원 API 경로·메서드                        |

Spring controller에는 Host 누락 시 400 text/plain `host header required`를 반환하는
분기가 있다. HTTP 컨테이너가 그 전에 잘못된 요청을 거절할 수도 있으므로 이 응답은
Node/Spring 공통 wire 계약으로 검증한 항목과 구분한다.
Node/Spring 공통 5xx 형식은 정의하지 않았다. Spring의 저장·종료 상태 오류는 아래 503 계약을 따른다.

## Spring 등록 API

Node v7 참조 구현에는 없는 HTTP 확장이다. Spring 기본값은 [v8 credential 입장](AUTHENTICATION_V8.md)이다.
React는 초대 토큰으로 참가자를 등록하고, 방 생성자의 Add Host에서 관리자 권한으로 Host를 등록한다.
Connector는 발급된 Host credential을 stdin으로 받아 v8 hello로 접속한다.

### 방 생성의 관리 credential

Spring의 `POST /api/rooms`는 공통 응답에 `managerCredential`을 추가한다. 32자 URL-safe 무작위
비밀값이며 초대 token과 별개다. 관리 digest와 방을 한 번에 저장한 뒤 응답한다. 응답은
`Cache-Control: no-store`이며 `joinUrl`에는 관리 credential을 넣지 않는다.
관리 비밀값은 생성자에게 한 번 반환하고 조회·계정 복구 API는 제공하지 않는다.

### POST /api/rooms/{roomId}/participants

본문은 `{"token":"<초대 토큰>"}`만 허용한다. 성공은 201이다.

```json
{
  "participantId": "b3bb1eca-9e65-4b54-87ad-d491f16c9f09",
  "credential": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
}
```

서버가 새 participantId와 credential을 발급한다. role·clientId·participantId 등 추가 필드는
거절하며 기존 주체를 선택할 수 없다. 반복 등록은 각각 독립된 주체를 만든다. 표시 이름은
변경 가능한 연결 메타데이터이므로 등록 입력·저장 레코드에 포함하지 않는다.

### POST /api/rooms/{roomId}/hosts

`Authorization: Bearer <관리 credential>` 헤더 하나와 빈 본문 또는 `{}`를 받는다.
성공은 201, `{"hostId":"<서버 발급 UUID>","credential":"<32자 비밀값>"}`이다.
초대 token, participant/host credential, 다른 방의 관리 credential로는 등록할 수 없다.
본문·쿼리의 관리 비밀값으로 헤더를 대신할 수 없다. 기존 hostId를 지정하는 필드도 허용하지 않는다.
Bearer scheme의 대소문자는 구분하지 않으며 중복 헤더와 잘못된 credential 형식은 거절한다.

### 저장·응답·오류

- 두 등록 API는 해당 방의 명령 순서 안에서 권한을 확인하고 credential draft를 저장한 뒤 확정한다.
  저장 실패 시 새 credential과 성공 응답을 노출하지 않는다.
- 새 방은 관리 credential을 포함하므로 SQLite v2로 저장한다. v1 파일을 읽을 수는 있지만
  관리자 credential을 자동 생성하지 않는다. Node 참조 서버는 v2 파일을 읽을 수 없다.
- 발급 성공과 오류 JSON 모두 `Cache-Control: no-store`다. 오류는 아래 고정된 문구만 반환한다.
  입력 원문·토큰·digest·저장소 예외를 응답에 복사하지 않는다.
- 저장 성공 후 응답 유실은 자동 재시도 시 중복 등록을 만들 수 있다. idempotency key·취소 HTTP API는
  아직 없으며, 재등록은 기존 credential을 회수하지 않는다.

| 상태 | JSON error 값                  | 조건                                                       |
| ---- | ------------------------------ | ---------------------------------------------------------- |
| 400  | `request body too large`       | 본문 16,384 bytes 초과                                     |
| 400  | `invalid json`                 | JSON 파싱 실패·공백만 있는 본문·trailing JSON              |
| 400  | `invalid registration request` | 잘못된 구조·타입·추가 필드                                 |
| 403  | `registration forbidden`       | 없는 방·잘못된 초대·부족한 관리 권한·누락/잘못된 인증 헤더 |
| 503  | `registration unavailable`     | 일시적 저장 실패·서버 종료 상태. 생성에도 적용             |

공개 오류에서 없는 방과 잘못된 권한을 구분하지 않는다. 본문 형식 검사는 권한 검사에 앞선다.
명시적으로 선택한 v7 서버에는 초대 토큰과 임의 role/clientId로 입장하는 경로가 남아 있다. v8 서버에서는 거절한다.
v8 입장 경계가 실제 credential을 검증한다. HTTP 취소와 활성 연결 종료 API는 아직 제공하지 않는다.

## 정적 웹과 WebSocket

웹 포함 빌드의 `/`와 `/r/{roomId}`는 React 진입 문서를 제공한다. API-only JAR에는
웹 파일이 없다. `/ws`는 WebSocket 업그레이드 경로이며 REST endpoint가 아니다.
초대 페이지를 받는 것만으로 방 인증이 완료되는 것은 아니다.

## 검증과 명세 유지

- [RoomController](../backend/src/main/java/dev/ttyroom/adapter/http/RoomController.java)
- [HTTP 공통 E2E](../e2e/src/http-api.e2e.ts): 기본값, trim, UTF-16 경계, 본문 bytes, 오류, 토큰과 URL.
- [등록 HTTP 테스트](../backend/src/test/java/dev/ttyroom/adapter/http/RoomRegistrationTests.java): 권한·저장 실패·오류 응답.
- [Spring 등록 프로세스 E2E](../e2e/src/registration.spring.ts): 실제 JAR·HTTP·새 PID의 관리 권한 복원.
- [정적 웹 E2E](../e2e/src/static-web.e2e.ts)

현재 문서는 수동 명세다. OpenAPI 파일·Swagger UI 및 HTTP 명세 자동 드리프트 검사는
아직 추가하지 않았다. 먼저 기존 구현의 비표준 호환 동작과 테스트 근거를 명시했다.
