import { expect, type Locator, type Page } from "@playwright/test";

export class RoomPage {
  constructor(private readonly page: Page) {}

  async clientId(): Promise<string> {
    return this.page.evaluate(() => {
      const roomId = decodeURIComponent(location.pathname.split("/").at(-1)!);
      const raw = sessionStorage.getItem(`ttyroom:identity:v1:${encodeURIComponent(roomId)}`);
      const parsed = raw
        ? (JSON.parse(raw) as { registration?: { participantId?: unknown } })
        : null;
      if (!parsed || typeof parsed.registration?.participantId !== "string")
        throw new Error("clientId not persisted");
      return parsed.registration.participantId;
    });
  }

  async joinAs(nickname: string): Promise<void> {
    await this.page.getByRole("textbox", { name: "Nickname" }).fill(nickname);
    await this.page.getByRole("button", { name: "Join room" }).click();
    await expect(this.page.getByRole("region", { name: "Terminal workspace" })).toBeVisible();
  }

  async reload(nickname: string): Promise<void> {
    await this.page.reload();
    const nicknameInput = this.page.getByRole("textbox", { name: "Nickname" });
    if (await nicknameInput.isVisible()) await this.joinAs(nickname);
    await expect(this.page.getByRole("region", { name: "Terminal workspace" })).toBeVisible();
  }

  async openTerminal(expectedTitle = "term-1"): Promise<void> {
    await this.page.getByRole("button", { name: "Add terminal" }).click();
    await expect(this.terminal(expectedTitle)).toBeVisible();
  }

  terminal(title: string): Locator {
    return this.page.getByRole("group", { name: `${title} terminal` });
  }

  terminalStatus(title: string): Locator {
    return this.terminal(title).getByRole("status");
  }

  async waitForTerminalStatus(title: string, name: string): Promise<string | null> {
    let observed: string | null = null;
    await expect
      .poll(async () => (observed = await this.terminalStatus(title).getAttribute("aria-label")))
      .toBe(name);
    return observed;
  }

  async takeControl(title: string): Promise<void> {
    await this.terminal(title)
      .getByRole("button", { name: `Take control of ${title}` })
      .click();
  }

  async switchControl(title: string): Promise<void> {
    await this.terminal(title)
      .getByRole("button", { name: `Switch control to ${title}` })
      .click();
  }

  async typeInTerminal(title: string, command: string): Promise<void> {
    await this.terminal(title).getByLabel(`${title} output`).click();
    await this.page.keyboard.type(command);
    await this.page.keyboard.press("Enter");
  }

  /** Splitting the literal keeps shell command echo from looking like executed output. */
  async printLine(title: string, text: string): Promise<void> {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const middle = Math.ceil(text.length / 2);
    await this.typeInTerminal(
      title,
      `printf '%s%s\\n' ${quote(text.slice(0, middle))} ${quote(text.slice(middle))}`,
    );
  }

  /** Bounded observation; returns the actual screen text without removing repeated output. */
  async outputContaining(title: string, text: string): Promise<string> {
    let observed = "";
    await expect.poll(async () => (observed = await this.terminalText(title))).toContain(text);
    return observed;
  }

  async waitForConnection(state: "Connected" | "Reconnecting" | "Restoring"): Promise<string> {
    const status = this.connectionStatus(state);
    await status.waitFor({ state: "visible" });
    return status.innerText();
  }

  async sendTerminalInputFrame(title: string, command: string): Promise<void> {
    await this.terminal(title).getByLabel(`${title} output`).click();
    await this.page.keyboard.insertText(`${command}\r`);
  }

  async requestClose(title: string): Promise<void> {
    await this.terminal(title)
      .getByRole("button", { name: `Close ${title}` })
      .click();
  }

  closeDialog(): Locator {
    return this.page.getByRole("alertdialog", { name: /^Close .+\?$/ });
  }

  async cancelClose(): Promise<void> {
    await this.closeDialog().getByRole("button", { name: "Cancel" }).click();
  }

  async confirmClose(): Promise<void> {
    await this.closeDialog().getByRole("button", { name: "Close terminal" }).click();
  }

  async setTerminalMode(title: string, mode: "Shared" | "Exclusive"): Promise<void> {
    await this.terminal(title)
      .getByRole("button", { name: `Open ${title} menu` })
      .click();
    await this.page.getByRole("menuitem", { name: `Use ${mode.toLowerCase()} input` }).click();
  }

  async renameTerminal(currentTitle: string, nextTitle: string): Promise<void> {
    await this.terminal(currentTitle)
      .getByRole("button", { name: `Open ${currentTitle} menu` })
      .click();
    await this.page.getByRole("menuitem", { name: "Rename terminal" }).click();
    await this.page.getByRole("textbox", { name: "Terminal name" }).fill(nextTitle);
    await this.page.getByRole("button", { name: "Save name" }).click();
  }

  dockTerminals(): Locator {
    return this.page.getByRole("complementary", { name: "Terminal Dock" }).getByRole("button", {
      name: /^(Focus|Restore) term-\d+$/,
    });
  }

  async minimize(title: string): Promise<void> {
    await this.terminal(title)
      .getByRole("button", { name: `Minimize ${title}` })
      .click();
  }

  async enterOverview(): Promise<void> {
    await this.page.getByRole("button", { name: "Open overview" }).click();
    await expect(this.page.getByRole("region", { name: "Terminal overview" })).toBeVisible();
  }

  connectionStatus(state: "Connected" | "Reconnecting" | "Restoring"): Locator {
    return this.page.getByRole("status").filter({ hasText: new RegExp(`^${state}$`) });
  }

  async recordConnectionStates(): Promise<void> {
    await this.page.evaluate(() => {
      const state = { values: [] as string[] };
      const record = () => {
        const value = document.querySelector<HTMLElement>(".connection")?.innerText;
        if (value && state.values.at(-1) !== value) state.values.push(value);
      };
      record();
      new MutationObserver(record).observe(document.body, { childList: true, subtree: true });
      Object.defineProperty(globalThis, "__ttyroomConnectionStateHistory", { value: state });
    });
  }

  async recordedConnectionStates(): Promise<string[]> {
    return this.page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __ttyroomConnectionStateHistory?: { values: string[] };
          }
        ).__ttyroomConnectionStateHistory?.values ?? [],
    );
  }

  async roomLayoutKeys(): Promise<string[]> {
    return this.page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith("ttyroom:layout:v1:")),
    );
  }

  async exitOverview(): Promise<void> {
    await this.page.getByRole("button", { name: "Exit overview" }).click();
  }

  async terminalText(title: string): Promise<string> {
    // xterm's row implementation is deliberately isolated at this acceptance seam.
    return this.terminal(title).locator(".xterm-rows").innerText();
  }

  async terminalRect(
    title: string,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const rect = await this.terminal(title).boundingBox();
    if (!rect) throw new Error(`${title} has no visible layout rectangle`);
    return rect;
  }

  async moveTerminal(title: string, delta: { x: number; y: number }): Promise<void> {
    const titleBar = this.terminal(title).locator(".terminal-titlebar");
    const rect = await titleBar.boundingBox();
    if (!rect) throw new Error(`${title} title bar is not visible`);
    const start = { x: rect.x + 20, y: rect.y + 20 };
    await this.page.mouse.move(start.x, start.y);
    await this.page.mouse.down();
    await this.page.mouse.move(start.x + delta.x, start.y + delta.y);
    await this.page.mouse.up();
  }

  async resizeTerminal(title: string, delta: { width: number; height: number }): Promise<void> {
    const handle = this.terminal(title).getByRole("button", {
      name: `Resize ${title}`,
      exact: true,
    });
    const rect = await handle.boundingBox();
    if (!rect) throw new Error(`${title} resize handle is not visible`);
    const start = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    await this.page.mouse.move(start.x, start.y);
    await this.page.mouse.down();
    await this.page.mouse.move(start.x + delta.width, start.y + delta.height);
    await this.page.mouse.up();
  }
}
