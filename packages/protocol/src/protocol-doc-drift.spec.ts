import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage } from "./messages.js";

// 제어 메시지 예시 최소 개수 — 예시 추가는 허용, 추출 로직 회귀(0건 매치)는 차단
const MIN_DOCUMENTED_EXAMPLES = 18;

interface DocumentedExample {
  json: string;
  direction: "client" | "server";
}

function extractControlMessageExamples(markdown: string): DocumentedExample[] {
  const examples: DocumentedExample[] = [];
  let direction: DocumentedExample["direction"] | null = null;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("#")) {
      // "### 서버 → …"는 서버 발신, "### … → 서버"는 클라이언트 발신, 그 외 섹션은 예시 없음
      direction = line.includes("서버 →") ? "server" : line.includes("→ 서버") ? "client" : null;
      continue;
    }
    if (direction === null) continue;
    // 정식 예시는 표 행에만 있다 — 본문의 형태 설명(placeholder 포함)은 제외
    if (!line.startsWith("|")) continue;
    const match = line.match(/`(\{.*\})`/);
    if (match?.[1] !== undefined) examples.push({ json: match[1], direction });
  }
  return examples;
}

describe("PROTOCOL.md 드리프트 가드 — 역할: 문서 예시와 스키마의 동기 강제", () => {
  const doc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "PROTOCOL.md"),
    "utf8",
  );
  const examples = extractControlMessageExamples(doc);

  it("제어 메시지 섹션에서 예시 JSON을 빠짐없이 추출한다", () => {
    expect(examples.length).toBeGreaterThanOrEqual(MIN_DOCUMENTED_EXAMPLES);
  });

  it("모든 예시 JSON은 문서 섹션 방향에 대응하는 스키마를 통과한다", () => {
    for (const example of examples) {
      const parse = example.direction === "client" ? parseClientMessage : parseServerMessage;
      const result = parse(example.json);
      if (result.kind !== "ok") {
        throw new Error(
          `PROTOCOL.md ${example.direction} 예시가 스키마와 어긋남: ${example.json}\n→ ${result.reason}`,
        );
      }
    }
  });
});
