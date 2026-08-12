import { expect, type Locator, type Page } from "@playwright/test";

export class RoomPage {
  constructor(private readonly page: Page) {}

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

  async takeControl(title: string): Promise<void> {
    await this.terminal(title).getByRole("button", { name: `Take control of ${title}` }).click();
  }

  async switchControl(title: string): Promise<void> {
    await this.terminal(title).getByRole("button", { name: `Switch control to ${title}` }).click();
  }

  async typeInTerminal(title: string, command: string): Promise<void> {
    await this.terminal(title).getByLabel(`${title} output`).click();
    await this.page.keyboard.type(command);
    await this.page.keyboard.press("Enter");
  }

  async requestClose(title: string): Promise<void> {
    await this.terminal(title).getByRole("button", { name: `Close ${title}` }).click();
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
    await this.terminal(title).getByRole("button", { name: `Open ${title} menu` }).click();
    await this.page.getByRole("menuitem", { name: `Use ${mode.toLowerCase()} input` }).click();
  }

  dockTerminals(): Locator {
    return this.page.getByRole("complementary", { name: "Terminal Dock" }).getByRole("button", {
      name: /^(Focus|Restore) term-\d+$/,
    });
  }

  async minimize(title: string): Promise<void> {
    await this.terminal(title).getByRole("button", { name: `Minimize ${title}` }).click();
  }

  async enterOverview(): Promise<void> {
    await this.page.getByRole("button", { name: "Open overview" }).click();
    await expect(this.page.getByRole("region", { name: "Terminal overview" })).toBeVisible();
  }

  async exitOverview(): Promise<void> {
    await this.page.getByRole("button", { name: "Exit overview" }).click();
  }

  async terminalText(title: string): Promise<string> {
    // xterm's row implementation is deliberately isolated at this acceptance seam.
    return this.terminal(title).locator(".xterm-rows").innerText();
  }
}
