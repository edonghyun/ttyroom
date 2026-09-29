# 소켓 없는 방 상태 복원 — P3t

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-24. [영속 저장 계약](2026-09-22-persistence-contract.md)의 첫 단계인
불변 내구 상태 모델과 복원을 구현했다. **디스크 저장·부팅 시 DB 로딩·프로세스 재시작 복구는 아직 미구현이다.**

## 상태의 소유 위치

```text
RoomDirectory.Room
  ├─ 방 ID·이름·초대 digest
  └─ RoomControl
       ├─ host ID·이름
       ├─ TerminalWorkspace: view·runtime·nextTerminalId
       └─ LeaseControl: live 상태, 저장 투영에서 제외

RoomSessions.Presence → 위 RoomControl을 참조
  ├─ Member: Peer·연결·입력 허용·focus·만료 타이머
  └─ TerminalOutput: 출력 history·seq
```

이전에는 Presence가 새 RoomControl을 만들고 host 식별 정보도 Member에서만 찾았다.
이제 RoomDirectory가 방마다 하나의 모델을 소유하고, 세션이 그 모델을 사용한다.
저장된 host는 소켓이나 가짜 Peer 없이 Welcome에 offline/입력 차단 상태로 표시된다.
현재 연결이 있으면 해당 Member의 상태로 표시하고, 정상 입장한 host의 이름은 내구 모델에도 반영한다.
Welcome 송신 실패는 후보 Member를 되돌리며 기존 host 이름과 terminal 상태를 변경하지 않는다.
현재의 입장 확정 순서는 유지했고, 저장 성공 전 효과를 차단하는 순서는 다음 단계에서 도입한다.

## 복원 계약

- `TerminalWorkspace.DurableState`는 next ID와 `StoredTerminal(view, runtimeId)`의 불변 목록이다.
  생성 대기는 OPEN/null, 실행 중은 OPEN/runtime, 종료는 EXITED/null과 종료 코드로 표현한다.
  복원 시 기존 Pending/Running/Exited 모델로 돌아가며, 별도의 상태 머신을 추가하지 않았다.
- 제목·geometry·mode·metadata·종료 코드와 runtime을 보존한다. 복원 후에도 pending은 첫 runtime을
  받아들이고, running은 일치 여부를 검사하며, exited는 inventory로 다시 열리지 않는다.
- next ID는 삭제된 terminal에서 재계산하지 않는다. u32 소진 값 `4294967296`도 보존한다.
  서버가 새로 발급하는 ID는 1부터지만, 기존 inventory/저장 계약이 허용하는 ID 0도 복원한다.
- `RoomControl.DurableState`는 host 식별 정보와 workspace를 묶는다. 복원하면 lease와 lease ID 발급은
  처음부터 시작한다. 명시적 terminal-opened 확인 이력도 재시작 시 초기화한다.
- `RoomDirectory.StoredRoom`은 ID·이름·SHA-256 digest와 위 상태를 하나의 값으로 묶는다.
  token 원문을 포함하지 않으며 digest는 불변 문자열이다. 생성자 복원은 admission 시작 전 사용한다.
  실행 중 투영을 만들 때는 기존 Presence monitor와 같은 직렬화 경계를 사용해야 한다.
  아직 외부에서 실행 중인 전체 방을 동시 저장하는 API는 제공하지 않는다.
- 새 세션은 참여자·focus·lease·출력 history·seq·타이머를 가져오지 않는다. 복원된 offline host는
  연결된 Member로 취급하지 않아, 마지막 참여자 만료 시 빈 방 삭제를 막지 않는다.
- 모든 목록은 복사해 저장 값, 원래 모델, 두 복원 모델 사이의 가변 상태 공유를 막는다.
  중복 방/host/terminal, ID 역행, 모순된 lifecycle은 조용히 덮어쓰거나 보정하지 않고 거부한다.

내구 값은 DB 레코드 JSON 그 자체가 아니다. schemaVersion·JSON 필드명·geometry 기본값·JDBC와
저장 JSON 검증은 이후 adapter에서 담당한다. 현재 검증은 모델 불변식이며 기존 Node schema 전체를
이식했다는 뜻은 아니다. 정상 생성된 Node 상태의 보존을 목표로 하며, 외부에서 조작한 모순된 레코드를
그대로 재현하는 계약은 추가하지 않았다.

## 검증과 리뷰

- 신규 `DurableRoomControlTests` 11개: lifecycle별 복원, runtime 대조, ID 보존/소진/0,
  lease 초기화, 불변 값과 복원 인스턴스 격리, 모순된 상태 거부.
- `RoomDirectoryTests`에 3개 추가: 동일 초대 인증, digest 검증, 중복 room 거부.
- `RoomSessionsTests`에 5개 추가: 실제 Welcome의 복원/초기화, live 변경의 저장 투영 불변,
  실패한 host 입장 보존, host 재연결/만료, 복원된 offline host와 빈 방 만료.
- 준비 fixture는 상태를 만들고, 행동 후 결과를 모아 검증한다. 테스트끼리 실행 순서나 상태를 공유하지 않는다.
- 모델 API가 없을 때 컴파일 RED를 확인했고, 모델 구현 뒤에는 실제 입장 경로가 복원 terminal을
  잃는 동작 RED를 확인한 후 연결했다. 둘을 같은 종류의 실패 증거로 취급하지 않는다.
- Java 전체 **236개**, `bootJar`, 계층 의존성 검사 5개를 포함해 통과했다. Java formatter도 통과했다.
- 실제 Spring JAR의 기존 HTTP/WebSocket/Connector 공통 계약 **168개 / 12개 파일**이 통과했다.
  새 디스크 재시작 계약이 통과했다는 뜻은 아니다.

리뷰 결과, 연결·입력 허용을 내구 모델에 중복 저장하거나 terminal 상태를 세션에서 재구성하는 경로를
추가하지 않았다. 새 저장 프레임워크/포트/큐는 아직 없으며 기존 방 monitor도 하나다.
`RoomControl.restore`는 **재시작 복원** API다. live lease를 보존해야 하는 저장 draft 복제 용도로
재사용하면 안 된다. 다음 단계에서는 live 제어 상태를 함께 보존하는 draft/commit 경계가 필요하다.

실행 근거: `artifacts/migration-baseline/p3t-durable-model/`의 `model-red.log`, `session-red.log`,
`java.log`, `spring-e2e.log`, 변경 전 제품 코드와 `production.diff`.
Node 제품/테스트 코드는 이번에 수정하지 않았다. 신규 persistence.e2e의 Spring 프로세스 재시작 계약은
아직 지원 완료 목록에 넣지 않는다.

## 다음 작업

후속 구현: [저장 조정 경계 P3u](2026-09-24-save-boundary.md). 저장 성공 후 Welcome 송신이 실패한 경우의
내구 식별 정보 보존 계약은 이 후속 문서가 본문의 P3t 시점 동작을 대체한다.

저장 조정 경계: 방별 제어 명령을 직렬화하고 **draft → save → commit → effects**를 구현한다.
저장 대기는 Presence monitor 밖에서 처리하고, 실패·동시 연결 교체·만료·종료 drain을 대역 저장소로
검증한다. 이미 저장한 결과를 세션 단절만으로 메모리에서 버리지 않으며, live 상태를 과거 snapshot으로
통째로 덮지 않는다. SQLite 파일 호환과 실제 재시작 E2E는 그 다음 단계다.
