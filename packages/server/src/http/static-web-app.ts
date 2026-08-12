import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "),
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export class StaticWebApp {
  private readonly root: string;

  constructor(options: { readonly root: string }) {
    this.root = resolve(options.root);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    const rawPath = (request.url ?? "/").split("?", 1)[0] ?? "/";
    if (rawPath.startsWith("/api/") || rawPath === "/healthz" || rawPath === "/ws") return false;

    if (rawPath.startsWith("/assets/")) {
      const asset = this.assetPath(rawPath);
      if (!asset) {
        this.notFound(response);
        return true;
      }
      await this.sendFile(request, response, asset, "public, max-age=31536000, immutable");
      return true;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      this.notFound(response);
      return true;
    }
    if (pathname === "/" || /^\/r\/[^/]+$/.test(pathname)) {
      await this.sendFile(request, response, resolve(this.root, "index.html"), "no-store");
      return true;
    }

    return false;
  }

  private assetPath(rawPath: string): string | null {
    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      return null;
    }
    if (!/^\/assets\/[A-Za-z0-9._-]+$/.test(pathname)) return null;
    const candidate = resolve(this.root, `.${pathname}`);
    const assetsRoot = resolve(this.root, "assets");
    return candidate.startsWith(`${assetsRoot}${sep}`) ? candidate : null;
  }

  private async sendFile(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    cacheControl: string,
  ): Promise<void> {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error("not a file");
      const type = CONTENT_TYPES[extname(path).toLowerCase()];
      if (!type) {
        this.notFound(response);
        return;
      }
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "cache-control": cacheControl,
        "content-length": metadata.size,
        "content-type": type,
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      response.end(await readFile(path));
    } catch {
      this.notFound(response);
    }
  }

  private notFound(response: ServerResponse): void {
    response.writeHead(404, {
      ...SECURITY_HEADERS,
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("not found");
  }
}
