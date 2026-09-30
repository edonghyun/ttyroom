# HTTP API 계약

방 생성의 공통 필드와 Spring 전용 등록·취소 API를 구분해 정리한다.
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

<!-- http-example: createRoom 201 -->

```json
{
  "roomId": "b3bb1eca-9e65-4b54-87ad-d491f16c9f09",
  "name": "Pair debugging",
  "token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "managerCredential": "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM",
  "joinUrl": "http://127.0.0.1:3000/r/b3bb1eca-9e65-4b54-87ad-d491f16c9f09#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}
```

Spring의 `POST /api/rooms`는 공통 응답에 `managerCredential`을 추가한다. 32자 URL-safe 무작위
비밀값이며 초대 token과 별개다. 관리 digest와 방을 한 번에 저장한 뒤 응답한다. 응답은
`Cache-Control: no-store`이며 `joinUrl`에는 관리 credential을 넣지 않는다.
관리 비밀값은 생성자에게 한 번 반환하고 조회·계정 복구 API는 제공하지 않는다.

### POST /api/rooms/{roomId}/participants

본문은 `{"token":"<초대 토큰>"}`만 허용한다. 성공은 201이다.

<!-- http-example: registerParticipant 201 -->

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
성공은 201이다.

<!-- http-example: registerHost 201 -->

```json
{
  "hostId": "b3bb1eca-9e65-4b54-87ad-d491f16c9f09",
  "credential": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
}
```

초대 token, participant/host credential, 다른 방의 관리 credential로는 등록할 수 없다.
본문·쿼리의 관리 비밀값으로 헤더를 대신할 수 없다. 기존 hostId를 지정하는 필드도 허용하지 않는다.
Bearer scheme의 대소문자는 구분하지 않으며 중복 헤더와 잘못된 credential 형식은 거절한다.

### 저장·응답·오류

권한 거절 응답 예시:

<!-- http-example: registerHost 403 -->

```json
{ "error": "registration forbidden" }
```

- 두 등록 API는 해당 방의 명령 순서 안에서 권한을 확인하고 credential draft를 저장한 뒤 확정한다.
  저장 실패 시 새 credential과 성공 응답을 노출하지 않는다.
- 새 방은 관리 credential을 포함하므로 SQLite v2로 저장한다. v1 파일을 읽을 수는 있지만
  관리자 credential을 자동 생성하지 않는다. Node 참조 서버는 v2 파일을 읽을 수 없다.
- 발급 성공과 오류 JSON 모두 `Cache-Control: no-store`다. 오류는 아래 고정된 문구만 반환한다.
  입력 원문·토큰·digest·저장소 예외를 응답에 복사하지 않는다.
- 저장 성공 후 응답 유실은 자동 재시도 시 중복 등록을 만들 수 있다. idempotency key는
  지원하지 않으며, 재등록은 기존 credential을 회수하지 않는다.

| 상태 | JSON error 값                  | 조건                                                       |
| ---- | ------------------------------ | ---------------------------------------------------------- |
| 400  | `request body too large`       | 본문 16,384 bytes 초과                                     |
| 400  | `invalid json`                 | JSON 파싱 실패·공백만 있는 본문·trailing JSON              |
| 400  | `invalid registration request` | 잘못된 구조·타입·추가 필드                                 |
| 403  | `registration forbidden`       | 없는 방·잘못된 초대·부족한 관리 권한·누락/잘못된 인증 헤더 |
| 503  | `registration unavailable`     | 일시적 저장 실패·서버 종료 상태. 생성에도 적용             |

공개 오류에서 없는 방과 잘못된 권한을 구분하지 않는다. 본문 형식 검사는 권한 검사에 앞선다.
명시적으로 선택한 v7 서버에는 초대 토큰과 임의 role/clientId로 입장하는 경로가 남아 있다. v8 서버에서는 거절한다.
v8 입장 경계가 실제 credential을 검증한다.

## Spring 취소 API

- `DELETE /api/rooms/{roomId}/participants/{subjectId}`
- `DELETE /api/rooms/{roomId}/hosts/{subjectId}`

해당 방의 `Authorization: Bearer <관리 credential>` 헤더 하나와 빈 본문 또는 `{}`를 받는다.
subjectId는 소문자 canonical UUID다. 관리 credential·초대 토큰을 URL에 넣지 않는다.
성공은 **204, 빈 본문, Cache-Control: no-store**다. 유효한 관리 권한으로 없는 주체·이미 취소한
주체·다른 역할의 주체를 지정해도 변경 없이 204다. 관리 credential 자체를 취소하는 경로는 없다.

취소는 입장·연결 교체와 같은 방별 명령 순서에서 실행한다. credential 제거와 해당 host의
터미널·host identity 제거를 한 번에 저장한다. 실패하면 기존 권한·연결·workspace를 유지한다.
저장 성공 후 participant의 lease·presence 또는 host의 출력 버퍼·presence를 정리한다.
현재 연결에는 `invalid-credential` 오류와 종료를 요청하고 이후 입장을 거절한다.
참가자에게는 `lease-released` 후 `participant-left`, host 취소에는 `host-removed`를 알린다.
전송 실패가 이미 저장된 취소를 되돌리지는 않는다. 응답은 원격 클라이언트의 종료 수신 확인이 아니다.
마지막 멤버를 취소해도 방과 관리 credential은 남아 신규 등록이 가능하다.

| 상태 | JSON error 값                             | 조건                                                                   |
| ---- | ----------------------------------------- | ---------------------------------------------------------------------- |
| 400  | `request body too large` / `invalid json` | 등록과 같은 16,384 bytes 한도·JSON 규칙                                |
| 400  | `invalid revocation request`              | UUID 형식 오류·object가 아닌 본문·추가 필드                            |
| 403  | `revocation forbidden`                    | 없는 방·잘못된/누락/중복 관리 헤더·다른 방 또는 다른 역할의 credential |
| 503  | `revocation unavailable`                  | 저장 실패·서버 종료 상태                                               |

권한 거절 응답 예시:

<!-- http-example: revokeParticipant 403 -->

```json
{ "error": "revocation forbidden" }
```

오류 JSON도 no-store다. 본문·ID 검사를 권한 검사보다 먼저 수행한다.
취소는 주체 credential의 무효화다. 초대 토큰 회전이나 사람 단위 차단은 아니며,
이미 실행한 셸 명령을 되돌리거나 로컬 PTY 프로세스 종료를 보장하지 않는다.
위 입장 차단은 기본 v8 계약이다. 비교용 v7 모드의 초대 토큰 입장에는 적용되지 않는다.

## 정적 웹과 WebSocket

웹 포함 빌드의 `/`와 `/r/{roomId}`는 React 진입 문서를 제공한다. API-only JAR에는
웹 파일이 없다. `/ws`는 WebSocket 업그레이드 경로이며 REST endpoint가 아니다.
초대 페이지를 받는 것만으로 방 인증이 완료되는 것은 아니다.

## 검증과 명세 유지

- [RoomController](../backend/src/main/java/dev/ttyroom/adapter/http/RoomController.java)
- [HTTP 공통 E2E](../e2e/src/http-api.e2e.ts): 기본값, trim, UTF-16 경계, 본문 bytes, 오류, 토큰과 URL.
- [등록 HTTP 테스트](../backend/src/test/java/dev/ttyroom/adapter/http/RoomRegistrationTests.java): 권한·저장 실패·오류 응답.
- [Spring 등록 프로세스 E2E](../e2e/src/registration.spring.ts): 실제 JAR·HTTP·새 PID의 관리 권한 복원.
- [취소 프로세스 E2E](../e2e/src/revocation.spring.ts): 활성 연결 종료·재시작 후 취소 및 workspace 복원.
- [정적 웹 E2E](../e2e/src/static-web.e2e.ts)

[openapi.json](openapi.json)은 Spring의 명시적 HTTP 경로 6개에 대한 기계 판독 명세다.
[OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0.html)의 경로·응답·헤더·JSON Schema 표현을 사용한다.
Markdown은 저장·권한·재시도·호환성의 의미를 설명한다. 두 파일을 별도 수동 목록으로 방치하지 않는다.

- `pnpm --filter @ttyroom/e2e test`: OpenAPI 구조·참조, 요청/응답 예시, 표시한 Markdown 예시의 일치,
  검증기 자체의 헤더·본문·상태 오류 검출을 검사한다. `pnpm test`에도 포함된다.
- `./scripts/test-spring.sh registration`: 실제 Spring 프로세스의 200/201/204/400/403 응답을 명세와 비교한다.
  문서의 v8 hello와 취소 오류도 실제 소켓에 연결한다.
- `./backend/gradlew -p backend test`: 명시적 Spring HTTP 라우트와 명세 경로 집합을 비교하고,
  저장 실패를 주입한 다섯 작업의 503 본문·no-store를 같은 명세 예시와 비교한다.
- `pnpm --filter @ttyroom/protocol test`: v7과 v8 문서의 wire 예시를 TS 파서로 검사한다.
  Java 코덱도 같은 v8 fixture를 사용한다.

검증 범위는 명시적 HTTP 경로와 표시된 JSON 예시다. 모든 설명 문장의 의미나 조합을 자동 증명하지 않는다.
JSON 바이트 제한·UTF-16 trim·정확한 권한 판정·저장 순서·경합·재접속은 기존 행동 테스트가 맡는다.
`/api/**`의 fallback 404, 정적 파일, `/ws` 업그레이드, binary frame은 OpenAPI 범위에서 제외한다.
방 생성 400의 Host 누락 text/plain은 no-store가 없는 호환 분기이므로 이 상태의 공통 헤더를 필수로
선언하지 않는다. JSON 400의 no-store는 실제 응답 테스트에서 별도로 검사한다.

### OpenAPI와 문서 UI 선택

현재 독자는 로컬 실행·API 연동을 확인하는 개발자와 설계·검증 근거를 읽는 포트폴리오 검토자를 기준으로 삼는다.
첫 독자는 경로와 요청/응답을, 두 번째 독자는 저장·실패·복구의 이유와 테스트를 찾아야 한다.

| 선택                             | 얻는 것                                                                  | 유지 비용과 결정                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown만 유지                  | 행동과 비표준 호환 규칙을 바로 설명                                      | 응답 필드·상태가 바뀌어도 수동 리뷰에 의존하므로 이것만으로는 부족                                                                                       |
| OpenAPI + 기존 Markdown          | 표준 구조와 실제 응답의 차이를 CI에서 검출; 의미 설명은 기존 링크로 탐색 | 명세·설명 두 표현과 검증 의존성을 관리해야 함. 동일 예시 비교와 경로 집합 검사로 연결하므로 채택                                                         |
| Spring annotation으로 명세 생성  | controller와 명세를 한 위치에서 편집 가능                                | 현재 raw JSON·엄격한 필드 검사·고정 오류를 별도 annotation으로 다시 설명해야 함. 같은 구현에서 생성한 명세만으로 독립 계약 검증을 대신하지 않으므로 보류 |
| Swagger UI 또는 별도 문서 사이트 | 탐색·검색·대화형 요청 도구                                               | 현재 경로 6개는 이 문서와 [문서 안내](../docs/README.md)에서 찾을 수 있음. 사이트 빌드·배포·내비게이션 관리가 더 필요해 보류                             |

OpenAPI 검증은 E2E 개발 의존성만 사용한다. 서버·클라이언트 런타임 의존성이나 `/swagger-ui` endpoint는 추가하지 않는다.
Java 테스트는 정적 명세·fixture만 읽으며 Node/pnpm을 호출하지 않는다.
외부 API 사용자가 늘어 endpoint 탐색·검색 또는 샘플 요청 실행 문제가 실제로 반복되면 UI를 다시 검토한다.
검토 과정과 실행 근거는 [작업 이력](../docs/WORK_LOG.md)과 [검증 기록](../docs/VERIFICATION.md)에 둔다.
