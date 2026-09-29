import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { RoomPage } from "../pages/room.page.js";
import type { TestRoom } from "./test-system.js";

export class BrowserParticipantActor {
  readonly roomPage: RoomPage;
  private readonly errors: Error[] = [];
  private readonly expectedConsoleErrors: RegExp[] = [];
  private disposed = false;
  private readonly wireEvents: object[] = [];

  private constructor(
    readonly nickname: string,
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly room: TestRoom,
  ) {
    this.roomPage = new RoomPage(page);
    // Keep protocol ordering, never credentials or terminal contents, in failure evidence.
    page.on("websocket", (socket) => {
      const record =
        (direction: "sent" | "received") =>
        ({ payload }: { payload: string | Buffer }) => {
          let summary: object;
          if (typeof payload === "string") {
            try {
              const message = JSON.parse(payload);
              summary = { type: message.type, event: message.event?.kind, code: message.code };
            } catch {
              summary = { type: "unparsed-control", bytes: payload.length };
            }
          } else {
            summary = { bytes: payload.length, header: payload.subarray(0, 9).toString("hex") };
          }
          this.wireEvents.push({ direction, ...summary });
          if (this.wireEvents.length > 1024) this.wireEvents.shift();
        };
      socket.on("framesent", record("sent"));
      socket.on("framereceived", record("received"));
    });
    page.on("pageerror", (error) => this.errors.push(error));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !this.expectedConsoleErrors.some((pattern) => pattern.test(message.text()))
      ) {
        this.errors.push(new Error(`console: ${message.text()}`));
      }
    });
  }

  static async create(
    browser: Browser,
    room: TestRoom,
    nickname: string,
  ): Promise<BrowserParticipantActor> {
    // Every actor owns a fresh context. Sharing storageState would invalidate identity tests.
    const context = await browser.newContext();
    const page = await context.newPage();
    return new BrowserParticipantActor(nickname, context, page, room);
  }

  wireDiagnostics(): string {
    return JSON.stringify(this.wireEvents, null, 2);
  }

  async joinRoom(): Promise<void> {
    await this.page.goto(this.room.joinUrl);
    await this.roomPage.joinAs(this.nickname);
    this.assertHealthy();
  }

  async reloadRoom(): Promise<void> {
    await this.roomPage.reload(this.nickname);
    this.assertHealthy();
  }

  async clientId(): Promise<string> {
    return this.roomPage.clientId();
  }

  expectServerRestart(): void {
    const endpoint = new URL("/ws", this.room.joinUrl);
    endpoint.protocol = "ws:";
    const escaped = endpoint.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.expectedConsoleErrors.push(
      new RegExp(
        `^WebSocket connection to '${escaped}' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$`,
      ),
    );
  }

  assertHealthy(): void {
    expect(this.errors, this.errors.map((error) => error.message).join("\n")).toEqual([]);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.context.close();
  }
}
