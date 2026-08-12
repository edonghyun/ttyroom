export type RoomRoute = { kind: "entry" } | { kind: "room"; roomId: string; token: string };

export function parseRoomRoute(location: { pathname: string; hash: string }): RoomRoute {
  const match = /^\/r\/([^/]+)$/.exec(location.pathname);
  const token = location.hash.startsWith("#") ? location.hash.slice(1) : "";

  if (!match?.[1] || token.length === 0) return { kind: "entry" };

  return { kind: "room", roomId: match[1], token };
}
