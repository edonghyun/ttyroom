import type { ClientMessage, DataFrame, ServerMessage } from "@ttyroom/protocol";
import type { ConnectorConnection, ConnectorTransport } from "../ports/connector-transport.js";

export class FakeConnectorConnection implements ConnectorConnection {
  readonly sent: ClientMessage[] = [];
  readonly sentData: DataFrame[] = [];
  closed = false;

  private readonly messageHandlers: Array<(msg: ServerMessage) => void> = [];
  private readonly dataHandlers: Array<(frame: DataFrame) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  send(msg: ClientMessage): void {
    this.sent.push(msg);
  }

  sendData(frame: DataFrame): void {
    this.sentData.push(frame);
  }

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onData(handler: (frame: DataFrame) => void): void {
    this.dataHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(msg: ServerMessage): void {
    for (const handler of this.messageHandlers) handler(msg);
  }

  emitData(frame: DataFrame): void {
    for (const handler of this.dataHandlers) handler(frame);
  }

  emitClose(): void {
    for (const handler of this.closeHandlers) handler();
  }
}

interface PendingConnect {
  resolve: (conn: ConnectorConnection) => void;
  reject: (reason: Error) => void;
}

export class FakeConnectorTransport implements ConnectorTransport {
  readonly connections: FakeConnectorConnection[] = [];
  readonly connectUrls: string[] = [];

  private pending: PendingConnect[] = [];
  private failNextCount = 0;

  connect(wsUrl: string): Promise<ConnectorConnection> {
    this.connectUrls.push(wsUrl);
    return new Promise<ConnectorConnection>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  failNextConnect(count = 1): void {
    this.failNextCount += count;
  }

  async settle(): Promise<void> {
    const waiting = this.pending;
    this.pending = [];

    for (const { resolve, reject } of waiting) {
      if (this.failNextCount > 0) {
        this.failNextCount -= 1;
        reject(new Error("fake connect failure"));
        continue;
      }

      const conn = new FakeConnectorConnection();
      this.connections.push(conn);
      resolve(conn);
    }

    await new Promise<void>((r) => setTimeout(r, 0));
  }

  lastConnection(): FakeConnectorConnection {
    const last = this.connections[this.connections.length - 1];
    if (!last) throw new Error("아직 성립한 연결이 없다 — settle()을 먼저 호출했는지 확인");
    return last;
  }

  pendingConnectCount(): number {
    return this.pending.length;
  }
}
