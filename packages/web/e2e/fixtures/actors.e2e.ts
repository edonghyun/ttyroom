import { expect, test } from "./actors.js";
import { RoomPage } from "../pages/room.page.js";

test("participants use isolated browser identities that survive their own reload", async ({
  alice,
  bob,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();

  const aliceClientId = await alice.clientId();
  const bobClientId = await bob.clientId();

  expect(aliceClientId).not.toBe(bobClientId);
  await alice.reloadRoom();
  expect(await alice.clientId()).toBe(aliceClientId);
  expect(await bob.clientId()).toBe(bobClientId);
});

test("two tabs in one browser stay connected as distinct participants", async ({
  browser,
  testSystem,
}) => {
  const context = await browser.newContext();
  const alicePage = await context.newPage();
  const bobPage = await context.newPage();
  const alice = new RoomPage(alicePage);
  const bob = new RoomPage(bobPage);

  try {
    await alicePage.goto(testSystem.room.joinUrl);
    await alice.joinAs("Alice");
    await bobPage.goto(testSystem.room.joinUrl);
    await bob.joinAs("Bob");

    await expect(alice.connectionStatus("Connected")).toBeVisible();
    await expect(bob.connectionStatus("Connected")).toBeVisible();
    await expect(alicePage.getByRole("list", { name: "Participant presence" })).toContainText(
      "Bob",
    );
    await expect(bobPage.getByRole("list", { name: "Participant presence" })).toContainText(
      "Alice",
    );
  } finally {
    await context.close();
  }
});
