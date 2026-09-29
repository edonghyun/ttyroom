# v8 입장 인증 계약

Spring·React·Connector의 기본 입장 계약이다. 서버 기본값은 8이며,
`TTYROOM_PROTOCOL_VERSION=8` 또는 설정 파일의 `protocolVersion: 8`로 명시할 수도 있다.
프로세스 하나는 한 버전만 허용한다. v8 프로세스에서 v7 fallback이나 별도 v7 입장 경로는 없다.
잘못된 설정은 시작을 실패시킨다. v7은 명시적 비교 테스트용 모드이며 제품 클라이언트가 연결하지 않는다.

## Hello

HTTP로 [주체를 등록](HTTP.md#spring-등록-api)한 뒤 `/ws`에 아래 메시지를 보낸다.

```json
{
  "type": "hello",
  "protocolVersion": 8,
  "roomId": "b3bb1eca-9e65-4b54-87ad-d491f16c9f09",
  "credential": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "name": "Alice"
}
```

문자열인 roomId·credential·name과 정확한 필드 집합이 필요하다. `role`, `clientId`, `hostId`,
`participantId`, `token`을 포함한 추가 필드는 거절한다. 표시 이름은 인증 수단이 아니며
클라이언트가 제출할 수 있다. 서버가 방의 credential 레코드에서 역할과 subject ID를 결정한다.
participant는 참가자 연결로, host는 Connector 연결로 입장한다. MANAGER는 WS 역할이 아니다.

## 응답과 연결 수명

| 경우                                                              | 결과                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 유효한 participant/host credential                                | 기존 welcome 형식. selfClientId는 서버가 발급한 subject ID                    |
| 다른 방·취소·불명 credential, 초대 토큰, 관리 credential, 없는 방 | error code/message `invalid-credential`, 연결 종료                            |
| 프로세스 버전과 다른 hello 또는 맞지 않는 인증 형식               | `unsupported-protocol-version`, message `server=7` 또는 `server=8`, 연결 종료 |
| 필드 누락·추가·잘못된 타입                                        | `bad-message`, 입장하지 않음. 기존과 같이 연결에서 올바른 hello 재시도 가능   |
| 이미 입장한 연결의 hello                                          | `bad-message`, 기존 주체 유지                                                 |

credential은 welcome·snapshot·방 이벤트·오류·문자열 진단에 포함하지 않는다.
서버 메시지와 binary frame의 나머지 형식은 [v7 명세](PROTOCOL.md)와 같다.
공통 TypeScript 패키지는 v8 credential hello와 v7 비교용 hello를 구분한다. 제품 클라이언트는 v8만 전송한다.

credential 검증, host 신원 저장, 연결 교체는 동일한 방별 명령 순서에서 실행한다.
검증 실패는 presence·기존 연결·lease·PTY 상태를 바꾸지 않는다. 검증된 subject만 같은 subject의
연결을 교체하며 기존 Member의 늦은 명령·disconnect·expiry callback은 새 연결에 적용되지 않는다.
host의 welcome은 inventory 확인 전 복구 상태(offline·입력 차단)다. hello 성공을 PTY 복구 완료로 취급하지 않는다.

## 전환 범위

v8 검증은 별도 포트와 새 SQLite 파일을 사용한다. v1 파일의 기존 host/client ID에 관리·주체
credential을 자동으로 붙이지 않는다. 여러 서버가 같은 SQLite 파일을 함께 쓰는 배포는 지원하지 않는다.
명시적으로 v7을 선택하면 기존 사칭 문제가 남는다. HTTP 취소·활성 연결 종료와 최종 취소 경합 E2E는 T9.5 범위다.
React의 최초 등록·탭별 credential 보관과 Connector의 숨김 stdin 입력은 구현했다. 등록 실패는 사용자에게
표시하며 자동 재등록하지 않는다. invalid-credential 응답 뒤에는 재접속을 중단한다.
