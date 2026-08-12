import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StaticWebApp } from "./static-web-app.js";

describe("StaticWebApp", () => {
  let root: string;
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ttyroom-web-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<!doctype html><main>TTYRoom app</main>");
    await writeFile(join(root, "assets", "index-Ab12.js"), "console.log('ttyroom')");
    const app = new StaticWebApp({ root });
    const server = createServer((request, response) => {
      void app.handle(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end("not found");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    close = () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });

  afterEach(async () => {
    await close();
    await rm(root, { recursive: true });
  });

  it("serves hashed assets with immutable cache and a strict type", async () => {
    const response = await fetch(`${baseUrl}/assets/index-Ab12.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toContain("ttyroom");
  });

  it.each(["/", "/r/room-1"])("serves SPA HTML without caching at %s", async (pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await response.text()).toContain("TTYRoom app");
  });

  it("supports HEAD without returning a body", async () => {
    const response = await fetch(`${baseUrl}/assets/index-Ab12.js`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String("console.log('ttyroom')".length));
    expect(await response.text()).toBe("");
  });

  it.each([
    "/assets/missing-Ab12.js",
    "/assets/../index.html",
    "/assets/%2e%2e/index.html",
    "/assets/%2fetc/passwd",
  ])("returns 404 instead of SPA fallback for unsafe or missing asset %s", async (pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("TTYRoom app");
  });

  it.each(["/api/rooms", "/healthz", "/ws"])("does not claim server route %s", async (pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`);
    expect(response.status).toBe(404);
  });
});
