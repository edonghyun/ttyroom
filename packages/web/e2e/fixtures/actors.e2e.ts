import { expect, test } from "./actors.js";

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
