# HTTP API 계약

현재 Node/Spring 공통 동작과 Spring 어댑터를 기준으로 정리한다.
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
참가자는 이 토큰을 WebSocket hello로 전달한다. 토큰은 초대 권한이므로 실제 응답을
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
저장소 장애 등 예기치 않은 5xx의 공통 JSON 오류 형식은 아직 정의하지 않았다.

## 정적 웹과 WebSocket

웹 포함 빌드의 `/`와 `/r/{roomId}`는 React 진입 문서를 제공한다. API-only JAR에는
웹 파일이 없다. `/ws`는 WebSocket 업그레이드 경로이며 REST endpoint가 아니다.
초대 페이지를 받는 것만으로 방 인증이 완료되는 것은 아니다.

## 검증과 명세 유지

- [RoomController](../backend/src/main/java/dev/ttyroom/adapter/http/RoomController.java)
- [HTTP 공통 E2E](../e2e/src/http-api.e2e.ts): 기본값, trim, UTF-16 경계, 본문 bytes, 오류, 토큰과 URL.
- [정적 웹 E2E](../e2e/src/static-web.e2e.ts)

현재 문서는 수동 명세다. OpenAPI 파일·Swagger UI 및 HTTP 명세 자동 드리프트 검사는
아직 추가하지 않았다. 먼저 기존 구현의 비표준 호환 동작과 테스트 근거를 명시했다.
