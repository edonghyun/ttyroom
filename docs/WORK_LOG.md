# 개발 작업 이력

완료한 작업의 변경 이유·결과·검증 성격을 모은 기록이다. 현재 구현은
[아키텍처](ARCHITECTURE.md), [핵심 계약](CONTRACTS.md), [인증 설계](AUTHENTICATION.md)를,
실행 결과는 [검증 기록](VERIFICATION.md)을 따른다.

날짜별 문서 42개와 백엔드 이력 2개를 주제별로 통합했다. 상세 원문·당시 명령·실패 로그의
위치는 [원문 색인](#원문-색인)의 고정 커밋에서 확인한다. 원문의 “현재”, “다음 단계”,
테스트 개수는 작성 시점의 상태다. 아래 항목은 하나의 전체 테스트 실행 결과가 아니다.

## 읽는 순서

- [초기 구성과 검증 경계](#초기-구성과-검증-경계)
- [터미널 생성과 출력 복구](#터미널-생성과-출력-복구)
- [입력 권한과 협업 상태](#입력-권한과-협업-상태)
- [모델과 계층 경계](#모델과-계층-경계)
- [저장과 명령 순서](#저장과-명령-순서)
- [테스트 표현과 동시성 관찰](#테스트-표현과-동시성-관찰)
- [자원 수명과 실패 처리](#자원-수명과-실패-처리)
- [SQLite와 실행 설정](#sqlite와-실행-설정)
- [실제 프로세스와 브라우저 검증](#실제-프로세스와-브라우저-검증)
- [공개 재현과 시연](#공개-재현과-시연)
- [Credential 저장](#credential-저장)
- [등록 API 권한 경계](#등록-api-권한-경계)
- [v8 입장과 연결 교체](#v8-입장과-연결-교체)
- [성능 기준선과 수신 버퍼](#성능-기준선과-수신-버퍼)
- [수신 자원 한도와 참가자 부하](#수신-자원-한도와-참가자-부하)

## 초기 구성과 검증 경계

2026-08-14–09-19. 방별 명령 순서, 실패 의미와 모듈 책임을 설계 기준으로 정했다.
클래스 수나 패턴 이름보다 호출자가 알아야 하는 조건을 줄이는 방향으로 리뷰했다.

- 로컬 셸 연결 프로그램을 Connector로 명명했다. wire의 host·hostId, PTY 수명, Kill Switch는 유지했다.
- E2E가 서버 내부 함수를 호출하던 구조를 실제 실행 파일·HTTP·WebSocket 관찰로 바꿨다.
  fixture가 임시 설정·DB·포트·프로세스의 시작과 정리를 소유한다.
- Java는 독립 Gradle 프로젝트, TypeScript는 pnpm workspace로 배치했다. Git 저장소는 하나로 유지했다.
- wire-v7 fixture로 JSON 예시와 바이너리 경계를 검사했다. 이 검사는 모든 권한·실패 조합을 포괄하지 않는다.

초기 계획·기준 검증·면접 심층 리뷰는 당시 구현을 대상으로 한 자료다. 현재 제품 소개는
[포트폴리오](PORTFOLIO.md), 실행 규약은 [E2E 안내](../e2e/README.md)에 모았다.

## 터미널 생성과 출력 복구

2026-09-21. host 연결, inventory 대조, 생성 ID와 runtime, 메타데이터·출력 복구를 연결했다.

- 확인 전 예약과 실행 중인 PTY를 구분하고, 불확실한 생성은 inventory로 재조정한다. ID를 즉시 재사용하지 않는다.
- runtime 충돌·누락·다른 host의 terminal 소유를 구분한다. 메타데이터 보고가 runtime과 종료 상태를 바꾸지 않는다.
- Connector source 순번으로 중복·역순을 제거하고 browser 순번은 서버 수명 안에서 별도로 부여한다.
- 큰 history를 일반 송신 큐에 한 번에 넣어 replay가 실패하는 두 사례를 재현했다.
  replay 예약·순차 송신으로 수정하고 1,024개 작은 출력, 큰 frame과 다른 참여자의 입장을 검증했다.

복구 계약의 진입점은 [terminal-recovery E2E](../e2e/src/terminal-recovery.e2e.ts)다.
보관량은 제한되며 출력 복구는 입력 재실행·영구 출력 저장을 뜻하지 않는다.

## 입력 권한과 협업 상태

2026-09-21–22. exclusive 제어권, shared 입력, close·resize, 제목·창 배치와 focus·cursor를 구현했다.

- exclusive 입력은 현재 연결·lease와 owning host의 입력 허용을 확인한다. shared도 로컬 차단권을 우회하지 않는다.
- close 요청 수락과 실제 PTY 종료 보고를 구분한다. resize는 PTY 크기이며 공유 창 geometry와 다른 상태다.
- 동일 제목은 변경 알림을 생략하고, 동일 geometry는 재알림한다. 화면 상태 변경은 runtime·lease를 바꾸지 않는다.
- focus는 참여자 수명에 결합하고 cursor는 일시적으로 중계한다. 재접속 교체가 이전 연결의 늦은 정리로 취소되지 않도록 검증했다.

현재 wire 의미는 [통신 규약](../protocol/PROTOCOL.md), 사용자 동작은
[브라우저 제어 테스트](../web/e2e/room-control.e2e.ts)에서 확인한다.

## 모델과 계층 경계

2026-09-21–27. 모델링 리뷰에서 RoomSessions가 terminal과 lease의 교차 조건을 함께 기억해야 하는 부담을 찾았다.

- RoomControl이 입력 허용·모드·host 제거의 교차 규칙을 소유하도록 모았다.
- TerminalWorkspace 내부를 Pending/Running/Exited로 표현해 nullable 필드 조합의 의미를 줄였다.
- 모든 terminal이 등록된 host를 참조해야 한다는 불변식을 생성·inventory·저장 상태에 적용했다.
  잘못된 호출과 저장 상태를 거절하는 6개 실패 사례 후 구현했다.
- Java 계층 검사를 추가해 domain/application의 프레임워크 의존, adapter 간 직접 의존과 진입점 역참조를 검사했다.

RoomControl·생명주기 정리는 동작 보존 리팩터링이고 host 불변식은 거절 계약을 강화한 변경이다.
현재 책임 배치는 [백엔드 설계](../backend/ARCHITECTURE.md)를 따른다.

## 저장과 명령 순서

2026-09-22–28. 영속 계약을 정한 뒤 내구 상태 모델, 저장 조정과 명령 결과를 단계적으로 연결했다.

- 방별 명령 순서에서 draft → save → commit → 효과를 실행한다. 저장 중 상태 monitor를 놓아 실시간 경로가 확정 상태를 사용하게 했다.
- 입장·명령·만료에 반복되던 저장 순서를 RoomOperation으로 모았다.
- 지연 실행 Runnable 대신 명시적인 ChangeResult를 반환하고 commit 후 발행한다.
- 연결·lease·focus·출력 history는 영속 snapshot과 구분한다. live 상태 변경은 명령 순서를 공유하되 저장을 생략한다.
- 저장 대기 중 lease 반납과 후속 binary 입력의 관찰 결과를 특성 테스트로 확인했다.
  Java의 실시간 경로와 Node의 같은 연결 처리 큐가 같다고 설명하지 않는다.

저장 실패·연결 교체·종료 drain의 근거는
[RoomPersistenceTests](../backend/src/test/java/dev/ttyroom/application/RoomPersistenceTests.java)에 있다.
저장 순서가 commit과 메시지 전달의 원자성을 제공하는 것은 아니다.

## 테스트 표현과 동시성 관찰

2026-09-22–28. fixture·행동·관찰·assertion을 구분하고 이전 테스트의 상태에 의존하지 않도록 정리했다.

- `Thread.State.WAITING`만으로 방 명령 대기를 판단하던 거짓 양성을 별도 latch로 재현했다.
  필요한 경우 fixture 안에서 실제 대상 큐를 제한적으로 관찰하며 그 의존성을 명시했다.
- 저장 생략의 여덟 행동을 독립 시나리오로 분리했다. 저장 횟수뿐 아니라 준비 이후 전체 알림도 검사한다.
- 브라우저의 긴 협업 시나리오에 같은 기준을 적용했다. 완료 조건을 기다리고 입력 echo와 실제 실행 출력을 구분했다.
- 파일 목록 조사는 리뷰 범위의 inventory이며 모든 줄의 결함 부재를 증명하는 검사가 아니다.

현재 예시와 작성 규칙은 [CODE_STYLE](CODE_STYLE.md), [Java 테스트 기준](../backend/TESTING.md),
[E2E 작성 기준](../e2e/README.md)에 있다. 특성 테스트와 리팩터링을 새 기능 TDD로 표시하지 않는다.

## 자원 수명과 실패 처리

2026-09-28. 실제 책임 경계에서 오류를 주입하고 유지할 동작과 수정할 결함을 구분했다.

| 작업                | 확인과 변경                                                                                                      | 성격                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Connector 생성 보고 | 전송의 동기 예외를 PTY 생성 실패로 오인했다. catch를 실제 PTY 생성에 한정했다.                                   | 실패 테스트 후 오류 수정 |
| 종료한 화면 런타임  | dispose 뒤 join이 새 세션을 만들었다. 종료 상태에서 생성을 막았다.                                               | 실패 테스트 후 오류 수정 |
| 출력 순번 소유권    | 앱 Map과 replay buffer의 중복 순번을 버퍼로 일원화했다. 용량 초과 후에도 순번을 유지한다.                        | 특성 테스트 후 리팩터링  |
| 만료 타이머         | 실행기 상속 대신 schedule·cancel·close를 제공하는 합성으로 정리했다. 늦은 callback은 Member 동일성으로 방어한다. | 수명 계약 보존           |
| 저장 후 알림 실패   | PeerUnavailable은 해당 수신자를 정리하고 다음 수신자로 진행한다. 예상 밖 예외는 전파하며 저장을 되돌리지 않는다. | 기존 동작의 특성 테스트  |

마지막 항목은 이미 구현된 동작이었으며 두 보강 테스트가 처음부터 통과했다.
[저장·전달 설명](PORTFOLIO.md#판단-2-저장-성공과-전달-성공을-구분한다)과
[RoomPersistenceTests](../backend/src/test/java/dev/ttyroom/application/RoomPersistenceTests.java)를 연결해 읽는다.
송신 큐 수락은 실제 수신 확인이 아니며 outbox·입력 exactly-once는 구현하지 않았다.

## SQLite와 실행 설정

2026-09-28. 실제 파일 저장을 부팅 구성·새 프로세스 복구·설정 적용에 연결했다.

- SqliteRoomStore는 JDBC 수명과 단일 row UPSERT를, StoredRoomJson은 버전과 저장 표현을 소유한다.
- 파일 재열기, 실패한 교체·삭제, v1 저장 파일의 읽기와 교차 사용을 검증했다.
  credential 저장 v2는 이후 추가되었으며 이 당시의 호환성 결과에 포함되지 않는다.
- 저장 경로가 있으면 부팅 중 복원하고, 파일/레코드 오류를 메모리 모드로 숨기지 않는다.
- ServerSettings가 파일·환경변수·범위 검증을 소유한다. application은 외부 설정 형식을 모른다.

사용할 설정값은 [현재 서버 설정](DEVELOPMENT.md#서버-설정)에 있다.
프로세스 교체 테스트는 graceful drain·전원 차단·여러 서버의 동시 파일 소유를 보장하지 않는다.

## 실제 프로세스와 브라우저 검증

2026-09-28. 웹 자산을 선택적으로 JAR에 포함하고 브라우저 fixture를 서버 프로세스 경계로 연결했다.

- API-only 빌드는 Node를 호출하지 않는다. 웹 포함 빌드는 누락된 자산 경로를 오류로 처리한다.
- 실제 Chromium·Connector·PTY로 협업·복구를 검증한다. 서버 내부 함수를 import하지 않는다.
- fixture가 방·프로세스·연결 장애와 자원 정리를 소유하며, 후속 단계에서는 전용 zsh 설정으로 개인 환경 의존도 제거했다.

초기 브라우저 연결 단계의 31개와 후속 전체 38개는 서로 다른 실행이다.
실행 소스와 CI 결과는 [검증 기록](VERIFICATION.md)에서 확인한다.

## 공개 재현과 시연

2026-09-29. 산출물 없는 복사본에서 설치·빌드를 확인하고 CLI 첫 설치 경로 문제를 수정했다.
공개 CI에서 protocol 선행 빌드와 Linux zsh 초기화 의존을 발견해 수정했다.

- [Sprint 1](https://github.com/edonghyun/ttyroom/milestone/1): 공개 CI, 실제 협업 시연, 대표 설계 설명을 완료했다.
- [89초 영상](demo/README.md): 두 브라우저의 제어권 교대와 연결 복구를 녹화했다. 브라우저 단절 시연을 서버 재시작·실제 인터넷 장애 검증으로 확대하지 않는다.
- 프로젝트 소개를 직접 설계·개발한 협업 터미널 중심으로 정리했다. 언어 변경 자체를 주요 성과로 내세우지 않는다.
- 작업 이력을 이 문서로 통합하고 현재 설계·설정·검증 문서와 분리했다. 문서 정리는 제품 동작 변경이나 새 테스트 성과가 아니다.

## Credential 저장

2026-09-29, [T9.1](https://github.com/edonghyun/ttyroom/issues/5).
주체별 credential 모델에 방별 저장 후 확정과 SQLite 복원을 연결했다.

- 첫 내부 모델은 역할·ID·비밀값을 서버에서 발급하고 digest만 보관했다. 초기 6개 RED는 미구현 placeholder 실패였다.
- 저장 없는 내부 진입점에서 발급·취소 실패 계약 2개의 assertion 실패를 확인하고 draft 저장 후 확정으로 구현했다.
- 파일 재열기 5개 중 4개가 credential 누락으로 실패했다. 저장 codec 연결 후 모두 통과했다. 마지막 취소의 빈 상태 1개는 처음부터 통과했다.
- 리뷰에서 동일 digest의 서로 다른 주체를 허용하는 실패 1개를 확인해 거절하도록 보완했다.
- 저장 대기, 반복 취소, 삭제된 방의 재생성 방지와 일반 workspace 저장 시 credential 보존을 검증했다.

Java 전체 380개, 기존 v7 입장·영속성 프로세스 E2E 21개 통과는 이 단계의 실행 결과다.
credential 전용 HTTP·브라우저 인증을 검증한 것은 아니다. 현재 상태·저장 형식·후속 API는
[인증 설계](AUTHENTICATION.md)에 있다. v7의 사칭 문제는 아직 해결되지 않았다.

## 등록 API 권한 경계

2026-09-30, [T9.2](https://github.com/edonghyun/ttyroom/issues/6).
방 생성에 관리 credential을 포함하고, 초대로 participant를·관리 권한으로 host를 등록한다.

- 방 생성의 비밀 응답 계약 1개가 실패한 뒤 한 번의 저장·no-store 응답을 구현했다.
- 등록 테스트 13개 중 기존 방 생성 1개만 통과하고 12개가 실패했다. 미구현 경로의 HTTP 상태
  assertion 실패와 등록 fixture/저장 예외 실패를 구분했다. API 구현 후 모두 통과했다.
- 이후 본문 제한·권한·실패·실제 SQLite 복원 테스트를 보강했다. 보강 테스트는 처음부터
  통과했으며 별도의 RED로 표시하지 않는다.
- 기존 명령 순서 안에서 권한 확인·draft 저장·확정을 실행한다. HTTP는 표현·본문 제한·오류를 소유한다.
- 공통 HTTP 테스트는 공통 필드를 유지하고, 새 관리 응답의 정확한 필드·비밀 분리는 Spring 전용
  프로세스 테스트에서 검증한다. 새 테스트도 CI에 등록했다.

현재 계약은 [HTTP](../protocol/HTTP.md), 실행 범위는 [검증 기록](VERIFICATION.md)을 따른다.
등록 API가 v7 WS 사칭을 해결한 것은 아니며, 다음은 T9.3의 입장 인증이다.

## v8 입장과 연결 교체

2026-09-30, T9.3. [v8 hello](../protocol/AUTHENTICATION_V8.md)는 credential만으로 역할·주체를 결정한다.
미인증 요청은 presence를 만들지 않고 기존 연결을 바꾸지 않는다. 취소와 입장을 같은 방별 명령 순서에
두어, 취소 저장 뒤에 대기한 연결이 취소 전 조회 결과로 들어오지 못하게 했다.

- 파서의 정상 v8 hello 1개 실패, 입장 10개 실패, 설정 6개 실패를 각각 구현 전에 확인했다.
  입장 실패에는 직접 assertion과 미입장으로 인한 fixture 실패가 포함된다. 처음부터 통과한
  추가 필드 거절·후속 경합 검증을 RED로 세지 않는다.
- 최초 구현에서 host welcome을 online으로 기대한 테스트 1개가 실패했다. 기존 inventory 전
  offline·입력 차단 계약에 맞춰 기대값을 고쳤다. 설정 우선순위 테스트는 fixture가 같은 파일을
  덮어쓴 문제를 고쳤다. 두 사례는 제품 결함 수정으로 보고하지 않는다.
- 리뷰에서 v7 hello의 알 수 없는 credential 필드 허용 동작이 바뀐 점을 발견했다. 실패 테스트를
  추가한 뒤 v8 엄격한 필드 검사와 v7 기존 허용 동작을 분리했다.
- 공통 v7 E2E에서는 legacy 형식에 버전 8을 보낸 요청이 bad-message로 처리되어 연결이 남는
  회귀 1개를 찾았다. 파서 실패 테스트를 추가하고 형식 분류 뒤 입장 경계에서 버전을 거절하도록
  고쳤다. 전체 Java와 v7·v8 프로세스 검증을 다시 실행했다.
- 동일 credential 재접속의 lease 유지, 늦은 disconnect·명령·expiry 무효화, welcome 전달 실패 시
  기존 연결 유지와 취소 저장 경합을 검증했다. 경합 fixture는 해당 방의 command lock에 대기한
  스레드를 관찰한다. 기존 저장 테스트와 같이 reflection으로 lock에 접근하는 구현 결합이 있다.
- 실제 JAR의 등록→입장·위조 거절·버전 격리·연결 교체·새 PID의 host credential 복원을 검증했다.
  처음 프로세스 실행 3개 실패는 protocol 디코더 빌드와 테스트를 겹쳐 구버전 산출물을 읽은 문제였다.
  의존성 빌드 완료 후 재실행했고, 최종 JAR는 별도 파일로 고정한 상태에서 검증했다.

공개 CI에서는 기존 Spring 브라우저의 빈 출력 문제가 4개, 재실행에서 3개 사례로 나타났다.
로컬 브라우저 38개·출력 반복 20회는 통과해 환경 문제로 단정하지 않았다. 실패 시 제한된 wire 종류·
순번만 남기는 fixture 진단을 추가했고, 세 번째 CI의 2개 실패에서 출력 seq 1·2가 terminal-opened
알림보다 먼저 도착한 것을 확인했다. 진단 callback의 Playwright overload 타입 오류는 후속 커밋으로 수정했다.

원인은 비동기 생성 확인이 기존 빠른 출력 경로에 추월당하는 경합이었다. 이 수신 경계는 인증 변경 전부터
사용하던 코드다. worker를 수동 진행하는 테스트 2개의 실패로 순서 문제를 재현한 뒤,
생성 확인 중인 터미널의 출력만 기존 bounded inbox에서 순서를 기다리도록 고쳤다. 후속 출력도
대기 중인 출력 전체가 끝날 때까지 같은 순서를 따른다. 다른 터미널의 출력은 직접 처리한다.
종료 시 폐기·큐 상한 2개는 처음부터 통과한 보강 테스트다. timeout 증가나 테스트 재시도로 가리지 않았다.

기본값과 React·Connector는 아직 v7이다. 프로세스 하나는 선택한 버전만 받으며 v8에서 v7 우회 경로는 없다.
T9.4에서 클라이언트와 기본값을 함께 바꾼다. 공개 취소·활성 연결 정리까지 완료한 인증으로 주장하지 않는다.
최종 실행 범위는 [검증 기록](VERIFICATION.md#2026-09-30-v8-입장-t93)을 따른다.

## React·Connector credential 입장

T9.4는 기본 실행을 Spring v8과 맞췄다. React는 HTTP 등록 결과를 탭에 보관하고,
새로고침·재접속 때 재사용한다. 복제된 탭은 로컬 탭 ID 충돌 감지 뒤 credential을 폐기하고
독립 참가자로 등록한다. 로컬 탭 ID는 layout과 탭 구분용이며 WS hello에 보내지 않는다.
방 생성자의 관리 credential은 별도 sessionStorage 키에 두고 Add Host의 등록 헤더에만 사용한다.
초대 링크·명령줄에는 관리·주체 credential을 넣지 않는다.

Connector는 fragment 없는 방 URL과 숨김 stdin에서 받은 Host credential로 접속한다.
프로세스 수명 동안 같은 credential을 사용한다. v7 비교 실행은 E2E 전용 bootstrap으로
기존 Connector 실행 코어를 재사용한다. 제품 CLI에는 연결별 fallback이 없다.
CI의 실제 React·Connector 브라우저 검증은 Spring v8을 대상으로 한다. v7 Node/Spring 공통
프로세스 테스트와 고정 wire fixture는 별도로 유지한다.

### 실패 테스트와 리뷰

- 먼저 기본 버전·v8 hello 파싱 2개, 비밀값 없는 CLI 계약 4개, 서버 기본 설정 1개의 행동 실패를 확인했다.
- 참가자 등록 5개는 새 API 부재로 실패했으며, 세션의 hello 계약 1개도 실패했다. 이를 모두 행동 RED라고 합산하지 않는다.
- 등록 재사용·동시 요청 합치기·실패 후 명시적 재시도·복제 탭 폐기를 구현한 뒤 GREEN을 확인했다.
- stdin 입력·관리 credential 분리·등록 완료 전 dispose·재접속 중단은 구현 후 추가한 회귀 검증이다.
- 브라우저 최초 실행은 40개 통과·1개 실패였다. 기존 명령 문자열 기대값과 별개로 클립보드 거절을
  무시하고 Copied를 표시하던 결함을 발견했다. 별도 실패 테스트 후 성공 시에만 Copied를 표시하도록 수정했다.
- 입장 상태를 여러 boolean에서 `idle/registering/registered/failed`로 정리하고 같은 런타임 테스트를 재실행했다.
- Node 공통 fixture가 명시한 버전 7을 기존 설정 파서가 거절해 준비 실패가 발생했다. 버전 7만 허용하고 8은 거절하는 테스트 후 참조 서버 설정 경계를 맞췄다.
- 날짜별 문서를 추가하지 않고 현재 계약·실행 안내를 갱신했다. 기존 v7 저장 파일은 보존하고 새 경로·새 방으로 시작한다.

HTTP 취소·활성 연결 정리는 T9.5에 남긴다. 실행 결과는 [검증 기록](VERIFICATION.md)에 구분한다.

## 초기 백엔드 기록

백엔드 README와 아키텍처에 누적했던 단계별 기록도 이 문서에 통합했다.
현재 실행·모듈 책임은 [백엔드 안내](../backend/README.md)와 [설계](../backend/ARCHITECTURE.md)를 따른다.
아래 색인의 두 원문은 당시 단계와 비교 과정을 보존하며 현재 구현 목록을 대신하지 않는다.

## 기록 규칙

완료한 작업은 관련 주제에 변경 이유·결과·검증 성격을 짧게 추가한다. 작업마다 날짜 파일을 만들지 않는다.
현재 계약은 해당 설계 문서, 실행 결과는 VERIFICATION, 남은 작업은 GitHub issue와 sprint에 반영한다.
자세한 diff·당시 소스는 커밋으로 연결하고, 로컬 로그·trace는 `artifacts/`에 둔다.

## 원문 색인

통합 직전 커밋에 고정한 원문이다. 아래 링크의 본문과 상대 링크는 당시 저장소 상태로 열린다.
진행 중인 인증 설계의 이전 버전도 포함하며, 현재 설계는 위 AUTHENTICATION을 따른다.

| 작성 시점      | 원문                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-14     | [TTYRoom 백엔드 리팩터링 로드맵](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-08-14-backend-refactoring-roadmap.md)                      |
| 2026-09-18     | [P1: TTYRoom Connector 명칭 변경](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-18-connector-rename.md)                                |
| 2026-09-18     | [TTYRoom Connector 명칭 변경 및 Spring Boot 전환 계획](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-18-connector-spring-boot-plan.md) |
| 2026-09-18     | [P2: 서버 프로세스 기반 E2E와 검증 신뢰성](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-18-e2e-process-boundary.md)                   |
| 2026-09-18     | [Spring 전환 P0: 현재 동작 기준](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-18-migration-baseline.md)                               |
| 2026-09-18     | [TTYRoom Engineering Deep Dive](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-18-ttyroom-interview-portfolio-engineering-review.md)    |
| 2026-09-19     | [독립 디렉터리 구조 정리](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-19-project-layout.md)                                          |
| 2026-09-21     | [대량 replay 예약과 순차 송신 — P3h](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-21-bounded-replay.md)                               |
| 2026-09-21     | [Exclusive 입력 권한·전달 계약 — P3k](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-21-exclusive-input-contract.md)                    |
| 2026-09-21     | [Host 초기 연결과 inventory 이식 계약](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-21-host-inventory-contract.md)                    |
| 2026-09-21     | [Spring 모델링·소프트웨어 설계 리뷰 — P3k 이후](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-21-spring-modeling-review.md)            |
| 2026-09-21     | [터미널 생성·ID 발급 계약 — P3i](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-21-terminal-creation-contract.md)                       |
| 2026-09-21     | [터미널 메타데이터 계약 — P3j](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-21-terminal-metadata-contract.md)                         |
| 2026-09-21     | [Terminal inventory·출력 복구 계약 — P3g](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-21-terminal-recovery-contract.md)              |
| 2026-09-22     | [Java 계층 의존성 자동 검사 — P3r](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-22-java-architecture-tests.md)                        |
| 2026-09-22     | [참여자 focus·cursor 계약 — P3q](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-22-participant-presence-contract.md)                    |
| 2026-09-22     | [영속 저장 경계와 이식 인수 계약 — P3s](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-22-persistence-contract.md)                      |
| 2026-09-22     | [RoomControl 교차 규칙 추출 — P3l](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-22-room-control-refactoring.md)                       |
| 2026-09-22     | [Shared 모드 전환·입력 계약 — P3n](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-22-shared-mode-contract.md)                           |
| 2026-09-22     | [Terminal 종료·resize 계약 — P3o](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-22-terminal-control-contract.md)                       |
| 2026-09-22     | [TerminalWorkspace 생명주기 명시화 — P3m](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-22-terminal-lifecycle-refactoring.md)          |
| 2026-09-22     | [Terminal 제목·창 배치 계약 — P3p](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-22-terminal-view-contract.md)                         |
| 2026-09-24     | [소켓 없는 방 상태 복원 — P3t](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-24-durable-room-model.md)                                 |
| 2026-09-24     | [저장 성공 뒤 상태 확정과 알림 — P3u](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-24-save-boundary.md)                               |
| 2026-09-25     | [TypeScript / Java 백엔드 품질 비교](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-25-node-java-quality-review.md)                     |
| 2026-09-27     | [명령 결과와 live 상태 변경 분리 — P3w](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-27-command-results.md)                           |
| 2026-09-27     | [저장·동시성 테스트의 관찰과 가독성 — P3y](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-27-concurrency-test-conventions.md)           |
| 2026-09-27     | [Host 식별 정보와 terminal 관계 — P3x](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-27-host-identity-invariant.md)                    |
| 2026-09-27     | [방 변경의 저장·commit 경계 — P3v](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-27-room-change-boundary.md)                           |
| 2026-09-28     | [코드·테스트 일괄 정리](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-bulk-code-quality.md)                                         |
| 2026-09-28     | [Connector 생성 실패와 보고 실패의 경계](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-connector-failure-boundary.md)               |
| 2026-09-28     | [만료 예약 계약 정리 — P3z](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-expiry-scheduling.md)                                     |
| 2026-09-28     | [저장 지연 중 lease 반납과 입력 수신 순서 — P4b](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-input-ordering.md)                   |
| 2026-09-28     | [저장 생략 테스트를 행동별로 분리 — P4a](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-persistence-test-scenarios.md)               |
| 2026-09-28     | [저장 성공 후 알림 실패 검토](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-post-commit-delivery.md)                                |
| 2026-09-28     | [운영 코드 책임 경계 검토](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-production-boundaries.md)                                  |
| 2026-09-28     | [RoomAppRuntime 수명주기 검토](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-runtime-lifecycle.md)                                  |
| 2026-09-28     | [설정 파일·환경변수와 정책 적용 — P4e](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-server-settings.md)                            |
| 2026-09-28     | [Spring 정적 웹 제공과 브라우저 E2E — P4f](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-spring-browser-e2e.md)                     |
| 2026-09-28     | [SQLite 부팅 연결과 새 프로세스 복구 — P4d](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-sqlite-startup.md)                        |
| 2026-09-28     | [SQLite 파일 저장의 첫 단계 — P4c](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-28-sqlite-store.md)                                   |
| 2026-09-29     | [인증 경계 보강안: 초대·주체·재접속 증명 분리](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-29-identity-design.md)                    |
| 2026-09-29     | [포트폴리오 준비: 실행 재현·계약 추적·명세 점검](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/docs/2026-09-29-portfolio-readiness.md)              |
| 초기 단계 모음 | [백엔드 설계 이력](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/backend/history/design-notes.md)                                                   |
| 초기 단계 모음 | [백엔드 구현 이력](https://github.com/edonghyun/ttyroom/blob/61aa8b751ab636e1598abd6f8c3f6e211a009ac0/backend/history/implementation-notes.md)                                           |

## credential 취소와 활성 연결 정리

T9.5는 manager가 participant/host ID로 호출하는 DELETE API를 추가했다.
첫 HTTP 테스트는 기존 라우팅의 404 때문에 204 기대값에서 실패했다. 컴파일 실패가 아닌
실제 응답 RED를 확인하고 저장·세션 경계를 구현했다. 이후 저장 실패, 권한 거절,
반복 취소, 늦은 콜백, 전송 실패, 입장·교체와 취소의 순서를 회귀 테스트로 보강했다.

credential 제거와 host identity·터미널 제거는 한 StoredRoom 저장으로 확정한다.
저장 후 state monitor 안에서 권한·workspace·presence를 정리하고 연결 종료를 요청한다.
입장·취소는 기존 방별 명령 큐를 공유하고 저장 중 binary I/O는 확정 상태를 사용한다.
저장 실패는 연결을 끊지 않으며 마지막 멤버 취소도 관리 가능한 방을 삭제하지 않는다.
취소가 이미 실행한 셸 명령을 되돌리거나 로컬 PTY를 종료한다고 주장하지 않는다.

리뷰에서는 역할이 다른 ID로 credential을 취소하지 못하는지, host 저장이 두 번으로
나뉘지 않는지, close의 동기 disconnect가 grace를 다시 만들지 않는지 확인했다.
공유 fixture는 CredentialRoom과 registeredRoom이 자원·입장 준비를 소유한다.
경합 테스트는 저장 gate와 실제 room command lock 대기를 관찰하며 sleep으로 순서를 추정하지 않는다.
실제 JAR E2E에서 취소 후 재시작을, 브라우저에서는 Alice의 취소 뒤 Bob이 같은 PTY의
제어권을 얻어 출력하는 흐름을 검증했다. 실행 수치와 환경은 [검증 기록](VERIFICATION.md)에 둔다.

## HTTP 명세 자동 검증과 문서 UI 선택

T11.1은 Spring HTTP 경로 6개의 OpenAPI 3.1 명세와 실제 응답을 연결했다.
검증기가 필수 no-store 없는 204를 통과시키던 행동을 테스트로 먼저 고정했다.
실제 assertion RED 뒤 헤더 검증을 구현했고, 누락 필드·추가 권한 필드·credential 형식·상태·빈 본문도 검사한다.
기존 서버를 명세에 연결한 테스트는 특성화이며 제품 기능의 RED/GREEN으로 표현하지 않는다.

Markdown의 표시된 응답 예시는 OpenAPI 예시와 같아야 한다. Java에서는 구체적 HTTP 라우트
집합의 양방향 일치를 실제 Spring context에서 검사하고, 저장 실패를 주입해 다섯 작업의 503 응답을 명세와 비교한다.
v8 hello·취소 오류 fixture는 Markdown, TS·Java 코덱, 실제 WebSocket 흐름에서 공유한다.
실시간 권한·경합·재시작의 의미는 기존 행동 테스트가 계속 검증한다.

리뷰 후 중복 오류 응답을 OpenAPI components로 모으고, Java 명세 조회를 자원을 소유하는
테스트 fixture로 정리했다. TS 검증기는 상태·본문을 받아 위반 사항을 반환하며 실제 비밀값을 진단에 출력하지 않는다.
Java test resource를 추가하는 최초 Gradle 설정은 다중 인자와 closure 오버로드 때문에 자기 의존으로 실패했다.
파일 목록을 하나의 인자로 넘겨 수정했다. 이 준비 실패는 행동 RED와 구분한다.

[HTTP 문서](../protocol/HTTP.md#openapi와-문서-ui-선택)에 Markdown 단독, OpenAPI 병행,
annotation 생성, 문서 UI의 비용을 비교했다. OpenAPI는 채택하고 별도 사이트·Swagger UI는 보류한다.
검토자는 기존 문서 안내에서 설계·실행·계약을 찾도록 하고, 외부 API 독자의 검색·샘플 실행 문제가
반복되면 UI를 다시 검토한다. 제품 실행 코드는 바꾸지 않았고 추가 의존성은 E2E 개발 전용이다.

## 성능 기준선과 수신 버퍼

T10.1. 먼저 [측정 계획](PERFORMANCE.md)에 부하·성공 기준·관찰 범위·반복 횟수를 고정했다.
실제 Spring·SQLite·Connector·PTY·브라우저 경로와 latch로 막은 송신 어댑터 실험을 분리했다.
실패한 시간이 보고서에서 누락되는 테스트를 RED로 확인하고 원시 실패를 남기도록 수정했다.

첫 512 MiB 실행에서 heap OOM을 발견했다. 서버가 논리 메시지 한도를 Tomcat 수신 버퍼 크기로도
설정한 것이 원인이었다. 실제 라이브러리 bytecode와 오류 stack을 확인했다. 메시지 한도를 낮추는 대신
작은 transport buffer와 연결별 조립을 분리했다. 분할 hello가 입장하지 못하는 RED 뒤 구현했으며,
추가 경계 테스트는 회귀 검증이다. 저장·방 명령 순서·송신 큐는 변경하지 않았다.

같은 2 GiB 조건에서 전후를 반복했고, 수정 전 초기 비교에 Java 검증이 겹쳐 불변 JAR로
추가 3회 재측정했다. 작은 heap도 수정 후 재검증했다. history 준비에서 insertText 뒤 실행 표식을
관찰하지 못한 하네스 실패는 기존 type/Enter 동작으로 고쳤고 제품 실패와 구분했다.
모든 비교·실패 원본은 [공개 JSON](performance/baseline.json), 전체 로그와 JAR는 로컬 artifacts에 둔다.

리뷰에서는 fixture가 자원을 정리하고, 실패·warmup·입력·replay를 분리하며, RSS와 시간의 관찰 시점을
같은 monotonic clock으로 남기도록 정리했다. 통계는 nearest-rank와 실패 개수를 함께 보여준다.
성능 수치는 CI gate로 쓰지 않고, 작은 heap의 실제 인증 계약을 CI에 추가했다.
범위와 검사 결과는 [검증 기록](VERIFICATION.md#2026-09-30-성능-측정과-수신-버퍼-t101)을 따른다.

## 수신 자원 한도와 참가자 부하

T10.2 ([작업 #12](https://github.com/edonghyun/ttyroom/issues/12)). 작은 transport 버퍼만으로는
메시지/대기열 100 MiB 한도와 미완성 메시지의 무기한 점유가 해결되지 않았다. text는 UTF-8
256 KiB, control inbox는 in-flight 포함 1 MiB·256개로 줄였다. JSON을 파싱하기 전에 조각별
UTF-8 바이트를 누적하며, surrogate pair가 callback 사이에서 나뉘어도 같은 길이로 계산한다.

첫 partial callback부터 5초 기한을 소유하는 곳은 `IncomingMessages`다. 후속 조각으로
기한을 연장하지 않으며 완료·초과·종료 시 버퍼와 timer를 해제한다. 취소와 경합한 옛 timer는
다음 메시지를 닫을 수 없다. 만료 callback은 조립 monitor 밖에서 sender를 중단하며,
실제 disconnect/transport close는 기존 sender의 별도 virtual thread가 맡는다.

UTF-8 초과를 놓치는 assertion 실패를 먼저 확인했다. 실제 수정 전 JAR에서도 과대 text와
미완성 text/binary 연결 격리 4개가 모두 종료 대기 timeout으로 실패했다. 수정 후 동일 사례와
정상 참가자 요청, 정확히 256 KiB인 hello가 통과했다. timer 경합과 inbox 배선은 추가 회귀 테스트다.
모든 추가 테스트가 구현보다 먼저 작성되었다고 주장하지 않는다.

성능 profile에 참가자 1·5·10명과 모든 DOM 관찰, 동시 reload를 추가했다. 실패 시 더 높은
부하로 계속 진행하지 않으며 최대 heap 512 MiB·각 3회 새 서버로 실행했다.
[측정 계획·결과](PERFORMANCE.md)는 한 장비의 짧은 fanout 검증과 운영 최대 수용량을 구분한다.
