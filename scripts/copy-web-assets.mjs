import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(repositoryRoot, "packages/web/dist");
const target = resolve(repositoryRoot, "packages/server/dist/web");

const sourceInfo = await stat(source).catch(() => null);
if (!sourceInfo?.isDirectory()) {
  throw new Error(`Web build output is missing: ${source}`);
}

await mkdir(dirname(target), { recursive: true });
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
