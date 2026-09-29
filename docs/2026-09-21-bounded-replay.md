# 대량 replay 예약과 순차 송신 — P3h

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

## 재현한 문제

P3g의 terminal history는 payload 1MiB·16,384 frames까지 보관하지만, replay는 이를 일반 송신 큐에
한꺼번에 넣었다. 이 큐의 상한은 1MiB·256개다. welcome 쓰기를 latch로 잠그고 late join을 실행하면
1,024개 작은 frame도, header를 더한 1MiB 단일 frame도 replay를 완료하지 못했다.
네트워크가 잠시 멈췄다는 이유만으로 유효한 보관 출력의 복구가 실패한 것이다.

`SlowPeerTests.aBlockedWelcomeCanDrainLargeHistoryWithoutBlockingAnotherJoin`의 두 케이스가 수정 전에
실패했다. 같은 방의 다른 참여자 입장이 완료되는지도 검증한다. 임의 sleep으로 상황을 추측하지 않는다.

## 변경과 유지한 경계

`TerminalOutput`은 frame 목록과 그 시점의 sync를 `Peer.replayOutput`에 전달한다. 이 호출은
**전송 완료가 아니라 전체 replay 예약 수락**을 뜻한다. 스냅샷은 불변이며, 이후 출력이 추가되거나
history가 잘려도 이미 예약한 프레임과 sync는 바뀌지 않는다.

`SocketSender`는 기존 연결별 FIFO 안에 replay cursor 하나를 예약한다. writer만 cursor를 전진시키며
출력 하나를 송신할 때마다 binary로 인코딩한다. 전체 replay를 미리 인코딩한 메시지 배열로 만들거나,
프레임별 작업·스레드를 생성하지 않는다. 인코딩·소켓 I/O는 room/sender monitor 밖에서 실행한다.

전송 순서는 `기존 메시지 → replay frames → sync → 이후 control/live 메시지`다. 일반 메시지와 replay에
각기 다른 용량 제한을 적용하지만, 별도의 전송 채널이나 우선순위 큐를 만들지는 않았다.
방별 상태 변경 경계, source/browser sequence, 중복 제거, live output의 gap 동작은 유지한다.

## 한도와 실패 의미

| 대상              | 연결별 상한                                            | 실패/회수                                           |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------- |
| 일반 live/control | payload 1MiB·256개, 송신 중 포함                       | live output은 drop/gap, 필수 control은 초과 시 종료 |
| replay 예약       | 출력 header·sync 포함 4MiB, 65,536 frames, 16 requests | 전체를 수락하거나 상한 초과로 종료(1008)            |
| 개별 소켓 쓰기    | 5초                                                    | 시간 초과로 종료(1011), 남은 큐/예약 폐기           |

replay 예약 용량은 마지막 sync의 쓰기가 끝난 후 회수한다. sync가 막힌 동안 다른 replay가 그 용량을
재사용하지 못한다. 정상 finish는 이미 수락한 FIFO를 비우고 닫으며, abort/원격 단절/timeout은 남은
replay와 후속 sync를 버린다. 이후 예약도 거절한다. 연결 정리 콜백은 한 번만 실행한다.

byte 한도는 송신할 payload/header 크기를 계산한 값이며 JVM 전체 heap 상한이 아니다. frame/request
개수 제한은 작은 출력과 빈 replay의 무제한 대기를 막는다. 많은 터미널의 초기 replay나 반복 resync가
**예약 상한 자체**를 넘으면 정상 네트워크에서도 연결이 종료될 수 있다. 일반 큐가 작다는 이유로
단일 유효 history를 거절하는 문제를 고친 것이며, 무제한 replay나 무손실 live output을 보장하지 않는다.

같은 연결의 이후 메시지는 replay를 추월하지 않으므로 지연될 수 있다. 다른 연결은 독립 writer를
사용한다. slow-consumer와 drop 정책은 Node와 완전히 같지 않다.

## 테스트와 검증

- 결정적 회귀: welcome 쓰기 차단 중 1,024 frames / 1MiB frame replay와 같은 방의 다른 입장.
- FIFO·스냅샷: 예약 후 원본 목록 변경, 이후 control/live 출력, 마지막 sync 순서.
- 자원 한도: 누적 bytes/frames/requests 각각 초과, 전송 중 sync의 예약 유지, 완료 후 재사용.
- 수명: replay 쓰기 timeout, 중간 abort, 후속 sync 미발행, 늦은 예약 거절. 기존 일반 송신·이전 deadline 경합도 유지.
- 실제 서버 공통 계약: 1,024개 작은 출력의 late join·resync·후속 live 출력. raw 순서/개수를 그대로 비교한다.

로그는 `artifacts/migration-baseline/p3h-replay/`에 보관한다. `red.log`는 수정 전 2개 실패,
`gradle.log`는 Java 전체 테스트/JAR, `java-contract.log`는 Spring 공통 계약,
`node-contract.log`는 Node의 복구 계약 검증이다. 실제 인터넷 slow-consumer 부하/soak, JVM 전체 메모리,
입력 권한·서버 재시작 복구 검증을 대신하지 않는다. Node 제품 코드는 이번 단계에서 변경하지 않았다.

최종 검증(2026-09-21, macOS/Java 21): **Java 73개, 실제 Spring JAR 공통 계약 65개,
Node 복구 계약 10개 통과**. JAR 빌드, E2E 타입·의존성·Java/변경 파일 포맷 검사도 통과했다.
Node 구현과 공용 probe는 변경하지 않아 Node 전체 E2E를 다시 실행하지 않았다.
