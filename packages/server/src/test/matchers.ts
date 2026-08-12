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

// vitest 무의존 — 킷이 테스트 러너에 묶이지 않게 순수 비교로 구현한다.
// 의미론은 모든 깊이에서 partial: 객체는 기대한 키만 검사(부분 집합), 배열은 길이 일치 +
// 원소별 partial, 리프는 Object.is. 계획 Task 6의
// `snapshot: { participants: [{ name: "alice" }] }` 같은 중첩 부분 단언이 이 의미론을 요구한다.
function matchesPartial(message: ServerMessage, partial: object): boolean {
  return matchesWant(message, partial);
}

function matchesWant(got: unknown, want: unknown): boolean {
  if (Object.is(got, want)) return true;
  if (typeof want !== "object" || want === null) return false;
  if (typeof got !== "object" || got === null) return false;

  if (Array.isArray(want) || Array.isArray(got)) {
    if (!Array.isArray(want) || !Array.isArray(got) || want.length !== got.length) return false;
    return want.every((item, i) => matchesWant(got[i], item));
  }

  const gotRecord = got as Record<string, unknown>;
  return Object.entries(want).every(([key, value]) => matchesWant(gotRecord[key], value));
}
