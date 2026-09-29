# SQLite 부팅 연결과 새 프로세스 복구 — P4d

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-28. Spring 진입점이 `TTYROOM_STATE_PATH`를 읽어 SQLite 저장소를 선택한다.
설정이 없거나 빈 문자열이면 기존 메모리 모드를 유지한다. 경로가 있으면 부모 디렉터리를 만들고
저장된 모든 방을 읽은 뒤 readiness를 알린다. 상대 경로는 프로세스 실행 디렉터리 기준이다.
Node의 기본 SQLite 경로와 Spring의 기본 메모리 모드는 아직 다르다.

## 책임과 실패 의미

변경은 composition root의 저장소 선택에 국한한다. 별도 설정 서비스나 저장소 팩토리 계층을 만들지
않았다. `RoomDirectory`가 load·복원·저장소 수명과 save → commit → effects를 계속 소유한다.
`SqliteRoomStore`는 파일/JDBC를, `StoredRoomJson`은 저장 표현을 맡는다. 저장소를 별도 Spring bean으로
중복 등록하지 않아 수명 소유자를 늘리지 않았다. application/domain에는 Spring 의존성을 추가하지 않는다.

파일을 열 수 없거나 레코드가 손상됐다면 시작을 실패시킨다. 손상된 방을 건너뛰거나 메모리 저장소로
대체하지 않는다. RoomDirectory 생성 실패 시 저장소를 닫는 기존 경계를 그대로 사용한다.
이전 정상 저장 상태를 손상시키는 복구나 자동 초기화는 하지 않는다.

## 테스트와 실제 변경 순서

1. 기존 `persistence.e2e.ts`를 변경 전 JAR에 실행했다. 네 사례 모두 새 프로세스에서 기존 초대로
   입장할 때 welcome 대신 error를 받아 실패했다. 컴파일/실행기 오류가 아닌 재시작 행동의 RED다.
2. `RoomStoreStartupTests`에 새 애플리케이션의 초대 복원, 메모리 모드의 소멸, 잘못된 경로와 손상
   레코드의 시작 실패를 추가했다. 네 테스트 중 메모리 모드만 통과했고 나머지 세 assertion이 실패했다.
3. 진입점에 저장소 선택을 연결한 뒤 네 Java 사례와 재시작 E2E 네 사례가 통과했다.
4. 전체 Java와 SQLite 모드의 공통 프로세스 계약, 실제 Connector PTY 유지 사례를 검증했다.

부팅 테스트는 임시 디렉터리와 실제 Spring context를 만들고 try-with-resources로 종료한다. fixture는
포트·설정 주입만 숨기며, 생성/종료/재시작과 관찰값 수집은 본문에 남긴다. 실패 사례는 readiness가
출력되지 않는지도 확인한다. 테스트 간 상태를 공유하거나 앞선 테스트 성공에 의존하지 않는다.

실제 Connector 사례는 기존 구현된 계약에 대한 추가 검증이다. 이번에 새로 작성한 RED 테스트처럼
표현하지 않는다. E2E 제목만 Node·Spring 공통 계약으로 바꾸고 기존 행동과 기대값은 유지했다.

## 검증 범위

- Java 전체 **310개**, 실패·오류·건너뜀 0. 기존 306개에 부팅 계약 4개를 추가했다. JAR 빌드 성공.
- SQLite 모드의 기존 공통 E2E **168개 / 12개 파일** 통과.
- 새 PID 영속 복구 E2E **4개 통과**: 초대·workspace·runtime·다음 ID 복원, 연결/lease/focus/출력 초기화,
  runtime 충돌 조정과 확인 전 생성 예약 보존.
- 실제 Connector 재시작 시나리오 **1개 통과**: 같은 PTY의 셸 환경변수 유지, 저장된 제목/geometry,
  새 lease 획득, 단절 중 출력 replay. resilience 파일의 다른 4개는 선택 실행에서 제외했다.
- Java 전용 CI는 유지하고 별도 Spring 프로세스 계약 job을 추가했다. 위 공통 172개와 Connector
  재시작 1개를 대상으로 한다. CI 정의 추가와 원격 CI 실행 성공은 구별한다.

실행 로그·RED 당시 코드·최종 파일 hash는 `artifacts/migration-baseline/p4d-sqlite-startup/`에 보관한다.

## 남은 경계

`TTYROOM_CONFIG_PATH`의 정책 override와 웹 정적 파일 제공은 아직 이식하지 않았다. 전체 resilience와
브라우저 E2E 통과를 주장하지 않는다. 다음 설정 이식은 기본값·우선순위·잘못된 입력 계약부터 고정한다.

재시작 실행기는 SIGTERM 후 250ms 내 종료하지 않으면 SIGKILL을 보낸다. 따라서 이 결과는 새 프로세스
복구 검증이며 graceful drain의 보장은 아니다. Connector 프로세스가 살아 있어야 같은 PTY와 단절 중
출력을 복구할 수 있다. 서버가 출력 history를 SQLite에 저장하는 것은 아니다. 전원 차단·디스크 부족·
여러 서버의 동시 파일 소유·운영 배포는 이번 검증 범위에 포함하지 않는다.

후속 P4e에서 [설정 파일·정책 적용](2026-09-28-server-settings.md)을 연결했다. 위 policy 미지원과
resilience 부분 실행 설명은 P4d 당시 범위이며 P4e에서 전체 resilience 5개를 검증한다.
