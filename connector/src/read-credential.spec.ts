import { PassThrough } from "node:stream";
import type { ReadStream } from "node:tty";
import { describe, expect, it, vi } from "vitest";
import { readCredential } from "./read-credential.js";

function inputScenario(tty = true) {
  const stream = Object.assign(new PassThrough(), {
    isTTY: tty,
    isRaw: false,
    setRawMode: vi.fn(),
  });
  const prompt = vi.fn();
  const credential = readCredential(stream as unknown as ReadStream, prompt);
  return { stream, prompt, credential };
}

describe("hidden credential input", () => {
  it("accepts split input and returns the terminal to normal input without echoing the secret", async () => {
    const scenario = inputScenario();

    scenario.stream.write("h".repeat(12));
    scenario.stream.write("h".repeat(20) + "\r");
    const credential = await scenario.credential;

    expect(credential).toBe("h".repeat(32));
    expect(scenario.prompt.mock.calls).toEqual([["Host credential: "]]);
    expect(scenario.stream.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(scenario.stream.listenerCount("data")).toBe(0);
  });

  it("accepts a piped secret terminated by EOF", async () => {
    const scenario = inputScenario(false);

    scenario.stream.end("h".repeat(32));
    const credential = await scenario.credential;

    expect(credential).toBe("h".repeat(32));
    expect(scenario.stream.setRawMode).not.toHaveBeenCalled();
  });

  it.each(["short\n", "x".repeat(33), "\x03", " ".repeat(32) + "\n"])(
    "rejects invalid or cancelled input without exposing it (%#)",
    async (input) => {
      const scenario = inputScenario();
      const failure = expect(scenario.credential).rejects.toThrow();

      scenario.stream.write(input);

      await failure;
      expect(scenario.prompt.mock.calls).toEqual([["Host credential: "]]);
      expect(scenario.stream.setRawMode).toHaveBeenLastCalledWith(false);
      expect(scenario.stream.listenerCount("data")).toBe(0);
    },
  );
});
