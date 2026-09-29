import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerProcess } from "./server-process.js";

describe("배포 웹 파일 — Node·Spring 공통", () => {
  let server: ServerProcess;
  let script: string;
  beforeAll(async () => {
    server = await ServerProcess.start();
    try {
      const html = await (await fetch(server.baseUrl)).text();
      const match = html.match(/src="(\/assets\/[^"/]+\.js)"/);
      if (!match?.[1]) throw new Error("Built web entry with a script asset is required");
      script = match[1];
    } catch (error) {
      await server.close();
      throw error;
    }
  });
  afterAll(async () => {
    await server?.close();
  });

  it.each(["/", "/r/deep-link"])("%s에서 SPA와 보안·비캐시 헤더를 제공한다", async (path) => {
    const response = await fetch(server.baseUrl + path);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html;\s*charset=utf-8$/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html).toContain(script);
  });

  it("실제 빌드 자산의 GET·HEAD는 같은 길이와 캐시 정책을 제공한다", async () => {
    const get = await fetch(server.baseUrl + script);
    const body = await get.arrayBuffer();
    const head = await fetch(server.baseUrl + script, { method: "HEAD" });
    const headBody = await head.text();

    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toMatch(/^text\/javascript;\s*charset=utf-8$/i);
    expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(body.byteLength).toBeGreaterThan(0);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(body.byteLength));
    expect(headBody).toBe("");
  });

  it.each([
    "/assets/missing.js",
    "/assets/../index.html",
    "/assets/%2e%2e/index.html",
    "/api/missing",
    "/r/a/b",
  ])("%s는 HTML fallback으로 숨기지 않는다", async (path) => {
    const response = await fetch(server.baseUrl + path);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain('<div id="root">');
  });
});
