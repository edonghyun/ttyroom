# TTYRoom 코드·테스트 작성 가이드

목표는 줄 수나 패턴 이름이 아니라 **본문만 읽고 조건, 행동, 결과와 책임의 주인을 이해하는 것**이다.
Java·TypeScript 모두 적용한다. 언어별 문법과 계층별 관찰 대상은 유지한다.

## 참고한 코드와 채택 범위

2026-09-28 로컬 코드를 직접 읽고 비교했다. 외부 프로젝트 전체가 이 기준을 만족한다는 뜻은 아니다.

| 참고 코드                                                           | 가져올 점                                                                                 | 그대로 가져오지 않을 점                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `~/projects/hexai/packages/core/src/transaction-hooks.spec.ts`      | `createCommitScenario()`가 기록 장치를 준비하고 본문이 등록 → 실행 → 순서 검증으로 읽힌다 | 모든 간단한 생성자까지 scenario로 감싸지 않는다                                              |
| `~/projects/hexai/packages/core/src/transaction-hooks.ts`           | 커밋 순서와 hook 등록 불변식을 `TransactionHooks`가 소유한다                              | TTYRoom에 hook 프레임워크를 추가할 이유는 없다                                               |
| `~/projects/hexai/packages/sqlite/src/sqlite-unit-of-work.spec.ts`  | 실제 SQLite로 성공·실패 후 저장 결과를 관찰하고 fixture가 DB를 정리한다                   | 예외가 발생하지 않아도 지나갈 수 있는 try/catch 검증은 `rejects`/`catchThrowable`로 대체한다 |
| `~/projects/hexai/packages/application/src/execution-scope.spec.ts` | 여러 필드가 동일한 계약을 따를 때 공통 계약을 재사용한다                                  | 시간 지연으로 순서를 추측하거나 기다리지 않은 callback에 assertion을 두지 않는다             |
| `~/projects/hexai/packages/web/src/core/limiter.ts`                 | 허가의 획득·반납·drain을 소유한 객체가 불변식을 보호한다                                  | 내부 구조나 디자인 패턴을 언어만 바꾸어 복제하지 않는다                                      |

지정된 `~/projects/hzpro-dev-tmp`에는 확인 시점에 일부 페이지·문서·이미지만 있고 테스트 파일이
없었다. 해당 프로젝트의 테스트 관례를 확인한 것처럼 인용하지 않는다. 경로가 확인되면 비교를 보완한다.
TTYRoom 기존 `backend/TESTING.md`의 TDD·동시성·저장 경계 규칙은 유지한다.

## 테스트는 행동 명세로 읽혀야 한다

- 이름은 **조건 → 관찰 가능한 결과**를 말한다. `works`, `case1`, 구현 함수명만으로 끝내지 않는다.
- 본문은 준비 / 행동과 관찰값 수집 / 검증을 빈 줄로 구분한다. GIVEN 주석이나 접두사는 의무가 아니다.
- 한 테스트는 한 계약을 증명한다. 하나의 거절이 상태·저장·알림을 모두 보존한다면 여러 assertion이 필요하다.
- 앞 테스트에서 준비한 상태에 의존하지 않는다. **준비 코드의 재사용**과 **테스트 간 상태 공유**는 다르다.
- 준비 단계의 성공을 모든 본문에서 재검증하지 않는다. fixture가 약속한 상태에 도달하지 못하면
  준비 오류로 즉시 실패하고 자원을 정리한다. 본문은 해당 테스트의 차이에 집중한다.
- 중간 관찰이 계약의 일부이면 그 시점의 값/불변 snapshot을 수집하고 마지막에 비교한다.
  가변 객체 참조를 보관한 뒤 최종 상태만 두 번 검사하지 않는다.
- `assertThat(room.rename(...))`처럼 검증 안에 행동을 숨기지 않는다. 예외 검증의 lambda는 예외다.
- 공통 준비에서 다뤘다는 이유로 핵심 성공·실패 계약 테스트를 삭제하지 않는다.

### Fixture / action / observation / assertion

| 역할        | 책임                                       | 피할 것                                       |
| ----------- | ------------------------------------------ | --------------------------------------------- |
| Fixture     | 필요한 상태·의존성·자원 수명, 실패 시 정리 | `setup(true, false)`, 이름에 없는 제어권 획득 |
| Action      | 행동과 그 완료를 알리는 프로토콜 대기      | 기대 결과를 몰래 검증, 임의 sleep             |
| Observation | 현재 상태·수신 기록을 값으로 반환          | 순서 정렬, 중복 제거, 예상 밖 메시지 버림     |
| Assertion   | 관찰된 값으로 계약 검증, 실패 원인 표시    | 명령 전송, 상태 변경, 광범위한 부분 일치      |

helper의 기준은 재사용 횟수보다 **호출자가 몰라도 될 지식을 숨기는가**다.
단순 `assertThat(settings.port()).isEqualTo(5678)`는 그대로 둔다.
반면 terminal id, 프레임 인코딩, replay 완료 메시지와 수신 종료 조건은 정책 테스트의 본문에서
매번 조립하지 않는다. 이 프로토콜 지식은 해당 시나리오가 소유한다.

### Java: 숫자 순서를 암기하지 않게 한다

변경 전:

```java
assertThat(settings).isEqualTo(new ServerSettings(5678, "env.sqlite", 21, 30, 40, 51, 60));
```

변경 후 (`ServerSettingsTests`):

```java
var environment = configuredFile("""
        {"port":1234,"policy":{"hostGraceMs":30}}
        """).withProperty("TTYROOM_PORT", "5678");

var settings = ServerSettings.load(environment);

assertThat(settings.port()).isEqualTo(5678);
assertThat(settings.hostGraceMs()).isEqualTo(30);
```

관련 필드가 여럿이면 명시적 assertion이 길어져도 좋다. 기대 객체 builder나 reflection DSL을
새로 도입해 단순 필드 검증을 숨기지 않는다. 원래 검증하던 필드를 생략하지 않는다.

### TypeScript E2E: 전송 절차보다 사용자 계약이 먼저 보이게 한다

변경 전에는 각 사례가 binary encoding, terminal id 7, replay-complete 전송, sync까지 수신을 조립했다.
변경 후 실제 `policy.e2e.ts`의 형태:

```ts
await using scenario = await outputPolicyScenario({ scrollbackBytesPerTerminal: 3 });

const live = await scenario.publishOutput("a", "bbb");
const replay = await scenario.replayFor("late");

expect(live.texts).toEqual(["a", "bbb"]);
expect(replay.texts).toEqual(["bbb"]);
expect(replay.sync).toMatchObject({ terminalId: 7, seq: 2 });
```

`publishOutput`은 실제 소켓을 사용하고 sync까지 기다려 관찰값을 반환한다. 기대 문자열은 모른다.
단일 프레임 초과처럼 연결 종료가 결과인 테스트는 `sendOutput`을 사용한다. 성공/실패 boolean으로
하나의 행동 함수를 분기시키지 않는다. protocol framing 자체를 검사하는 테스트에서는 raw 프레임이
오히려 검증 대상이므로 숨기지 않는다.

## 계층별로 무엇을 증명하는가

| 계층               | 본문에서 보여야 할 것                               | 이 계층만으로 주장할 수 없는 것 |
| ------------------ | --------------------------------------------------- | ------------------------------- |
| Domain/application | 불변식, 상태 전이, 저장 실패 시 보존·효과           | 실제 JSON·WebSocket·DB 호환     |
| Adapter 통합       | 실제 HTTP/JSON/SQLite 경계의 계약                   | 배포 JAR·브라우저·PTY 연결 전체 |
| 프로세스 E2E       | 실제 Node/Spring 실행 파일과 클라이언트의 공통 계약 | React 조작·화면 복구            |
| Browser E2E        | 사용자 행동, 제어권, 출력·복구의 UI 결과            | 모든 정책 경계와 경합 경우의 수 |

같은 계약을 모든 계층에서 복제하지 않는다. 각 계층에서 생기는 실패를 검증한다.
공통 프로토콜 E2E는 Node와 Spring에 같은 사례를 실행한다. 구현별 skip이나 다른 기대값으로
마이그레이션 차이를 가리지 않는다.

## 비동기·실패·파라미터화

- 시간을 기다리지 말고 **관찰 가능한 완료 조건**을 기다린다. 모든 대기에는 timeout과 진단 정보가 필요하다.
- 동시성 검증은 gate/latch로 경합을 만든다. `Thread.State.WAITING`만으로 특정 lock 접수를 추론하지 않는다.
- 수신 기록은 원래 순서·중복·예상 밖 메시지를 보존한다. 목적에 맞춘 projection을 쓰더라도 원본을 남긴다.
- 예외는 발생 자체와 의미를 검증한다. catch 안에서만 assert하면 예외가 없어도 통과할 수 있다.
- 파라미터화는 같은 계약의 입력 변형만 묶는다. 사례 이름으로 무엇이 다른지 표시한다.
  성공/실패, 생성/복구 등 서로 다른 준비와 결과를 거대한 switch 하나에 몰지 않는다.
- `@BeforeEach`/fixture는 공통의 중립적 준비에 쓴다. 각 테스트의 핵심 조건은 본문에 보인다.
- 자원은 만든 주체가 닫는다. 준비 도중 실패해도 서버·소켓·임시 파일이 남지 않아야 한다.

## Production 코드는 책임의 소유권으로 읽혀야 한다

- 공개 API는 호출자의 행동/결과를 표현한다. 호출자가 저장·전송·캐시·정리 순서를 외우지 않게 한다.
- 불변식은 그 상태의 소유자 안에서 지킨다. 저장 전 commit 금지, 방별 명령 직렬화와
  commit 후 알림은 기존 Room 경계를 유지한다.
- wire/환경변수/JSON 표현은 adapter가, 방과 lease 규칙은 domain/application이 소유한다.
- 타입과 이름에 의미를 준다. 의미가 다른 여러 숫자·boolean 위치 인자는 설계 신호다.
  내부 helper를 만들 때도 어느 값의 범위·단위인지 호출부에서 읽히게 한다.
- 실패는 경계에 맞게 표현한다. 설정 오류를 조용히 기본값으로 삼거나 원문 비밀 값을 오류에 노출하지 않는다.
- 중복은 줄 수보다 **같은 결정을 여러 곳에서 수정해야 하는지**로 판단한다.
- Strategy/Factory/Repository/이벤트 버스를 이름 때문에 추가하지 않는다. 단순 직접 호출이 명확하면 유지한다.
- 추상화는 입출력 계약과 수명을 줄여야 한다. 인자만 전달하는 wrapper·한 번 쓰는 범용 framework는 거절한다.

설정 로딩의 예:

```java
// 변경 전: 출처 두 개와 범위 두 개를 매번 전달한다.
number(environment, policy, "hostGraceMs", "TTYROOM_HOST_GRACE_MS", 30000, 0, MAX_SAFE_INTEGER);

// 변경 후: 출처·우선순위·숫자 파싱은 SettingsSource가 소유한다.
policy.nonNegative("hostGraceMs", "TTYROOM_HOST_GRACE_MS", 30000);
```

`SettingsSource`는 내부 구현이다. 호출부는 설정별 key·환경변수·기본값과 허용 범위의 의미만
지정한다. 정책별 클래스를 만들거나 공용 설정 프레임워크로 확대하지 않는다.

## 리뷰와 변경 절차

1. 이름과 본문만으로 조건·행동·기대 결과를 설명할 수 있는가?
2. helper를 열어야만 알 수 있는 숨은 행동/검증/정리 순서가 있는가?
3. fixture 실패와 제품 계약 실패를 구별할 수 있는가?
4. 추상화가 호출자 부담을 줄였는가, 복잡함을 다른 파일로 옮기기만 했는가?
5. 원래 관찰하던 결과·순서·중복·거절을 여전히 검사하는가?
6. 변경 전후 같은 테스트를 실행했는가? 실행하지 않은 범위를 통과라고 적지 않았는가?

리팩터링은 **GREEN → 구조 변경 → GREEN**으로 기록한다. 새 계약/버그 수정은 실제 행동 실패
RED를 먼저 확인한다. TDD처럼 보이도록 이력을 꾸미지 않는다.

설정·정책·복구·제어권에 이어, 남은 브라우저 협업과 키보드 테스트 및 프로토콜 lifecycle 준비에도
[일괄 적용](WORK_LOG.md#테스트-표현과-동시성-관찰)했다. 이미 기준을 충족하는 직접 호출과 관찰은 유지한다.
기준 문서와 세부 검증 규칙이 충돌하면 더 구체적인 계약을 보존한다.

## 브라우저 복구 테스트 적용 예

`web/e2e/room-recovery.e2e.ts`는 두 참여자·터미널 준비를 이름 있는 fixture 함수로 재사용한다.
공유 입력 복구 테스트는 `givenSharedInputWorkspace`로 양쪽의 모드 전파까지 준비한다.
actor fixture가 context·서버 수명을 소유한다.

```ts
// 방 입장 전에 ConnectionFault.install(alice.page)로 실제 서버 연결의 단절 지점을 설치한다.
await connection.disconnect();
const disconnectedState = await alice.roomPage.waitForConnection("Reconnecting");
await bob.roomPage.printLine("term-1", marker);
const liveOutput = await bob.roomPage.outputContaining("term-1", marker);
connection.reconnect();
const connectedState = await alice.roomPage.waitForConnection("Connected");
const replayedOutput = await alice.roomPage.outputContaining("term-1", marker);

expect(disconnectedState).toBe("Reconnecting");
expect(liveOutput).toContain(marker);
expect(connectedState).toBe("Connected");
expectOutputOnce(replayedOutput, marker);
```

`waitForConnection`과 `outputContaining`은 제한 시간 내 조건을 기다려 실제 관찰값을 반환한다.
Playwright polling의 expect는 대기 완료 조건이다. 실패를 삼키지 않으며, 최종 계약 assertion을
대신하지 않는다. 복구 후 화면만 읽으면 사라지는 `Restoring` 상태는 fault를 해제하기 전에 수집한다.
준비용 geometry 전파·셸 명령 완료 대기는 fixture/준비 단계에서 끝내고 마지막에 재검증하지 않는다.

`printLine`은 문자열을 나눠 shell 인자로 전달한다. 명령 에코에 완전한 표식이 나타나지 않게 해
실제 명령 실행 결과를 기다린다. 표식은 테스트마다 독립된 PTY에서 쓰므로 시각 기반 이름이 필요 없다.
출력 1회 검증은 수집한 화면 snapshot 안의 횟수이며, 이후 영원히 중복이 없다는 보장은 아니다.

## 제어권 테스트의 분리와 입력 거절 관찰

`web/e2e/room-control.e2e.ts`는 제어권 획득/입력 거절/Switch/입력 모드/Kill Switch 계약을 묶는다.
일반 화면 상호작용은 `room-collaboration.e2e.ts`에 남긴다. 파일 분리의 기준은 줄 수가 아니라
독립적으로 이해할 수 있는 사용자 계약이다.

- 제어권 획득과 토스트 위치는 다른 실패 원인이므로 별도 테스트로 실행한다.
- Shared 전환과 Exclusive 복귀는 각각 독립된 방에서 검증한다. 복귀 테스트는 Shared 준비를
  두 참여자가 관찰한 뒤 시작하며, 다른 테스트의 실행 결과를 재사용하지 않는다.
- `givenTwoParticipantsWithTerminal`은 제어권을 얻거나 모드를 바꾸지 않는다.
  `givenAliceControlledTerminal`은 이름대로 Alice의 제어권이 양쪽에 전파될 때까지 준비한다.
- 권한 없는 입력 뒤에 정상 명령의 실제 출력이 도착하는 것을 기다린 후 양쪽 화면을 관찰한다.
  짧은 sleep 뒤의 출력 부재를 입력 거절의 증거로 삼지 않는다. 이 역시 관찰 구간의 검증이다.

정상 출력과 거절 입력은 표식을 다르게 보낸다.

```ts
// 거절 입력: 에코만 전달되어도 실패해야 하므로 표식을 나누지 않는다.
await bob.roomPage.typeInTerminal("term-1", `printf '${rejectedMarker}\\n'`);

// 정상 출력: 명령 에코를 실행 결과로 오인하지 않도록 표식을 나눠 보낸다.
await alice.roomPage.printLine("term-1", synchronizationMarker);
```

표식은 테스트가 소유한 고정 문자열이다. 임의 외부 문자열을 shell 명령에 그대로 삽입하지 않는다.

## 동일 계약의 여러 초기 상태

성공/실패별 assertion을 if로 나누는 거대한 테스트 대신, 같은 계약의 준비를 이름 있는 사례로 둔다.
서로 다른 결과는 별도 테스트로 나눈다. 사례가 자원을 새로 만들면 준비 실패 시 정리까지 소유한다.
이미 `await using`으로 소유 중인 fixture를 준비하는 action은 그 수명을 대신 관리하지 않는다.

```ts
it.each(unavailableTerminalStates)(
  "$name에서는 같은 모드 재요청도 $reason로 거절한다",
  async (state) => {
    await using fixture = await inputFixture();
    await state.prepare(fixture);
    const { terminalId, reason } = state;

    const rejection = await changeMode(fixture.observer, "exclusive", terminalId);

    expect(rejection).toEqual({
      type: "terminal-request-rejected",
      request: "set-mode",
      terminalId,
      reason,
    });
  },
);
```

private fixture 내부에서 상태에 따라 준비 순서가 달라지는 것은 허용한다. 동일 지식이 반복되거나
본문에서 if마다 다른 계약을 주장하는 것이 문제다. 모든 분기를 없애는 것을 목표로 하지 않는다.

복구 E2E의 `ConnectionFault`는 실제 서버로 전달하는 WebSocket route 양쪽을 닫고 복원 전까지
재접속을 거절한다. 브라우저 전체를 offline으로 만든 뒤 정상 close handshake를 기다리지 않는다.
이는 WebSocket 단절/재접속·replay 계약의 검증이며 OS 네트워크 partition의 재현은 아니다.
검증 중 드러난 최초 timeout과 trace, 교정 후 반복·전체 실행 기록은 일괄 정리 artifact에 보존한다.
