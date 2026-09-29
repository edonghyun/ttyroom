import type { Page, WebSocketRoute } from "@playwright/test";
import { decodeDataFrame } from "@ttyroom/protocol";

/** Injects one reported receive gap; replay still comes from the real server's retained output. */
export class OutputGapFault {
  private armed = false;
  private paused = false;
  private readonly waiting: Array<{ route: WebSocketRoute; message: string | Buffer }> = [];

  static async install(page: Page): Promise<OutputGapFault> {
    const fault = new OutputGapFault();
    await page.routeWebSocket("**/ws", (route) => {
      const server = route.connectToServer();
      server.onMessage((message) => fault.receive(route, message));
    });
    return fault;
  }

  interruptNextOutput(): void {
    this.armed = true;
  }

  resume(): void {
    this.paused = false;
    for (const { route, message } of this.waiting.splice(0)) route.send(message);
  }

  private receive(route: WebSocketRoute, message: string | Buffer): void {
    if (this.paused) {
      this.waiting.push({ route, message });
      return;
    }
    if (this.armed && Buffer.isBuffer(message)) {
      const decoded = decodeDataFrame(message);
      if (decoded.kind === "ok" && decoded.frame.kind === "output") {
        const { terminalId, seq } = decoded.frame;
        this.armed = false;
        this.paused = true;
        route.send(JSON.stringify({ type: "output-gap", terminalId, fromSeq: seq, toSeq: seq }));
        return;
      }
    }
    route.send(message);
  }
}
