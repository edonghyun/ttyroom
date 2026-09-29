import type { DataFrame } from "@ttyroom/protocol";
import type { Connection } from "../ports/transport.js";
import type { TransportLink } from "./transport-contract.js";

export async function makeInMemoryLink(): Promise<TransportLink> {
  const messages: TransportLink["remote"]["messages"] = [];
  const dataFrames: DataFrame[] = [];
  const received = { texts: [] as string[], binaries: [] as Uint8Array[] };
  let closed = false;
  let closeCount = 0;
  let resolveServerClose: (() => void) | undefined;
  const onServerClose = new Promise<void>((resolve) => {
    resolveServerClose = resolve;
  });

  const connection: Connection = {
    connectionId: "in-memory-1",
    send(message): void {
      if (!closed) messages.push(message);
    },
    sendData(frame): void {
      if (!closed) dataFrames.push(frame);
    },
    bufferedBytes(): number {
      return 0;
    },
    close(): void {
      closed = true;
    },
  };

  return {
    connection,
    remote: {
      messages,
      dataFrames,
      sendText(raw): void {
        if (closed) return;
        received.texts.push(raw);
      },
      sendBinary(bytes): void {
        if (closed) return;
        received.binaries.push(bytes.slice());
      },
      close(): void {
        if (closed) return;
        closed = true;
        closeCount += 1;
        resolveServerClose?.();
      },
    },
    received,
    onServerClose,
    serverCloseCount: () => closeCount,
    flush: async (): Promise<void> => {},
  };
}
