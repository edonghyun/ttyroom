import { z } from "zod";

const u32 = z.number().int().min(0).max(0xffffffff);

// ── 뷰 타입: RoomSnapshot과 이벤트가 공유하는 유선 형태 ──────────────────────

export const terminalMetaSchema = z.object({
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  fgProcess: z.string().nullable(),
});
export const participantViewSchema = z.object({ clientId: z.string(), name: z.string() });
export const hostViewSchema = z.object({
  hostId: z.string(),
  name: z.string(),
  online: z.boolean(),
});
export const terminalViewSchema = z.object({
  terminalId: u32,
  hostId: z.string(),
  title: z.string(),
  mode: z.enum(["exclusive", "shared"]),
  status: z.enum(["open", "exited"]),
  exitCode: z.number().int().nullable(),
  meta: terminalMetaSchema,
});
export const leaseViewSchema = z.object({
  terminalId: u32,
  leaseId: u32,
  holderClientId: z.string(),
});
export const roomSnapshotSchema = z.object({
  roomId: z.string(),
  participants: z.array(participantViewSchema),
  hosts: z.array(hostViewSchema),
  terminals: z.array(terminalViewSchema),
  leases: z.array(leaseViewSchema),
});

export type TerminalMeta = z.infer<typeof terminalMetaSchema>;
export type ParticipantView = z.infer<typeof participantViewSchema>;
export type HostView = z.infer<typeof hostViewSchema>;
export type TerminalView = z.infer<typeof terminalViewSchema>;
export type LeaseView = z.infer<typeof leaseViewSchema>;
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;

// ── 클라이언트(참여자·호스트 공통)→서버 ──────────────────────────────────────

const helloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int(),
  roomId: z.string(),
  token: z.string(),
  clientId: z.string(),
  name: z.string(),
  role: z.enum(["participant", "host"]),
});
const openTerminalRequestSchema = z.object({
  type: z.literal("open-terminal-request"),
  hostId: z.string(),
});
const acquireLeaseSchema = z.object({ type: z.literal("acquire-lease"), terminalId: u32 });
const releaseLeaseSchema = z.object({
  type: z.literal("release-lease"),
  terminalId: u32,
  leaseId: u32,
});
const resizeRequestSchema = z.object({
  type: z.literal("resize-request"),
  terminalId: u32,
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
});
const terminalOpenedSchema = z.object({ type: z.literal("terminal-opened"), terminalId: u32 });
const terminalClosedSchema = z.object({
  type: z.literal("terminal-closed"),
  terminalId: u32,
  exitCode: z.number().int().nullable(),
});
const terminalMetaMessageSchema = z.object({
  type: z.literal("terminal-meta"),
  terminalId: u32,
  meta: terminalMetaSchema,
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  openTerminalRequestSchema,
  acquireLeaseSchema,
  releaseLeaseSchema,
  resizeRequestSchema,
  terminalOpenedSchema,
  terminalClosedSchema,
  terminalMetaMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type HelloMessage = z.infer<typeof helloSchema>;

// ── Room 이벤트와 임대 결과 ──────────────────────────────────────────────────

export const roomEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("participant-joined"), participant: participantViewSchema }),
  z.object({ kind: z.literal("participant-left"), clientId: z.string() }),
  z.object({ kind: z.literal("host-connected"), host: hostViewSchema }),
  z.object({ kind: z.literal("host-offline"), hostId: z.string() }),
  z.object({ kind: z.literal("host-removed"), hostId: z.string() }),
  z.object({ kind: z.literal("terminal-opened"), terminal: terminalViewSchema }),
  z.object({
    kind: z.literal("terminal-closed"),
    terminalId: u32,
    exitCode: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal("lease-granted"), lease: leaseViewSchema }),
  z.object({ kind: z.literal("lease-released"), terminalId: u32 }),
  z.object({ kind: z.literal("terminal-meta"), terminalId: u32, meta: terminalMetaSchema }),
]);
export type RoomEvent = z.infer<typeof roomEventSchema>;

export const leaseResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("granted"), leaseId: u32 }),
  z.object({ kind: z.literal("denied"), holderClientId: z.string() }),
]);
export type LeaseResult = z.infer<typeof leaseResultSchema>;

export const errorCodeSchema = z.enum([
  "room-not-found",
  "invalid-token",
  "unsupported-protocol-version",
  "bad-message",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// ── 서버→클라이언트·호스트 ───────────────────────────────────────────────────

const welcomeSchema = z.object({
  type: z.literal("welcome"),
  selfClientId: z.string(),
  snapshot: roomSnapshotSchema,
});
const roomEventMessageSchema = z.object({ type: z.literal("room-event"), event: roomEventSchema });
const leaseResultMessageSchema = z.object({
  type: z.literal("lease-result"),
  terminalId: u32,
  result: leaseResultSchema,
});
const leaseInvalidSchema = z.object({
  type: z.literal("lease-invalid"),
  terminalId: u32,
  reason: z.string(),
});
const syncSchema = z.object({ type: z.literal("sync"), terminalId: u32, seq: u32 });
const outputGapSchema = z.object({
  type: z.literal("output-gap"),
  terminalId: u32,
  fromSeq: u32,
  toSeq: u32,
});
const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: errorCodeSchema,
  message: z.string(),
});
const openTerminalSchema = z.object({
  type: z.literal("open-terminal"),
  terminalId: u32,
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
});
const closeTerminalSchema = z.object({ type: z.literal("close-terminal"), terminalId: u32 });
const resizeSchema = z.object({
  type: z.literal("resize"),
  terminalId: u32,
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  welcomeSchema,
  roomEventMessageSchema,
  leaseResultMessageSchema,
  leaseInvalidSchema,
  syncSchema,
  outputGapSchema,
  errorMessageSchema,
  openTerminalSchema,
  closeTerminalSchema,
  resizeSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ── 파싱·직렬화 ─────────────────────────────────────────────────────────────

export type ParseResult =
  { kind: "ok"; message: ClientMessage } | { kind: "bad-message"; reason: string };

export function parseClientMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "bad-message", reason: "invalid json" };
  }
  const parsed = clientMessageSchema.safeParse(json);
  return parsed.success
    ? { kind: "ok", message: parsed.data }
    : { kind: "bad-message", reason: parsed.error.message };
}

export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export type ServerParseResult =
  { kind: "ok"; message: ServerMessage } | { kind: "bad-message"; reason: string };

export function parseServerMessage(raw: string): ServerParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "bad-message", reason: "invalid json" };
  }
  const parsed = serverMessageSchema.safeParse(json);
  return parsed.success
    ? { kind: "ok", message: parsed.data }
    : { kind: "bad-message", reason: parsed.error.message };
}
