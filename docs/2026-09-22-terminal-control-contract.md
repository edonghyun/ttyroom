# Terminal 종료·resize 계약 — P3o

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-22. [Shared 모드 이식](2026-09-22-shared-mode-contract.md) 다음 단계로 참여자의
close-terminal-request와 resize-request를 Spring에 추가했다. 기존 v7 명령과 응답을 유지한다.

## Node 기준과 동작

근거는 `legacy/node-server/src/usecases/open-terminal.ts`의 requestClose, `resize-terminal.ts`,
`control-plane.ts`, `protocol/src/messages.ts`다. Connector도 close/resize를 Kill Switch로 막지 않는다.

| 조건                                         | 종료 요청                                              | resize 요청             |
| -------------------------------------------- | ------------------------------------------------------ | ----------------------- |
| 현재 참여자, 열린 terminal, 연결된 소유 host | close-terminal 전달                                    | resize 전달             |
| 제어권 없음 / shared / 입력 차단 중          | 허용                                                   | 허용                    |
| 생성 예약 또는 host inventory 이전           | 기존 OPEN 계약대로 허용                                | 기존 OPEN 계약대로 허용 |
| 대상 없음                                    | terminal-request-rejected / close / terminal-not-found | error / bad-message     |
| 종료된 대상                                  | terminal-request-rejected / close / terminal-not-open  | error / bad-message     |
| 소유 host 단절                               | terminal-request-rejected / close / host-offline       | error / bad-message     |
| host 역할, hello 전 또는 잘못된 필드         | bad-message                                            | bad-message             |

종료 요청 수락은 PTY 종료 완료가 아니다. 요청 시 snapshot·lease를 바꾸지 않으며 host의 terminal-closed
보고에서만 기존 종료 처리를 한다. host 보고 전 반복 close 요청도 Node처럼 재전달한다.
종료 보고 후 lease를 유지하는 기존 수명 정책 역시 바꾸지 않았다.

resize는 cols/rows 각각 **1..65535 정수**를 그대로 전달한다. terminalId는 unsigned 32-bit다.
누락·문자열·소수·0·상한 초과를 adapter에서 거절한다. resize는 PTY 행/열을 바꾸는 요청이며
workspace의 창 geometry나 저장 상태를 수정하지 않는다. 별도 완료 응답도 없다.

## 모델링·리팩터링 리뷰

모드/close/resize에서 동일한 대상 규칙이 필요해 RoomControl의 terminalRequestRejection으로
모았다. terminal 존재 → OPEN → 현재 소유 host 연결 순서로 판단한다. ModeRejection은 공통 의미에
맞게 TerminalRejection으로 바꿨다. 모드 변경도 같은 규칙을 재사용하며 wire 거절 문자열은 그대로다.
이 준비 리팩터링만 적용한 상태에서 기존 Java 158개 통과를 확인한 뒤 기능을 추가했다.

RoomSessions는 인증된 현재 세션, host 조회, 같은 방 monitor 안에서 판단과 enqueue를 수행한다.
도메인은 socket·타이머·cols/rows 전송 형식이나 wire 응답을 알지 않는다. RoomProtocol은 명령의
범위 검증과 ResizeTerminal/TerminalCloseRejected 결과를 wire로 바꾸며 enum 변환은 exhaustive다.

두 명령의 전송 실패는 sendTerminalCommand가 처리한다. 큐 거절 등 예상된 PeerUnavailable이면
해당 host를 offline/유예 처리하고 닫는다. close 요청자에게 host-offline, resize 요청자에게 bad-message를
알린다. 명령이 실행됐을 가능성이 있어 자동 재시도하지 않고 terminal·lease는 유지한다.
이후 host 보고/inventory가 상태를 조정한다. 예기치 않은 인코딩/프로그래밍 예외는 숨기지 않는다.
이 세부 실패 격리 정책은 Spring의 Java 테스트로 검증했으며 Node 내부 실패 처리까지 같다고 주장하지 않는다.

새 정책 클래스, 이벤트 버스, 별도 잠금이나 ClosePending 상태를 도입하지 않았다.
close·resize는 상태 변경을 확정하는 명령이 아니므로 전달 시점에 도메인 생명주기를 바꾸지 않는다.

## 테스트와 검증

공통 `terminal-control.e2e.ts`는 15개 시나리오다. 종료 보고 전 상태/lease 유지, 반복 요청,
exclusive/shared의 비소유자·Kill Switch, 치수 경계와 geometry 보존, 예약/교체 연결의 inventory 이전 전달,
거절 사유, malformed/역할/hello 검사, 소유 host 라우팅과 방 격리를 검증한다.
실제 Connector에서는 같은 참여자 연결로 resize 다음 셸 명령을 보내 `stty size`의 **37 101**을 확인하고,
출력 완료 뒤 다른 참여자가 close를 요청해 host 종료 보고까지 기다린다. 명령 echo만으로 통과하지 않는다.

테스트 클라이언트의 requestResize는 전송 요청만 하고 완료를 가장하지 않는다.
실제 적용 여부는 셸 출력으로 확인하고 closeTerminal은 종료 이벤트를 기다린다.
무응답 확인은 같은 요청자 소켓의 후속 invalid lease 응답으로 순서를 확인한다. 임의 sleep이나
입력 허용을 바꾸는 barrier를 사용하지 않는다. snapshot 관찰자는 fixture의 자원 정리 범위 안에 있다.

- 최초 Node 공통 계약 12개 통과. 이후 shared/소유 host/방 격리를 보강했다.
- 기존 Spring JAR에서 missing terminal close의 typed 응답 대신 bad-message가 오는 실패를 재현했다.
- 최종 Java **177개 통과**: 오래된 참여자 세션 차단, 전송 실패의 상태 보존/host 격리/재시도 없음,
  예상 밖 예외 전파, 도메인 검사 무변경, uint32/u16 경계와 malformed 명령을 포함한다.
- JAR 빌드, E2E 타입 검사, 의존성 검사, 변경 Java 포맷 검사 통과.
- jdeps에서 domain → JDK, application → domain/JDK 경계를 확인했다.
- 실제 Spring 공통 계약 **140개 / 10개 파일 통과**, Node 전체 E2E **165개 / 13개 파일 통과**.
- 전체 실행 후 실제 PTY 테스트의 준비 코드를 requestResize 행동으로 단순화했다. 세션 교체 없이
  같은 참여자가 resize → 셸 입력을 수행한다. 변경한 15개 계약도 Node/Spring 각각 다시 실행해 모두 통과했다.

근거: `artifacts/migration-baseline/p3o-terminal-control/`의 before/src, node-baseline.log,
java-red.log, java-refactor.log, gradle.log, java-results.json, java-contract.log, node-full.log,
typecheck.log, dependencies.log, jdeps.log, java-format.log. 테스트 행동 정리 후의 재검증은
java-control-final.log와 node-control-final.log에 남겼다.
최종 JAR 빌드 후 프로세스 E2E를 실행했고 실행 중 JAR을 덮어쓰지 않았다.

제목·창 geometry·참여자 focus/cursor 등 남은 협업 계약, Java 계층 자동 검사, 영속 저장·재시작 복원과
전체 브라우저 검증은 후속 범위다. Node가 계속 기본 서버이며 Spring 전체 기능 동등성을 선언하지 않는다.
