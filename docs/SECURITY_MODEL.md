# 보안 모델과 신뢰 경계

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-30 현재 Spring·브라우저·Connector 구현을 대상으로 한 코드 및 계약 검토다.
침투 테스트, 의존성 취약점 전수 점검, 공개 배포 승인 결과가 아니다.

## 사용 범위

현재 기본 구성은 loopback에 바인딩하는 로컬 협업 실험이다.
셸을 공유하는 사용자는 **초대 토큰을 가진 참여자와 서버를 신뢰한다**는 전제가 필요하다.
Connector는 자신의 OS 사용자 권한으로 셸을 실행한다. 컨테이너·파일 접근 제한·명령
allowlist를 제공하지 않으므로, 원격 입력 허용은 해당 셸에서 명령을 실행할 권한을 주는 행위다.
이미 실행한 명령의 효과는 Kill Switch로 되돌리지 않는다.

## 자산과 신뢰 경계

| 자산                      | 경계                       | 현재 동작                                                                                        |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| 공유자 PC와 파일·환경변수 | 서버 → Connector → PTY     | 실제 로컬 셸 실행. Connector의 cwd와 환경을 상속하며 샌드박스가 아니다.                          |
| 초대 토큰                 | URL → 브라우저 → HTTP 등록 | 새 참가자 등록 권한. 실제 WS 연결은 별도 주체 credential로 인증한다.                             |
| 입력 권한                 | 인증된 participant → 서버  | exclusive에서는 현재 lease, shared에서는 입력 허용 상태를 검사한다.                              |
| 터미널 출력·메타데이터    | host → 서버 → 방 참여자    | 같은 방의 참여자에게 공유한다. 출력에 나타난 비밀은 자동으로 지워지지 않는다.                    |
| 영속 상태                 | 서버 → SQLite              | 토큰 원문 대신 SHA-256 digest와 방·터미널 상태를 저장한다. DB 파일 암호화·OS 접근 통제는 별도다. |

## 현재 구현된 보호

- 토큰은 SecureRandom의 24 bytes를 URL-safe Base64로 인코딩한다. 서버는 SHA-256 digest를
  `MessageDigest.isEqual`로 비교한다. 잘못된 토큰과 다른 방의 토큰은 입장할 수 없다.
- URL fragment의 토큰은 일반 HTTP 경로에 포함되지 않는다. 하지만 페이지 JavaScript,
  초대 링크를 복사한 사람과 브라우저 기록 등에 노출될 수 있다. 제품 CLI는 비밀값 없는 방 URL만 받고 Host credential은 숨김 stdin에서 읽는다.
- hello로 수락되기 전의 제어·입력·출력은 인증된 세션의 동작으로 처리하지 않는다.
  참가자 명령과 host 보고는 연결에 정해진 역할을 검사한다.
- 입력은 열린 터미널, 연결된 owning host, 원격 입력 허용 상태를 확인한다.
  exclusive에서는 lease 소유자와 leaseId도 확인한다. shared도 Kill Switch를 우회하지 않는다.
- Connector의 Kill Switch는 로컬에서 입력 프레임과 새 셸 생성을 차단한다.
  resize·close는 통과한다. 이미 실행 중인 명령을 멈추는 기능은 아니다.
- 교체되거나 취소된 세션의 늦은 명령·입력·출력·disconnect·expiry는 현재 세션을 변경하지 못한다.
- 관리자의 주체 취소는 저장 후 현재 연결 종료와 이후 입장 거절에 적용한다.
  저장 실패 시 기존 권한을 유지하며 이미 실행된 명령이나 로컬 PTY 종료를 보장하지 않는다.
- 송신 큐·replay·수신 메시지에 한도가 있고 송신 시간 초과 시 연결을 정리한다.
  추가로 Spring은 저장된 방·terminal·retained payload와 인증 전/후 WebSocket 개수를 제한한다.
  [소유자·수명·설정](DEVELOPMENT.md#전역-admission-예산-spring)에 정의된 범위이며 전체 heap 상한은 아니다.
- 정적 웹 응답에 CSP, no-referrer, nosniff 헤더를 설정한다.
  Hello·Invitation 등의 문자열 표현은 자격 증명을 숨긴다. 모든 로그 경로의 무누출을 검증한 것은 아니다.
- Spring HTTP host 등록은 해당 방의 관리 credential을 확인하고 저장 후에만 발급 응답을 보낸다.
  참가자 등록에는 초대 토큰을 사용한다. v8 WS는 등록된 주체 credential의 역할과 ID로 입장시킨다.
  관리 비밀값은 초대 링크·snapshot에 넣지 않고 발급 응답에 no-store를 설정한다.

v8 서버 모드에서는 HTTP로 발급한 participant/host credential을 검증하고 서버가 역할·ID를 결정한다.
초대·관리 credential의 WS 사용과 임의 신원 필드를 거절한다. 취소 판정과 입장은 같은 방별 명령 순서를 따른다.
자세한 범위는 [v8 계약](../protocol/AUTHENTICATION_V8.md)에 있다. 기본값과 제품 클라이언트는 v8이다.

## 제한과 예상 위협

v8에도 credential 유출·ACL·전송·자원 제한 과제는 남는다. 명시적 v7 비교 모드는 이전 사칭 제한을 그대로 가진다.

| 위협/상황                               | 현재 제한과 의미                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 토큰을 가진 참여자가 다른 clientId 사용 | v8은 요청자가 보낸 ID를 거절하고 credential로 주체를 결정한다. 남의 credential을 획득하면 같은 주체로 재접속할 수 있다.                                                                      |
| 참가자가 host 역할을 선택               | v8은 host credential을 검증한다. Host 등록은 manager만 가능하다. 동일 방 내부의 세분화된 작업 ACL은 제공하지 않는다.                                                                         |
| View only 표시                          | 현재 입력 lease를 보유하지 않았다는 UI 상태다. 영구 읽기 전용 ACL이 아니며, 참여자는 mode 변경·생성·종료 등의 허용된 요청을 보낼 수 있다.                                                    |
| 유출된 초대 링크                        | 개별 주체 취소 API는 있으나 초대 토큰 만료·회전은 없다. 링크 소유자는 새 참가자로 등록할 수 있어 사람 단위 차단이 아니다.                                                                    |
| 외부 웹사이트의 localhost 접근          | Spring WS는 Origin `*`를 허용한다. 방 입장에는 주체 credential이 필요하지만 loopback 바인딩만으로 악성 웹사이트의 접근을 차단한다고 볼 수 없다.                                              |
| 방 대량 생성·연결 대기                  | HTTP 방 생성은 무인증이다. 저장된 방·host·credential, WebSocket·membership quota와 5초 hello deadline이 있다. HTTP/TCP·upgrade 전 rate limit은 없다. 공개 서비스의 DoS 방어로 충분하지 않다. |
| 네트워크 도청·중간자                    | 기본 로컬 HTTP/WS는 TLS를 제공하지 않는다. 원격 노출에는 HTTPS/WSS와 신뢰할 수 있는 프록시·Origin 정책이 필요하다.                                                                           |
| 서버 또는 공유자 PC 침해                | 서버가 중계하는 입력과 PTY 실행 주체를 신뢰한다. 현재 구조는 침해된 서버·로컬 계정으로부터 셸을 보호하지 않는다.                                                                             |

애플리케이션의 기본 `server.address=127.0.0.1`은 배포 설정으로 바뀔 수 있다.
“항상 외부 접근 불가”라고 설명하지 않는다. Origin 정책을 바꿀 때는 Origin 없는 native
Connector와 브라우저 연결을 함께 고려해야 한다.

## 공개 배포 전에 결정할 순서

[초대·주체·재접속 증명 분리 설계안](AUTHENTICATION.md)에 첫 항목의 대안과
구현 계약을 정리했다. credential 등록·v8 연결·취소는 구현했으며, 세부 ACL과
전송·자원 제한은 별도 과제다.

1. **신뢰·권한 모델:** host 승인/자격 증명, 사용자 식별, 읽기 전용/편집/셸 실행 권한,
   재접속용 증명과 clientId를 구분한다. 현재 bearer token만으로 충분한 대상인지 먼저 정한다.
2. **토큰 수명과 노출:** 만료·회전·취소, URL/CLI 전달 방식, 로그와 기록의 보관 정책을 정한다.
3. **접근 경계:** TLS, 브라우저 Origin, 프록시 Host 처리, 방 생성 허용 범위를 정한다.
4. **자원 한도:** 구현된 전역 연결·방·터미널 quota와 입장 제한시간을 실제 배포 부하로 검증하고 HTTP·명령 빈도 제한과 저장 장애 복구를 보완한다.
5. **셸 실행 범위:** 별도 OS 계정·컨테이너 등 격리가 필요한지 결정하고 종료·파일 접근을 검증한다.

이는 후속 설계 항목이며 이번 문서 작성으로 구현된 기능이 아니다.
인증·권한 정책을 바꿀 때는 현재 v7 클라이언트와 저장 상태의 호환성도 함께 검토한다.

## 구현과 검증 근거

- [RoomDirectory](../backend/src/main/java/dev/ttyroom/application/RoomDirectory.java): 토큰 생성·digest·인증.
- [RoomSessions](../backend/src/main/java/dev/ttyroom/application/RoomSessions.java): hello 인증, role/clientId 기반 교체, 역할 검사.
- [RoomControl](../backend/src/main/java/dev/ttyroom/domain/RoomControl.java): lease·입력 허용 조건.
- [WebSocketConfiguration](../backend/src/main/java/dev/ttyroom/adapter/ws/WebSocketConfiguration.java): Origin 정책.
- [RoomSocketHandler](../backend/src/main/java/dev/ttyroom/adapter/ws/RoomSocketHandler.java): hello 이전 요청·메시지 한도.
- [ConnectorApp](../connector/src/connector-app.ts), [PtyManager](../connector/src/pty-manager.ts): 로컬 차단과 셸 실행 권한.
- [StaticWebController](../backend/src/main/java/dev/ttyroom/adapter/http/StaticWebController.java): 웹 응답 헤더.
- [admission E2E](../e2e/src/admission.e2e.ts), [terminal-input E2E](../e2e/src/terminal-input.e2e.ts),
  [terminal-mode E2E](../e2e/src/terminal-mode.e2e.ts): 잘못된 토큰, 방 경계, 입력 권한·모드의 외부 계약.

이 테스트는 악의적인 동일 토큰 구성원에 대한 신원 보호나 모든 보안 위협의 방어를 증명하지 않는다.

## 이번 검증

2026-09-29 기존 웹 포함 Spring JAR에 admission·terminal-input·terminal-mode E2E를
실행하여 3개 파일 47개 테스트가 통과했다.
실행 로그 (로컬 `artifacts/security-review/spring-contracts.log`)를 보관했다.
운영 코드와 인증 정책은 변경하지 않았으며 Java 전체·브라우저 전체 테스트는 재실행하지 않았다.
