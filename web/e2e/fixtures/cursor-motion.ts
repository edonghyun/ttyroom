import type { BrowserParticipantActor } from "./participant-actor.js";

/** A timed animation sample, not a sleep used to infer server completion. */
export async function sampleCursorMotion(
  alice: BrowserParticipantActor,
  bob: BrowserParticipantActor,
) {
  const scene = await alice.page.locator(".terminal-scene").boundingBox();
  if (!scene) throw new Error("scene geometry unavailable");
  await alice.page.mouse.move(scene.x + 420, scene.y + 260);
  await bob.page.getByLabel("Alice cursor").waitFor({ state: "visible" });
  const ownCursorCount = await alice.page.getByLabel("Alice cursor").count();
  const motion = bob.page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const transforms: string[] = [];
        const start = performance.now();
        const sample = () => {
          const cursor = document.querySelector<HTMLElement>('[aria-label="Alice cursor"]');
          if (cursor) transforms.push(cursor.style.transform);
          if (performance.now() - start < 500) requestAnimationFrame(sample);
          else resolve(transforms);
        };
        requestAnimationFrame(sample);
      }),
  );
  for (let step = 1; step <= 24; step++) {
    await alice.page.mouse.move(scene.x + 420 + step * 10, scene.y + 260 + Math.sin(step / 3) * 40);
    await alice.page.waitForTimeout(12);
  }
  return { ownCursorCount, transforms: await motion };
}
