import { describe, expect, it } from "vitest";
import { registeredRoom } from "@ttyroom/test-support/registered-room";
import { SocketProbe } from "@ttyroom/test-support/socket-probe";

describe("Spring 수신 자원 격리", () => {
  it.each([
    {
      name: "완성된 text 256 KiB 초과",
      send: (peer: SocketProbe) => peer.send(" ".repeat(262_145)),
      code: 1009,
    },
    {
      name: "미완성 UTF-8 text 256 KiB 초과",
      send: (peer: SocketProbe) => peer.startTextMessage("가".repeat(87_382)),
      code: 1009,
    },
    {
      name: "text 첫 조각 이후 5초 미완성",
      send: (peer: SocketProbe) => peer.startTextMessage("{"),
      code: 1008,
    },
    {
      name: "binary 첫 조각 이후 5초 미완성",
      send: (peer: SocketProbe) => peer.startBinaryMessage(new Uint8Array([1])),
      code: 1008,
    },
  ])("$name 연결을 닫아도 정상 참가자는 요청을 처리한다", async ({ send, code }) => {
    await using room = await registeredRoom();
    const credential = await room.participant();
    const { peer: alice } = await room.connect(credential.secret, "Alice");
    await using offender = await SocketProbe.connect(room.server.baseUrl);

    send(offender);
    alice.send({ type: "acquire-lease", terminalId: 42 });
    const during = await alice.next();
    const closure = await offender.closureCode();
    alice.send({ type: "acquire-lease", terminalId: 43 });
    const after = await alice.next();

    expect(closure).toBe(code);
    expect(during).toMatchObject({ type: "lease-invalid", terminalId: 42 });
    expect(after).toMatchObject({ type: "lease-invalid", terminalId: 43 });
  });
});
