import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  legacyClientMessageSchema,
  parseClientMessage,
  parseServerMessage,
  roomEventSchema,
  serverMessageSchema,
} from "./messages.js";

const MIN_DOCUMENTED_EXAMPLES = 28;

interface DocumentedExample {
  json: string;
  direction: "client" | "server" | "event";
}

function extractControlMessageExamples(markdown: string): DocumentedExample[] {
  const examples: DocumentedExample[] = [];
  let direction: DocumentedExample["direction"] | null = null;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("#")) {
      direction = directionOf(line);
      continue;
    }
    if (direction === null) continue;
    if (!line.startsWith("|")) continue;
    const match = line.match(/`(\{.*\})`/);
    if (match?.[1] !== undefined) examples.push({ json: match[1], direction });
  }
  return examples;
}

function directionOf(heading: string): DocumentedExample["direction"] | null {
  if (heading.includes("서버 →")) return "server";
  if (heading.includes("→ 서버")) return "client";
  if (heading.includes("event 종류")) return "event";
  return null;
}

function parseEventExample(json: string): { kind: "ok" } | { kind: "bad-message"; reason: string } {
  const result = roomEventSchema.safeParse(JSON.parse(json));
  return result.success ? { kind: "ok" } : { kind: "bad-message", reason: result.error.message };
}

describe("PROTOCOL.md 드리프트 가드 — 역할: 문서 예시와 스키마의 동기 강제", () => {
  const doc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "PROTOCOL.md"),
    "utf8",
  );
  const examples = extractControlMessageExamples(doc);

  it("제어 메시지·event 섹션에서 예시 JSON을 빠짐없이 추출한다", () => {
    expect(examples.length).toBeGreaterThanOrEqual(MIN_DOCUMENTED_EXAMPLES);
  });

  it("모든 예시 JSON은 문서 섹션 방향에 대응하는 스키마를 통과한다", () => {
    for (const example of examples) {
      const parse =
        example.direction === "client"
          ? parseClientMessage
          : example.direction === "server"
            ? parseServerMessage
            : parseEventExample;
      const result = parse(example.json);
      if (result.kind !== "ok") {
        throw new Error(
          `PROTOCOL.md ${example.direction} 예시가 스키마와 어긋남: ${example.json}\n→ ${result.reason}`,
        );
      }
    }
  });

  it("스키마의 모든 메시지 type·event kind는 문서에 예시가 있다 — 문서화 없는 스키마 확장 차단", () => {
    const documented = (direction: DocumentedExample["direction"], key: "type" | "kind") =>
      new Set(
        examples
          .filter((example) => example.direction === direction)
          .map((example) => (JSON.parse(example.json) as Record<string, unknown>)[key]),
      );
    expect(documented("client", "type")).toEqual(
      new Set(legacyClientMessageSchema.options.map((option) => option.shape.type.value)),
    );
    expect(documented("server", "type")).toEqual(
      new Set(serverMessageSchema.options.map((option) => option.shape.type.value)),
    );
    expect(documented("event", "kind")).toEqual(
      new Set(roomEventSchema.options.map((option) => option.shape.kind.value)),
    );
  });
});

it("v8 Markdown examples match shared Java/TypeScript wire fixtures and parsers", () => {
  const markdown = readFileSync(new URL("../AUTHENTICATION_V8.md", import.meta.url), "utf8");
  const fixtures = JSON.parse(
    readFileSync(new URL("../fixtures/wire-v8.json", import.meta.url), "utf8"),
  ) as Record<string, { type: string }>;
  const examples = [
    ...markdown.matchAll(/<!-- wire-example: ([\w-]+) -->\s*```json\s*([\s\S]*?)```/g),
  ];

  const names = examples.map(([, name]) => name);

  expect(names).toEqual(Object.keys(fixtures));
  for (const [, name, raw] of examples) {
    const expected = fixtures[name!];
    const parsed = expected?.type === "hello" ? parseClientMessage(raw!) : parseServerMessage(raw!);
    expect(JSON.parse(raw!)).toEqual(expected);
    expect(parsed).toEqual({ kind: "ok", message: expected });
  }
});
