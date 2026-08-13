import type { ServerMessage } from "@ttyroom/protocol";

export function expectMessageToMatch(
  received: ServerMessage[],
  type: ServerMessage["type"],
  partial: object,
): void {
  const sameType = received.filter((m) => m.type === type);
  const matched = sameType.some((m) => matchesPartial(m, partial));
  if (matched) return;

  throw new Error(
    `type "${type}"에 부합하는 메시지 없음 — received types: ${received.map((m) => m.type).join(", ") || "(없음)"}` +
      `\n기대 partial: ${JSON.stringify(partial)}` +
      (sameType[0] ? `\n같은 type의 첫 메시지: ${JSON.stringify(sameType[0])}` : ""),
  );
}

export function expectNoMessage(received: ServerMessage[], type: ServerMessage["type"]): void {
  const found = received.find((m) => m.type === type);
  if (!found) return;

  throw new Error(`금지된 type "${type}" 메시지가 수신됨: ${JSON.stringify(found)}`);
}

function matchesPartial(message: ServerMessage, partial: object): boolean {
  return isDeepPartialMatch(message, partial);
}

function isDeepPartialMatch(got: unknown, want: unknown): boolean {
  if (Object.is(got, want)) return true;
  if (typeof want !== "object" || want === null) return false;
  if (typeof got !== "object" || got === null) return false;

  if (Array.isArray(want) || Array.isArray(got)) {
    if (!Array.isArray(want) || !Array.isArray(got) || want.length !== got.length) return false;
    return want.every((item, i) => isDeepPartialMatch(got[i], item));
  }

  const gotRecord = got as Record<string, unknown>;
  return Object.entries(want).every(([key, value]) => isDeepPartialMatch(gotRecord[key], value));
}
