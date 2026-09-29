import { expect, test as base } from "@playwright/test";
import { BrowserParticipantActor } from "./participant-actor.js";
import { TestSystem } from "./test-system.js";

interface ActorFixtures {
  testSystem: TestSystem;
  alice: BrowserParticipantActor;
  bob: BrowserParticipantActor;
}

export const test = base.extend<ActorFixtures>({
  testSystem: async ({}, use) => {
    const system = await TestSystem.start();
    await use(system);
    await system.dispose();
  },
  alice: async ({ browser, testSystem }, use, info) => {
    const actor = await testSystem.participant(browser, "Alice");
    await use(actor);
    if (info.status !== info.expectedStatus)
      await info.attach("alice-wire-order", {
        body: actor.wireDiagnostics(),
        contentType: "application/json",
      });
  },
  bob: async ({ browser, testSystem }, use, info) => {
    const actor = await testSystem.participant(browser, "Bob");
    await use(actor);
    if (info.status !== info.expectedStatus)
      await info.attach("bob-wire-order", {
        body: actor.wireDiagnostics(),
        contentType: "application/json",
      });
  },
});

export { expect };
