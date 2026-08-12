import { expect, type Page } from "@playwright/test";

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
}
