import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { ServerProcess } from "@ttyroom/test-support/server-process";
import { TestProcess } from "@ttyroom/test-support/test-process";
import { ConnectionFault } from "../e2e/fixtures/connection-fault.js";
import { RoomPage } from "../e2e/pages/room.page.js";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(root, "artifacts/demo");

// This is an opt-in recording scenario. Holds are reading time, not readiness waits.
test("record a real Spring collaboration and reconnect", async ({ browser }) => {
  if (!process.env.TTYROOM_E2E_SERVER_COMMAND) {
    throw new Error("Use scripts/test-spring.sh with playwright.demo.config.ts");
  }
  await mkdir(output, { recursive: true });
  const shellHome = await mkdtemp("/tmp/ttyroom-demo-");
  let server: ServerProcess | undefined;
  let connector: TestProcess | undefined;
  const contexts = [];
  const scenes: Array<{ at: number; title: string }> = [];
  let failure: unknown;
  try {
    await writeFile(resolve(output, "manifest.json"), JSON.stringify({ status: "recording" }));
    await writeFile(resolve(shellHome, ".zshenv"), "unsetopt GLOBAL_RCS\n");
    await writeFile(resolve(shellHome, ".zshrc"), "PROMPT='demo$ '\nRPROMPT=''\n");
    server = await ServerProcess.start();
    const response = await fetch(`${server.baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "TTYRoom Demo" }),
    });
    expect(response.status).toBe(201);
    const room = (await response.json()) as { joinUrl: string; token: string };
    connector = new TestProcess(
      [
        process.execPath,
        resolve(root, "connector/dist/index.js"),
        "join",
        room.joinUrl,
        "--name",
        "demo-shell",
      ],
      shellHome,
      {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: shellHome,
        ZDOTDIR: shellHome,
        SHELL: "/bin/zsh",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
      },
    );
    await expect.poll(() => connector!.diagnostics()).toContain("서버에 연결됨");
    for (const name of ["alice", "bob"]) {
      contexts.push(
        await browser.newContext({
          viewport: { width: 1100, height: 760 },
          recordVideo: { dir: resolve(output, name), size: { width: 1100, height: 760 } },
        }),
      );
    }
    const started = performance.now();
    const [alicePage, bobPage] = await Promise.all(contexts.map((context) => context.newPage()));
    const alice = new RoomPage(alicePage!);
    const bob = new RoomPage(bobPage!);
    const connection = await ConnectionFault.install(alicePage!);
    const videos = [alicePage!.video()!, bobPage!.video()!];
    const scene = (title: string) =>
      scenes.push({ at: (performance.now() - started) / 1000, title });

    scene("01  두 브라우저로 같은 방에 입장합니다");
    await Promise.all([alicePage!.goto(room.joinUrl), bobPage!.goto(room.joinUrl)]);
    await delay(6000);
    await alice.joinAs("Alice");
    await delay(3000);
    await bob.joinAs("Bob");
    await delay(4000);

    scene("02  Connector가 실행한 실제 로컬 셸을 공유합니다");
    await alice.openTerminal();
    await bob.terminal("term-1").waitFor({ state: "visible" });
    await delay(5000);
    await alice.takeControl("term-1");
    await alice.waitForTerminalStatus("term-1", "You control · Esc to release");
    await alice.printLine("term-1", "Hello from the shared shell");
    await bob.outputContaining("term-1", "Hello from the shared shell");
    await delay(12000);

    scene("03  Alice가 제어권을 놓으면 Bob이 입력할 수 있습니다");
    await alicePage!.keyboard.press("Escape");
    await bob.waitForTerminalStatus("term-1", "Available");
    await delay(3000);
    await bob.takeControl("term-1");
    await alice.waitForTerminalStatus("term-1", "Bob controls · View only");
    await bob.printLine("term-1", "Bob now controls this shell");
    await alice.outputContaining("term-1", "Bob now controls this shell");
    await delay(12000);

    const identity = await alice.clientId();
    scene("04  Alice의 연결만 끊습니다 · Bob의 셸은 계속 실행됩니다");
    await connection.disconnect();
    await alice.waitForConnection("Reconnecting");
    await delay(8000);
    await bob.printLine("term-1", "Output while Alice was offline");
    await bob.outputContaining("term-1", "Output while Alice was offline");
    await delay(10000);

    scene("05  재접속하면 끊긴 동안의 출력도 다시 받습니다");
    connection.reconnect();
    await alice.waitForConnection("Connected");
    const replay = await alice.outputContaining("term-1", "Output while Alice was offline");
    const reconnectedIdentity = await alice.clientId();
    await delay(14000);

    scene("실제 Spring + Connector + PTY · 로컬 시연 · 입력 재전송 보장은 아닙니다");
    await bob.printLine("term-1", "Same shell. Shared output. Restored connection.");
    await alice.outputContaining("term-1", "Same shell. Shared output. Restored connection.");
    await delay(10000);
    const texts = await Promise.all([
      alicePage!.locator("body").innerText(),
      bobPage!.locator("body").innerText(),
    ]);
    expect(replay.split("Output while Alice was offline")).toHaveLength(2);
    expect(reconnectedIdentity).toBe(identity);
    for (const text of texts) {
      expect(text).not.toContain(room.token);
      expect(text).not.toContain(root);
      expect(text).not.toContain("/Users/");
    }
    await contexts[0]!.close();
    await contexts[1]!.close();
    await videos[0]!.saveAs(resolve(output, "alice.webm"));
    await videos[1]!.saveAs(resolve(output, "bob.webm"));
    await writeFile(
      resolve(output, "manifest.json"),
      JSON.stringify(
        {
          status: "complete",
          source: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
          scenes,
          duration: (performance.now() - started) / 1000,
          backend: "Spring",
          viewport: { width: 1100, height: 760 },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failure = error;
  } finally {
    const results = await Promise.allSettled([
      ...contexts.map((context) => context.close()),
      connector?.stop(),
      server?.close(),
    ]);
    const removal = await Promise.allSettled([rm(shellHome, { recursive: true, force: true })]);
    const errors = [...results, ...removal]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failure) errors.unshift(failure);
    if (errors.length) {
      await writeFile(resolve(output, "manifest.json"), JSON.stringify({ status: "failed" }));
      throw new AggregateError(errors, "Demo capture or cleanup failed");
    }
  }
});
