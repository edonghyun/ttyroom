# SQLite 파일 저장의 첫 단계 — P4c

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-28. `RoomStore`의 SQLite 구현을 추가했다. 실제 파일에 방의 내구 상태를 저장하고, 연결과
`RoomDirectory`를 다시 만들어도 읽을 수 있다. **Spring 부팅 설정에는 아직 연결하지 않았다.**
현재 기본 실행은 메모리 모드이며, `TTYROOM_STATE_PATH`와 새 서버 PID의 복구 인수는 다음 단계다.

## 저장 경계와 설계

- `SqliteRoomStore`는 JDBC 연결, 디렉터리 생성, 테이블 생성, prepared statement, SQL 실패와 close를
  소유한다. 별도 Repository/UnitOfWork/JPA 계층은 추가하지 않았다.
- `StoredRoomJson`은 schemaVersion=1의 저장 표현·검증·기본값을 소유한다. domain/application에
  JDBC/Jackson annotation을 넣거나 WebSocket의 JSON mapper를 재사용하지 않는다.
- 기존 Node와 같은 `rooms(room_id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT`를 사용한다.
  방 하나의 저장은 단일 UPSERT statement로 교체한다. SQL 실패를 성공으로 바꾸지 않는다.
- 한 JDBC 연결의 호출과 close는 동기화한다. 이는 저장소 내부의 직렬화이며 방 명령의 접수·순서와
  save → commit → effects는 기존 `RoomDirectory`가 계속 소유한다. JDBC I/O 중 방 상태 monitor를
  잡도록 바꾸지 않았다. 단일 연결이 동시에 여러 DB 쓰기를 수행한다고 주장하지 않는다.
- Node와 같은 5초 busy timeout을 설정했다. 메모리 상태·소켓 알림까지 SQL 트랜잭션으로 묶었다는
  의미가 아니다. 파일을 Node와 Java가 동시에 열어 운영하는 구성도 지원 완료로 취급하지 않는다.
- JDBC 드라이버는 확인한 [Xerial 3.53.4.0 릴리스](https://github.com/xerial/sqlite-jdbc/releases/tag/3.53.4.0)를
  runtime 의존성으로 고정했다. Spring 부팅 의존성에는 이미 Jackson이 있어 별도 JSON 라이브러리는 없다.

## 보존하는 레코드

방 ID·이름·token digest, host 식별 정보, terminal의 생성 대기/실행/종료 상태, runtimeId, next ID,
제목·geometry·mode·exitCode·metadata를 보존한다. 원문 token이나 lease·연결·출력 history를 추가로
저장하지 않는다. 이 범위는 기존 application의 불변 저장 투영을 따른다.

Node 구현으로 생성하고 기존 Zod 저장 schema로 검증한 JSON fixture를 Java 테스트 리소스에 뒀다.
Java가 만든 JSON의 version envelope와 소문자 enum 표현도 SQL row에서 확인한다. 이전 v1 레코드에서
geometry가 **누락된 경우만** `(24, 24, 640, 420)`을 적용한다. 손상된 JSON·미지원 버전·잘못된 geometry는
빈 방으로 바꾸거나 조용히 건너뛰지 않고 실패시킨다. parser 오류에 저장 원문이 포함될 수 있어
레코드 해석 실패의 공개 메시지는 원문·digest·metadata를 담지 않는다.

## 실제 변경 순서

| 순환                     | RED                                                                       | GREEN                                  |
| ------------------------ | ------------------------------------------------------------------------- | -------------------------------------- |
| 1. 파일을 다시 열어 복원 | 새 포트 구현의 컴파일 가능한 skeleton에서 load 결과가 비어 assertion 실패 | JDBC 저장/조회와 v1 codec 구현 후 복원 |
| 2. 삭제 후 재열기        | 미구현 delete의 `UnsupportedOperationException`                           | 해당 room ID만 삭제하는 SQL 구현       |
| 3. Node 이전 레코드      | geometry 누락 fixture의 load가 거절됨                                     | 누락 필드에만 이전 기본값 적용         |
| 4. 저장 값 검증          | 음수 width 레코드가 그대로 허용되어 assertion 실패                        | codec의 값 범위 검증 후 거절           |

컴파일 오류를 RED로 세지 않았다. 삭제·이전 형식의 RED는 해당 행동이 미구현이라 발생한 예외이며,
복원·값 검증의 RED는 실제 assertion 실패다. 그 외 추가 검증은 이미 구현된 동작의 회귀 테스트다.
fixture는 준비와 파일 주입을 맡고, 본문은 저장·재열기·결과 검증을 구분한다. 테스트마다 별도 임시
디렉터리를 사용하며 결과를 다른 테스트의 전제로 삼지 않는다.

## 검증한 실패와 한계

- 동일 ID 저장이 새 row를 만들지 않고 교체되며, 다시 열어도 최신 값이 남는다.
- SQLite trigger가 UPDATE를 ABORT하도록 하여 실패를 주입했다. 이전 row가 남고 trigger 제거 후
  재시도가 성공한다. 실제 디스크 부족·강제 전원 차단을 재현한 테스트는 아니다.
- 삭제된 방은 재열기 후 나타나지 않고 다른 방은 보존된다. 없는 ID의 반복 삭제도 허용한다.
- 잘못된 값을 저장하려는 시도는 기존 row를 바꾸지 않는다.
- close 이후 load/save/delete는 거절하고 반복 close는 허용한다.
- 새 `RoomDirectory`가 같은 파일에서 읽은 digest로 기존 초대를 인증한다. 같은 JVM에서 객체와
  연결을 다시 만든 검증이며, 새 서버 프로세스 인수와 구별한다.

실행 근거는 `artifacts/migration-baseline/p4c-sqlite-store/`에 둔다. 별도의 Node/Java 파일 교차 실행은
어댑터 호환성을 확인하는 실험이며, Java CI의 정규 테스트는 Node 도구 없이 실행된다.

## 최종 실행 결과

- SQLite 파일 테스트 **15개**를 포함해 Java 전체 **306개** 통과. 실패·오류·건너뜀 0, `bootJar` 성공.
- 최종 JAR의 기존 공통 E2E **168개 / 12개 파일** 통과. 아직 메모리 모드에서 실행되는 회귀 검증이며
  SQLite를 켠 서버 재시작 인수는 아니다.
- 실제 같은 SQLite 파일에서 **Java 저장 → Node 읽기·수정 → Java 재열기** 교차 검증 통과.
  Node의 저장 schema 검증과 전체 fixture 값 비교를 포함하며, 양쪽 연결은 순차적으로 닫았다.
- Java·문서·fixture 포맷 검사 통과. 최종 소스·테스트·fixture·JAR hash를 기록했다.

교차 검증의 첫 도구 실행은 `tsx`가 worker 함수에 주입한 `__name` 때문에 실패했다.
이는 SQLite 계약 실패와 분리하여 `exchange-tsx-harness-failure.log`에 남겼다. 기존 Node 코드를 `tsc`로
빌드한 뒤 일반 Node 실행으로 검증했으며, 도구 문제를 이유로 production 소스를 바꾸지 않았다.

후속 P4d에서 [환경변수 선택과 새 프로세스 복구](2026-09-28-sqlite-startup.md)를 연결했다.
위 메모리 모드와 미연결 설명은 P4c 당시의 검증 범위다.
