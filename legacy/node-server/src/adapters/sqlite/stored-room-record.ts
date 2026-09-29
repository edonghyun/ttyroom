import { z } from "zod";

const u32 = z.number().int().min(0).max(0xffffffff);
const workspaceCoordinate = z.number().finite().min(-0xffff).max(0xffff);
const workspaceDimension = z.number().finite().positive().max(0xffff);
const terminalMetadataSchema = z.object({
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  fgProcess: z.string().nullable(),
});
const terminalGeometrySchema = z.object({
  x: workspaceCoordinate,
  y: workspaceCoordinate,
  width: workspaceDimension,
  height: workspaceDimension,
});
const terminalStateSchema = z.object({
  terminalId: u32,
  hostId: z.string(),
  title: z.string().trim().min(1).max(80),
  geometry: terminalGeometrySchema.default({ x: 24, y: 24, width: 640, height: 420 }),
  mode: z.enum(["exclusive", "shared"]),
  status: z.enum(["open", "exited"]),
  exitCode: z.number().int().nullable(),
  meta: terminalMetadataSchema,
});

// SQLite JSON은 독립적인 persistence contract다. Wire protocol schema를 재사용하면 protocol
// 진화가 저장 데이터 migration을 암묵적으로 바꾸므로 schemaVersion과 함께 여기서 소유한다.
export const storedRoomRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    roomId: z.string().min(1),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1),
    nextTerminalId: z.number().int().positive(),
    hosts: z.array(
      z
        .object({
          hostId: z.string().min(1),
          name: z.string(),
        })
        .strict(),
    ),
    terminals: z.array(
      z
        .object({
          view: terminalStateSchema,
          runtimeId: z.string().min(1).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
