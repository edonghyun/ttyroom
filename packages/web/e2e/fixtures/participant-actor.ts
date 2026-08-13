import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { RoomPage } from "../pages/room.page.js";
import type { TestRoom } from "./test-system.js";

export class BrowserParticipantActor {
  readonly roomPage: RoomPage;
  private readonly errors: Error[] = [];
  private readonly expectedConsoleErrors: RegExp[] = [];
  private disposed = false;

  private constructor(
    readonly nickname: string,
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly room: TestRoom,
  ) {
    this.roomPage = new RoomPage(page);
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
    await context.addInitScript(() => {
      const NativeWebSocket = globalThis.WebSocket;
      const sockets = new Set<WebSocket>();
      class ObservableWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.add(this);
          this.addEventListener("close", () => sockets.delete(this), { once: true });
        }
      }
      globalThis.WebSocket = ObservableWebSocket;
      Object.defineProperty(globalThis, "__ttyroomCloseTestSockets", {
        value: () => {
          for (const socket of sockets) socket.close();
        },
      });
    });
    const page = await context.newPage();
    return new BrowserParticipantActor(nickname, context, page, room);
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
    const roomId = this.room.roomId;
    return this.page.evaluate((id) => {
      const raw = sessionStorage.getItem(`ttyroom:identity:v1:${encodeURIComponent(id)}`);
      const parsed = raw ? (JSON.parse(raw) as { clientId?: unknown }) : null;
      if (!parsed || typeof parsed.clientId !== "string") throw new Error("clientId not persisted");
      return parsed.clientId;
    }, roomId);
  }

  async goOffline(): Promise<void> {
    await this.context.setOffline(true);
    this.expectedConsoleErrors.push(/WebSocket connection to .* failed/);
    await this.page.evaluate(() => {
      const closeSockets = (
        globalThis as typeof globalThis & { __ttyroomCloseTestSockets?: () => void }
      ).__ttyroomCloseTestSockets;
      if (!closeSockets) throw new Error("test socket control was not installed");
      closeSockets();
    });
  }

  async goOnline(): Promise<void> {
    await this.context.setOffline(false);
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
