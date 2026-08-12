// 엔트리는 경계 책임만 (가이드라인 §1.6) — 파싱은 순수 함수로 스펙한다
export type CliCommand =
  | { kind: "join"; httpUrl: string; roomId: string; token: string; wsUrl: string; name: string }
  | { kind: "invalid"; reason: string };

// 입력 형식: ttyroom join <joinUrl> [--name <표시명>]
//   joinUrl = http(s)://host[:port]/r/<roomId>#<token> → wsUrl = ws(s)://host[:port]/ws
export function parseCli(argv: string[], env: { hostname: string }): CliCommand {
  const [subcommand, joinUrl] = argv;
  if (subcommand !== "join" || !joinUrl) {
    return { kind: "invalid", reason: "사용법: ttyroom join <joinUrl> [--name <표시명>]" };
  }

  let url: URL;
  try {
    url = new URL(joinUrl);
  } catch {
    return { kind: "invalid", reason: `joinUrl이 URL이 아닙니다: ${joinUrl}` };
  }

  const roomMatch = /^\/r\/([^/]+)$/.exec(url.pathname);
  if (!roomMatch || !roomMatch[1]) {
    return {
      kind: "invalid",
      reason: `joinUrl 경로는 /r/<roomId> 형식이어야 합니다: ${url.pathname}`,
    };
  }

  const token = url.hash.slice(1);
  if (!token) {
    return { kind: "invalid", reason: "joinUrl에 #<token>이 없습니다" };
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
    token,
    wsUrl: `${wsProtocol}//${url.host}/ws`,
    name: nameOverride ?? env.hostname,
  };
}
