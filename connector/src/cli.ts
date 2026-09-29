// 엔트리는 경계 책임만 (가이드라인 §1.6) — 파싱은 순수 함수로 스펙한다
export type CliCommand =
  | { kind: "join"; httpUrl: string; roomId: string; wsUrl: string; name: string }
  | { kind: "invalid"; reason: string };

// 입력 형식: ttyroom join <roomUrl> [--name <표시명>]
//   joinUrl = http(s)://host[:port]/r/<roomId>→ wsUrl = ws(s)://host[:port]/ws
export function parseCli(argv: string[], env: { hostname: string }): CliCommand {
  const [subcommand, joinUrl] = argv;
  if (subcommand !== "join" || !joinUrl) {
    return { kind: "invalid", reason: "사용법: ttyroom join <roomUrl> [--name <표시명>]" };
  }

  let url: URL;
  try {
    url = new URL(joinUrl);
  } catch {
    return { kind: "invalid", reason: "joinUrl이 유효한 URL이 아닙니다" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "invalid", reason: "joinUrl은 http:// 또는 https:// URL이어야 합니다" };
  }

  const roomMatch = /^\/r\/([^/]+)$/.exec(url.pathname);
  if (!roomMatch || !roomMatch[1]) {
    return {
      kind: "invalid",
      reason: "방 URL 경로는 /r/<roomId> 형식이어야 합니다",
    };
  }

  if (url.hash || url.search || url.username || url.password) {
    return {
      kind: "invalid",
      reason: "방 URL에는 비밀값이나 쿼리를 넣지 마세요. Host credential은 stdin으로 입력합니다",
    };
  }
  if (argv.length !== 2 && !(argv.length === 4 && argv[2] === "--name")) {
    return { kind: "invalid", reason: "사용법: ttyroom join <roomUrl> [--name <표시명>]" };
  }

  const nameFlagIndex = argv.indexOf("--name");
  const nameOverride = nameFlagIndex >= 0 ? argv[nameFlagIndex + 1] : undefined;
  if (nameFlagIndex >= 0 && !nameOverride) {
    return { kind: "invalid", reason: "--name 뒤에 표시명이 없습니다" };
  }

  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";

  return {
    kind: "join",
    httpUrl: url.origin,
    roomId: roomMatch[1],
    wsUrl: `${wsProtocol}//${url.host}/ws`,
    name: nameOverride ?? env.hostname,
  };
}
