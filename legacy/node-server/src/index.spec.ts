import { describe, expect, it } from "vitest";
import { runCli } from "./index.js";

describe("runCli — 역할: 서버 CLI 경계", () => {
  it("--print-config는 최종 설정과 출처를 출력하고 서버를 시작하지 않는다", async () => {
    let output = "";
    let startCount = 0;

    const running = await runCli({
      argv: ["--print-config"],
      env: {},
      cwd: "/__ttyroom_no_config_file__",
      write: (text) => {
        output += text;
      },
      start: async () => {
        startCount += 1;
        throw new Error("서버가 시작되면 안 된다");
      },
    });

    expect(running).toBeUndefined();
    expect(startCount).toBe(0);
    expect(output).toMatch(/port\s+0\s+default/);
  });
});
