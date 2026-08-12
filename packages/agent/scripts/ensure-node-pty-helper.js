// node-pty 1.1.0 배포 tarball은 prebuilds/*/spawn-helper를 0644로 담고 있다(업스트림 패키징 결함).
// 실행 비트가 없으면 pty.fork의 posix_spawnp가 실패하므로 설치 후 복구한다.
// tarball 검증: tar -tvzf node-pty-1.1.0.tgz → "-rw-r--r-- ... prebuilds/darwin-arm64/spawn-helper"
import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";

if (process.platform !== "win32") {
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
  const helper = path.join(
    packageRoot,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );

  if (existsSync(helper)) chmodSync(helper, 0o755);
}
