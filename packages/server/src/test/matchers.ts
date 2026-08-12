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
      (sameType[0] ? `\n같은 type의 첫 메시지: ${JSON.stringify(sameType[0])}` : ""),
  );
}

export function expectNoMessage(received: ServerMessage[], type: ServerMessage["type"]): void {
  const found = received.find((m) => m.type === type);
  if (!found) return;

  throw new Error(`금지된 type "${type}" 메시지가 수신됨: ${JSON.stringify(found)}`);
}

// vitest 무의존 — 킷이 테스트 러너에 묶이지 않게 순수 비교로 구현한다.
// 의미론은 expect.objectContaining과 동일: 최상위 키는 부분 집합, 값은 깊은 동등.
function matchesPartial(message: ServerMessage, partial: object): boolean {
  const record = message as Record<string, unknown>;
  return Object.entries(partial).every(([key, want]) => deepEquals(record[key], want));
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEquals(item, b[i]));
  }

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEquals(aRecord[key], bRecord[key]));
}
