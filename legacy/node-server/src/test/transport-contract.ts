import type { DataFrame, ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import type { Connection } from "../ports/transport.js";

export interface TransportLink {
  connection: Connection;
  remote: {
    messages: ServerMessage[];
    dataFrames: DataFrame[];
    sendText(raw: string): void;
    sendBinary(bytes: Uint8Array): void;
    close(): void;
  };
  received: { texts: string[]; binaries: Uint8Array[] };
  onServerClose: Promise<void>;
  serverCloseCount(): number;
  flush(): Promise<void>;
}

export function describeTransportContract(
  name: string,
  makeLink: () => Promise<TransportLink>,
): void {
  describe(`${name} — Transport 계약`, () => {
    it("send한 제어 메시지가 remote에 순서대로 도착한다", async () => {
      const link = await makeLink();
      link.connection.send({ type: "sync", terminalId: 1, seq: 1 });
      link.connection.send({ type: "sync", terminalId: 1, seq: 2 });

      await link.flush();

      expect(link.remote.messages).toMatchObject([
        { type: "sync", terminalId: 1, seq: 1 },
        { type: "sync", terminalId: 1, seq: 2 },
      ]);
      link.remote.close();
      await link.onServerClose;
    });

    it("sendData한 프레임이 순서대로 제어 메시지와 독립적으로 도착한다", async () => {
      const link = await makeLink();
      link.connection.send({ type: "sync", terminalId: 1, seq: 0 });
      link.connection.sendData({
        kind: "output",
        terminalId: 1,
        seq: 1,
        payload: new Uint8Array([1]),
      });
      link.connection.sendData({
        kind: "output",
        terminalId: 1,
        seq: 2,
        payload: new Uint8Array([2]),
      });

      await link.flush();

      expect(link.remote.messages).toHaveLength(1);
      expect(link.remote.dataFrames).toMatchObject([{ seq: 1 }, { seq: 2 }]);
      link.remote.close();
      await link.onServerClose;
    });

    it("remote가 보낸 텍스트와 바이너리가 서버 수신 경계에 도착한다", async () => {
      const link = await makeLink();
      const binary = new Uint8Array([1, 2, 3]);

      link.remote.sendText("hello");
      link.remote.sendBinary(binary);
      await link.flush();

      expect(link.received.texts).toEqual(["hello"]);
      expect(link.received.binaries).toEqual([binary]);
      link.remote.close();
      await link.onServerClose;
    });

    it("remote.close는 서버 close 통지를 정확히 한 번 발생시킨다", async () => {
      const link = await makeLink();

      link.remote.close();
      link.remote.close();
      await link.onServerClose;

      expect(link.serverCloseCount()).toBe(1);
    });

    it("닫힌 연결에 send와 sendData를 호출해도 throw하지 않는다", async () => {
      const link = await makeLink();
      link.connection.close();

      expect(() => link.connection.send({ type: "sync", terminalId: 1, seq: 0 })).not.toThrow();
      expect(() =>
        link.connection.sendData({
          kind: "output",
          terminalId: 1,
          seq: 1,
          payload: new Uint8Array([1]),
        }),
      ).not.toThrow();
    });
  });
}
