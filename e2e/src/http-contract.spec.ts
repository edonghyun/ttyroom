import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { HttpContract } from "./http-contract.js";

let contract: HttpContract;
beforeAll(async () => {
  contract = await HttpContract.load();
});

it("rejects a successful revocation response without its required no-store header", () => {
  const response = { status: 204, headers: new Headers(), body: "" };

  const violations = contract.responseViolations("revokeParticipant", response);

  expect(violations).toContain("Missing response header: Cache-Control");
});

it("validates every request and response example against the OpenAPI schemas", () => {
  expect(contract.exampleViolations()).toEqual([]);
});

it.each([
  { name: "missing identity", body: { credential: "B".repeat(32) } },
  {
    name: "extra authority",
    body: {
      participantId: "b3bb1eca-9e65-4b54-87ad-d491f16c9f09",
      credential: "B".repeat(32),
      managerCredential: "M".repeat(32),
    },
  },
  {
    name: "invalid secret format",
    body: { participantId: "b3bb1eca-9e65-4b54-87ad-d491f16c9f09", credential: "short" },
  },
])("rejects response drift: $name", ({ body }) => {
  const observed = {
    status: 201,
    headers: new Headers({ "content-type": "application/json", "cache-control": "no-store" }),
    body: JSON.stringify(body),
  };

  const violations = contract.responseViolations("registerParticipant", observed);

  expect(violations).toContain("Response body violates schema");
});

it.each([
  {
    name: "undeclared status",
    status: 200,
    body: "",
    headers: { "cache-control": "no-store" },
    expected: "Undocumented response status: 200",
  },
  {
    name: "nonempty 204",
    status: 204,
    body: "{}",
    headers: { "cache-control": "no-store" },
    expected: "Expected empty response body",
  },
  {
    name: "cacheable credential response",
    status: 204,
    body: "",
    headers: { "cache-control": "public" },
    expected: "Response header violates schema: Cache-Control",
  },
])("rejects envelope drift: $name", ({ status, body, headers, expected }) => {
  const violations = contract.responseViolations("revokeHost", {
    status,
    body,
    headers: new Headers(headers),
  });

  expect(violations).toContain(expected);
});

it("keeps the labeled Markdown response examples equal to the machine-readable specification", () => {
  const markdown = readFileSync(new URL("../../protocol/HTTP.md", import.meta.url), "utf8");
  const examples = [
    ...markdown.matchAll(/<!-- http-example: (\w+) (\d+) -->\s*```json\s*([\s\S]*?)```/g),
  ];

  const documented = examples.map(([, operation, status]) => `${operation}/${status}`);
  const comparisons = examples.map(([, operation, status, body]) => ({
    documented: JSON.parse(body!),
    specified: contract.responseExample(operation!, Number(status)),
  }));

  expect(documented).toEqual([
    "createRoom/201",
    "registerParticipant/201",
    "registerHost/201",
    "registerHost/403",
    "revokeParticipant/403",
  ]);
  for (const comparison of comparisons) expect(comparison.documented).toEqual(comparison.specified);
});
