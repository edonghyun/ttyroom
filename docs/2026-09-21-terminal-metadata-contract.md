# 터미널 메타데이터 계약 — P3j

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-21. 기존 Node 동작을 공통 프로세스 계약으로 고정한 뒤 Spring에 이식했다.
이전 Spring은 `terminal-meta`를 미지원 명령으로 거절했다. Connector는 error 응답을 받으면
연결을 닫으므로 실제 PTY 생성 이후 첫 메타데이터 보고가 연결 유지의 빈틈이었다.

## 유지한 계약

| 입력/상태                               | 관찰 결과                                                  |
| --------------------------------------- | ---------------------------------------------------------- |
| 현재 host가 소유한 terminal의 변경된 값 | 상태 갱신 후 참여자에게 terminal-meta 이벤트               |
| 세 필드가 모두 이전과 동일              | 이벤트 생략                                                |
| cwd/gitBranch/fgProcess                 | 각각 필수 string 또는 null, 빈 문자열 보존, 추가 필드 제거 |
| null 초기화                             | 변경으로 반영하고 이후 welcome에도 포함                    |
| 종료된 terminal의 늦은 보고             | 메타데이터만 갱신, 종료 상태와 exitCode 보존               |
| participant·다른 host·없는 terminal     | bad-message, terminal 상태 변경 없음                       |
| 교체된 host의 이전 세션                 | 무시, 새 세션의 값 보존                                    |
| runtime이 연결된 terminal               | 메타데이터 갱신 후에도 같은 runtime inventory를 정상 수락  |

근거: `legacy/node-server/src/usecases/open-terminal.ts`의 `updateMeta`, 도메인 workspace의
`updateTerminalMeta`, `protocol/src/messages.ts`의 메타데이터 스키마.
종료 상태를 이유로 보고를 거절하는 새 정책을 추가하지 않았다.

## 책임과 리뷰

- `TerminalWorkspace`가 소유권·값 비교·불변 terminal 교체를 담당한다. 기존 snapshot과 runtime을 보존한다.
- `RoomSessions`가 기존 방 monitor와 현재 연결 identity를 사용해 변경과 알림을 조정한다.
- sealed `HostCommand.TerminalMetadata`와 `RoomNotice.TerminalMetadataChanged`는 업무 값만 전달한다.
  `RoomProtocol`이 JSON 검증·v7 이벤트·nullable 필드 표현을 담당한다. welcome과 이벤트의 메타데이터
  직렬화를 한 곳으로 모아 null 처리의 중복을 없앴다.
- 별도 서비스·저장소·잠금은 추가하지 않았다. Node의 save → commit → effects 원칙은 유지해야 하지만
  이번 Java 구현에는 아직 영속 저장 자체가 없다.
- 생성 테스트와 메타데이터 테스트의 동일 host 후속 보고 대기를 `protocol-fixture.ts`로 모았다.
  이벤트를 정렬하거나 중복 제거하지 않고 도착 순서 그대로 검증한다. 각 테스트는 서버/방/소켓을 소유한다.
- Java 상태 보존 테스트는 변경에 사용한 helper로 기대값을 만들지 않고 metadata 이외 필드를 독립 비교한다.

## 실제 프로세스 검증

새 공통 계약 14개가 기존 Node에서 통과했다. 변경 전 Spring에서는 빈 문자열 보고의 이벤트가 오지 않는
실패를 재현했다. 관련 로그는 `artifacts/migration-baseline/p3j-metadata/`의 `node-baseline.log`,
`java-red.log`에 있다.

13개 프로토콜 시나리오는 중복 억제·null 초기화·빈 문자열·추가 필드·종료 후 갱신·역할/소유권·잘못된 타입을
확인한다. 나머지 1개는 실제 Connector와 node-pty를 사용한다.

1. 실제 Connector가 첫 PTY를 연다.
2. 기본 5초 수집 주기로 실제 작업 경로를 보고하고 참여자가 이를 관찰한다.
3. 같은 Connector에 두 번째 PTY 생성을 요청해 완료한다.
4. 새 참여자의 snapshot에서 첫 PTY의 메타데이터, 두 PTY의 open 상태와 host online을 확인한다.

고정 sleep이나 프로세스 생존 여부만으로 통과시키지 않는다. 메타데이터를 기다리는 제한은 수집 주기와
OS 조회를 고려해 20초이며 제품의 수집 주기는 변경하지 않았다. 이번 실행 환경은 macOS/Java 21이다.
Linux 실행 결과나 장시간 연결 유지 결과를 주장하지 않는다.

최종 검증: **Java 91개, 실제 Spring JAR 공통 계약 95개, Node 전체 프로세스 E2E 120개 통과**.
Java 테스트·JAR 빌드, E2E 타입·의존성·Java/변경 파일 포맷 검사를 통과했다.
공통 계약은 HTTP 23 + 입장 17 + host 15 + 복구 10 + 생성 16 + 메타데이터 14개다.
`gradle.log`, `java-contract.log`, `node-full.log`에 실행 결과를 보관한다. 최종 테스트 표현 정리 후
메타데이터 14개는 두 서버에서 다시 실행한 로그를 `java-metadata-final.log`, `node-metadata-final.log`로 남긴다.

## 남은 범위

입력 lease·Kill Switch와 입력 전달, 참여자의 close/resize, 저장·재시작 복구는 후속 단계다.
실제 PTY 생성과 메타데이터 확인은 원격 셸 명령 입력·전체 브라우저 협업의 검증과 구분한다.
기본 협업 서버는 계속 Node다.

## 후속 리뷰와 리팩터링

기존 설계 기준과 Node의 `updateMeta`를 다시 비교했다. 제품의 메타데이터 계약은 유지하며
테스트 대기 결함과 실제 중복을 아래 범위에서 정리했다.

| 발견                                                                        | 조치와 검증                                                                                                             |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `captureThroughInputReport`는 이미 입력이 허용되면 새 이벤트가 없어 timeout | fixture 소유 host의 차단 → 허용 주기를 관찰하도록 변경. 동일 fixture의 두 번째 호출로 실패 재현                         |
| 다른 host의 입력 알림에도 대기가 끝남                                       | 대상 hostId와 최종 허용 값을 확인. 다른 host의 알림을 먼저 발생시켜 조기 종료 재현                                      |
| 초기 inventory 준비가 네 파일에 분산, 일부는 수신 횟수만 셈                 | `protocolWorkspaceFixture`가 자원 수명과 준비 완료 이벤트/ID 확인을 소유. 별도 검증 없이 메시지를 버리던 준비 코드 제거 |
| 생성 확인·종료·메타데이터에 동일 소유권 검사/오류 변환이 각각 세 번         | 도메인 내부 `ownedTerminal`과 Session host 진입 경계의 typed catch로 통합                                               |
| 메타데이터 테스트의 행동이 메시지 조립에 섞임                               | `reportMetadata`로 보고 행동을 명명하고 중첩 삼항식을 평탄화                                                            |

`ownsOpen`은 출력/replay의 별도 조건이므로 소유권만 검사하는 경계와 합치지 않았다.
종료된 terminal의 메타데이터 수락, 현재 세션 검증, 방 monitor, 상태 변경 후 알림 순서는 그대로다.
소유권 거절 응답 중 연결 실패는 보고한 host만 닫고, 직렬화 등 예상하지 못한 오류는 전파한다.
이 실패 의미를 Java 테스트 4개로 구조 변경 전에 고정했다.

대기 helper는 관찰한 메시지를 정렬·필터링·중복 제거하지 않는다. 입력 권한을 실제로 바꾸므로
lease/Kill Switch 검증의 일반 barrier로 사용하지 않는다. 기본 host의 이전 입력 상태 알림을 소비한
fixture에서 호출하며, 연결을 교체한 host나 binary output 관찰은 해당 시나리오의 별도 완료 신호를 쓴다.

근거: `artifacts/migration-baseline/p3j-review/fixture-red.log`의 2개 실패,
`java-baseline.log`의 변경 전 실패 의미 검사. `before/`에는 이 리뷰 직전의 변경 대상 소스를 보관한다.

후속 검증: **Java 95개, 실제 Spring JAR 공통 계약 97개, Node 전체 프로세스 E2E 122개 통과**.
메타데이터 행동 명명 정리 뒤 Node 해당 14개도 다시 통과했다. JAR 빌드·E2E 타입·의존성·Java/변경 파일
포맷 검사 통과. 로그는 같은 `p3j-review/`의 `gradle.log`, `java-contract.log`, `node-full.log`,
`node-metadata-final.log`, `typecheck.log`, `dependencies.log`, `format.log`, `java-format.log`에 있다.
이번 검증은 로컬 macOS에서 실행했으며 CI 원격 실행이나 Spring 전체 협업 완료를 의미하지 않는다.
