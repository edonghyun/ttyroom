import { describe, expect, it } from "vitest";
import { registeredRoom } from "./registered-room.js";

const invalidCredential = {
  type: "error",
  code: "invalid-credential",
  message: "invalid-credential",
};

describe("Spring v8 credential 취소", () => {
  it("참여자를 즉시 종료하고 다른 참여자를 유지하며 재시작 후에도 재접속을 거절한다", async () => {
    await using room = await registeredRoom();
    const credential = await room.participant();
    const alice = await room.connect(credential.secret, "Alice");
    const bobCredential = await room.participant();
    const bob = await room.connect(bobCredential.secret, "Bob");
    await alice.peer.next(); // Bob's join precedes the action under test.

    const response = await room.revoke("participants", credential.id);
    const rejection = await alice.peer.next();
    await alice.peer.closed();
    const removal = await bob.peer.next();
    bob.peer.send({ type: "acquire-lease", terminalId: 42 });
    const stillConnected = await bob.peer.next();
    await room.server.restart();
    const rejoining = await room.connect(credential.secret, "Alice again");
    await rejoining.peer.closed();

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rejection).toEqual(invalidCredential);
    expect(removal).toMatchObject({
      type: "room-event",
      event: { kind: "participant-left", clientId: credential.id },
    });
    expect(stillConnected).toMatchObject({ type: "lease-invalid", terminalId: 42 });
    expect(rejoining.message).toEqual(invalidCredential);
  });

  it("호스트 취소는 inventory와 함께 저장되고 재시작 후 빈 workspace를 복원한다", async () => {
    await using room = await registeredRoom();
    const credential = await room.host();
    const host = await room.connect(credential.secret, "Computer");
    host.peer.send({
      type: "host-inventory",
      terminals: [{ terminalId: 7, runtimeId: "pty", lastOutputSeq: 0, firstRetainedSeq: 0 }],
    });
    const ready = await host.peer.next();

    const response = await room.revoke("hosts", credential.id);
    const rejection = await host.peer.next();
    await host.peer.closed();
    await room.server.restart();
    const rejected = await room.connect(credential.secret, "Computer again");
    const observerCredential = await room.participant();
    const observer = await room.connect(observerCredential.secret, "Observer");
    const repeated = await room.revoke("hosts", credential.id);

    expect(ready).toMatchObject({ type: "host-ready" });
    expect(response.status).toBe(204);
    expect(rejection).toEqual(invalidCredential);
    expect(rejected.message).toEqual(invalidCredential);
    expect(observer.message).toMatchObject({
      type: "welcome",
      snapshot: { hosts: [], terminals: [], leases: [] },
    });
    expect(repeated.status).toBe(204);
  });
});
