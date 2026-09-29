# RoomControl 교차 규칙 추출 — P3l

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-22. [모델링 리뷰](2026-09-21-spring-modeling-review.md)의 첫 번째 개선을 구현했다.
공개 동작을 보존하는 준비 리팩터링이며 shared 모드, 참여자 close/resize, 영속성은 추가하지 않았다.

## 문제와 변경

RoomSessions가 TerminalWorkspace와 LeaseControl을 각각 보유해 열린 exclusive terminal 확인 후
lease 획득, 입력 거절 순서, host 만료 시 terminal/lease 정리를 직접 조합했다.
새 제거·모드 변경 경로를 구현할 때 이 관계를 application에서 계속 기억해야 했다.

RoomControl이 두 모델을 private 협력자로 소유한다. application은 불변 terminal/lease snapshot과
의미 있는 연산만 사용한다. mutable workspace/lease getter를 제공하지 않는다.

- `acquireLease`: terminal 존재·OPEN·EXCLUSIVE를 확인한 뒤 획득한다. 유효하지 않은 대상은
  기존 보유 lease를 해제하거나 새 ID를 소비하지 않는다. host 연결/입력 허용 여부와는 독립이다.
- `inputRejection`: terminal/연결 → host 입력 허용 → 제어권 순서로 거절 사유를 결정한다.
  허용은 빈 Optional이다. 입력 seq나 bytes, 전송·재시도는 모델이 알지 못한다.
- `removeHost`: host의 열린/종료된 terminal과 그 lease를 함께 제거한다. 반환한 ID로
  application이 출력 history를 정리한다. 다른 host의 terminal/lease는 유지한다.
- terminal 종료·inventory 유실은 lease를 해제하지 않는다. 명시적인 반납이나 멤버 제거로 수명을 끝낸다.

RoomSessions는 인증된 현재 세션, 방 잠금, 연결 교체, 유예 타이머, 전송과 알림 순서를 계속 소유한다.
단절·만료 및 입력 송신 실패의 효과 순서는 변경하지 않았다. 공유 저장이나 별도 잠금을 도입하지 않았다.

## 연결 상태의 소유권

InputHost는 현재 Member의 host ID·연결 여부·보고된 입력 허용 값을 복사한 일시적인 입력이다.
RoomControl은 이를 저장하지 않는다. lookup → 판단 → enqueue는 모두 기존 방 monitor 안에서 실행된다.
따라서 연결 상태를 domain/application에 따로 저장하거나 판단 후 잠금을 풀어 전송하는 구조가 아니다.
다른 host의 허용 정보로 잘못 판단하지 않도록 모델이 terminal 소유 host ID도 확인한다.

화면의 online 상태는 입력 조건에 넣지 않았다. inventory 이전에도 현재 연결이 허용을 보고하면
기존 제어권으로 입력할 수 있다. 생성 예약은 여전히 wire에서 OPEN이며 실제 PTY 확인을 뜻하지 않는다.

InputRejection은 application의 RoomNotice에서 domain의 RoomControl로 옮겼다.
RoomNotice.LeaseInvalid는 이 도메인 결과를 담고 기존 RoomProtocol의 exhaustive switch가 wire로 바꾼다.
프로토콜 필드·거절 문자열은 변경하지 않았다.

## 설계 리뷰

- 새 경계는 단순 위임 facade로 끝나지 않는다. 호출자가 조합하던 세 가지 교차 규칙을 소유하고
  workspace/leases에 대한 직접 변경 경로를 없앴다. 단일 모델 내 동작은 내부 협력자에게 위임한다.
- 전체 Room aggregate가 완성됐다고 보지 않는다. 참여자 인증/존재와 host 연결·표시는 세션 계층이 소유한다.
  RoomControl의 호출자는 인증된 참여자와 잠금 아래 최신 연결 정보를 제공해야 한다.
- 지금은 작고 명시적인 조건문이면 충분하다. Strategy/State 클래스 계층, 이벤트 버스와 저장 계층을 추가하지 않았다.
- 향후 shared 모드에서는 획득 조건과 입력 허용을 이 모델 안에서 함께 변경할 수 있다.
  terminal 내부 lifecycle 표현 개선과 Java 계층 자동 검사는 별도 후속 작업이다.

## 검증

- 변경 전 Java 118개 통과. 규칙 이동 직후 기존 118개도 그대로 통과했다.
- 새 도메인 시나리오 14개: 유효하지 않은 획득의 기존 lease 보존, 예약 상태 입력,
  입력 거절 우선순위/다른 host 차단, 종료·inventory 유실의 lease 보존,
  host 제거 시 terminal/lease 동시 정리, 참여자 제거의 범위.
- 테스트는 독립 fixture → 행동 → 결과 순서이며 도메인 fixture는 transport/wire를 알지 못한다.
  기존 application/adapter 테스트는 InputRejection import만 바꿨으며 기대 결과는 그대로다.
- 최종 Java 132개 통과, JAR 빌드와 변경 Java 포맷 검사 통과.
- jdeps 결과 domain → JDK, application → domain/JDK. Spring/Jackson/adapter 역방향 의존 없음.
- 실제 Spring JAR 공통 계약 **111개 / 8개 파일 통과**. HTTP·입장·host·terminal 복구/생성/메타데이터·
  fixture·exclusive 입력을 검증했으며 실제 Connector의 PTY 셸 실행도 포함한다.
  빌드를 완료한 JAR로 실행했고 E2E 중에는 해당 JAR을 다시 빌드하지 않았다.

근거: `artifacts/migration-baseline/p3l-room-control/`의 before/src snapshot,
java-before.log, java-extraction.log, gradle.log, java-contract.log, jdeps.log, java-format.log.
기존 Node 구현과 E2E 코드는 수정하지 않았다. 브라우저 전체 협업, 부하/장시간 실행,
영속 복구와 분산 환경은 이번 검증 범위가 아니다.
