import type { ServerMessage } from "@ttyroom/protocol";
import { expect } from "vitest";

export function expectMessageToMatch(
  received: ServerMessage[],
  type: ServerMessage["type"],
  partial: object,
): void {
  const sameType = received.filter((m) => m.type === type);
  const matched = sameType.some((m) => !failsPartialMatch(m, partial));
  if (matched) return;

  throw new Error(
    `type "${type}"에 부합하는 메시지 없음 — received types: ${received.map((m) => m.type).join(", ") || "(없음)"}` +
      (sameType[0] ? `\n같은 type의 첫 메시지: ${JSON.stringify(sameType[0])}` : ""),
  );
}

export function expectNoMessage(received: ServerMessage[], type: ServerMessage["type"]): void {
  const found = received.find((m) => m.type === type);
  if (!found) return;

  throw new Error(`금지된 type "${type}" 메시지가 수신됨: ${JSON.stringify(found)}`);
}

function failsPartialMatch(message: ServerMessage, partial: object): boolean {
  try {
    expect(message).toEqual(expect.objectContaining(partial));
    return false;
  } catch {
    return true;
  }
}
