// node-pty 1.1.0 배포 tarball은 prebuilds/*/spawn-helper를 0644로 담고 있다(업스트림 패키징 결함).
// 실행 비트가 없으면 pty.fork의 posix_spawnp가 실패하므로 설치 후 복구한다.
// tarball 검증: tar -tvzf node-pty-1.1.0.tgz → "-rw-r--r-- ... prebuilds/darwin-arm64/spawn-helper"
//
// ⚠ node-pty 1.1.0 기준 — 업그레이드 시 이 스크립트의 필요 여부와 prebuilds 레이아웃을 재검토할 것.
//   (소스 빌드 경로 build/Release는 컴파일러가 실행 비트를 주므로 이 수리가 불필요)
import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";

if (process.platform !== "win32") {
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
  const platformDir = path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`);
  const helper = path.join(platformDir, "spawn-helper");

  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
  } else if (existsSync(platformDir)) {
    // 플랫폼 prebuilds는 있는데 helper가 없다 — 레이아웃이 바뀐 것. 조용히 지나가면
    // 런타임 posix_spawnp 실패로만 드러나므로 설치 시점에 크게 알린다.
    console.warn(
      `[ensure-node-pty-helper] ${platformDir}에 spawn-helper가 없습니다 — ` +
        "node-pty prebuilds 레이아웃이 바뀌었을 수 있습니다. 이 스크립트를 재검토하세요.",
    );
  }
}
