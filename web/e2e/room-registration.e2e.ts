import { test, expect } from "./fixtures/actors.js";
import { RoomPage } from "./pages/room.page.js";

async function openHostDrawer(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Open room menu" }).click();
  await page.getByRole("menuitem", { name: "Add host" }).click();
}

test("the creator registers hosts with separate manager authority and a secret-free command", async ({
  page,
  testSystem,
}) => {
  await page.goto(new URL("/", testSystem.room.joinUrl).href);
  await page.getByRole("textbox", { name: "Room name" }).fill("Managed room");
  await page.getByRole("button", { name: "Create room" }).click();
  await new RoomPage(page).joinAs("Owner");
  await openHostDrawer(page);

  const registration = page.waitForResponse(
    (response) => response.url().endsWith("/hosts") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate host credential", exact: true }).click();
  const response = await registration;
  const command = await page.getByLabel("Host connection command").innerText();
  const authority = await page.evaluate(() => {
    const roomId = location.pathname.split("/").at(-1)!;
    const manager = sessionStorage.getItem(`ttyroom:manager:v1:${roomId}`);
    const participant = JSON.parse(
      sessionStorage.getItem(`ttyroom:identity:v1:${roomId}`)!,
    ).registration;
    return {
      separate: Boolean(manager && participant.credential && manager !== participant.credential),
      managerInUrl: location.href.includes(manager ?? "missing-manager"),
    };
  });

  expect(response.status()).toBe(201);
  expect(authority).toEqual({ separate: true, managerInUrl: false });
  expect(command).toBe(`node connector/dist/index.js join '${page.url().split("#")[0]}'`);
  await expect(page.getByRole("button", { name: "Copy host credential" })).toBeVisible();
});

test("an invited participant cannot register a host with the invitation", async ({ alice }) => {
  await alice.joinRoom();
  await openHostDrawer(alice.page);
  const registrations: string[] = [];
  alice.page.on("request", (request) => {
    if (request.url().endsWith("/hosts")) registrations.push(request.method());
  });

  await alice.page.getByRole("button", { name: "Generate host credential", exact: true }).click();

  await expect(alice.page.getByRole("alert")).toContainText("Only the room creator");
  expect(registrations).toEqual([]);
});

test("an invalid saved participant credential stops admission without registering another subject", async ({
  alice,
}) => {
  await alice.joinRoom();
  const registrations: string[] = [];
  alice.page.on("request", (request) => {
    if (request.url().endsWith("/participants")) registrations.push(request.method());
  });
  await alice.page.evaluate(() => {
    const roomId = location.pathname.split("/").at(-1)!;
    const key = `ttyroom:identity:v1:${roomId}`;
    const identity = JSON.parse(sessionStorage.getItem(key)!);
    identity.registration.credential = "x".repeat(32);
    sessionStorage.setItem(key, JSON.stringify(identity));
  });

  await alice.page.reload();

  await expect(alice.page.getByRole("heading", { name: "Access unavailable" })).toBeVisible();
  expect(registrations).toEqual([]);
});
