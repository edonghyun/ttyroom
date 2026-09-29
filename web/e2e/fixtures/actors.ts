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
  alice: async ({ browser, testSystem }, use) => {
    await use(await testSystem.participant(browser, "Alice"));
  },
  bob: async ({ browser, testSystem }, use) => {
    await use(await testSystem.participant(browser, "Bob"));
  },
});

export { expect };
