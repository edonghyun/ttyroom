import { terminalViewSchema } from "@ttyroom/protocol";
import { z } from "zod";

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
          view: terminalViewSchema,
          runtimeId: z.string().min(1).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
