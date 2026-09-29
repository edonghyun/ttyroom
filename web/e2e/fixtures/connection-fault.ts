import type { Page, WebSocketRoute } from "@playwright/test";

/** Cuts both ends of a real server connection and rejects reconnects until explicitly restored. */
export class ConnectionFault {
  private disconnected = false;
  private readonly connections: Array<{ browser: WebSocketRoute; server: WebSocketRoute }> = [];

  static async install(page: Page) {
    const fault = new ConnectionFault();
    await page.routeWebSocket("**/ws", async (browser) => {
      if (fault.disconnected) {
        await browser.close({ code: 1001, reason: "test connection unavailable" });
        return;
      }
      const server = browser.connectToServer();
      fault.connections.push({ browser, server });
    });
    return fault;
  }

  async disconnect() {
    if (this.connections.length === 0) throw new Error("No server connection to interrupt");
    this.disconnected = true;
    await Promise.all(
      this.connections
        .splice(0)
        .flatMap(({ browser, server }) => [
          browser.close({ code: 1001, reason: "test disconnect" }),
          server.close({ code: 1001, reason: "test disconnect" }),
        ]),
    );
  }

  reconnect() {
    this.disconnected = false;
  }
}
