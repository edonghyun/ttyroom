import { z } from "zod";
import { DEFAULT_POLICY } from "./ports/policy.js";

const policySchema = z
  .object({
    participantGraceMs: z.number().int().nonnegative().default(DEFAULT_POLICY.participantGraceMs),
    hostGraceMs: z.number().int().nonnegative().default(DEFAULT_POLICY.hostGraceMs),
    scrollbackBytesPerTerminal: z
      .number()
      .int()
      .nonnegative()
      .default(DEFAULT_POLICY.scrollbackBytesPerTerminal),
    sendBufferDropThresholdBytes: z
      .number()
      .int()
      .nonnegative()
      .default(DEFAULT_POLICY.sendBufferDropThresholdBytes),
    maxQueuedDataBytesPerConnection: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_POLICY.maxQueuedDataBytesPerConnection),
    outputRateLimitBytesPerSec: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_POLICY.outputRateLimitBytesPerSec),
  })
  .strict()
  .default({});

export const configSchema = z
  .object({
    port: z.number().int().min(0).max(65535).default(0),
    statePath: z.string().trim().min(1).default(".ttyroom/ttyroom.sqlite"),
    policy: policySchema,
  })
  .strict();

export type ServerConfig = z.infer<typeof configSchema>;
type ConfigSource = "default" | "file" | "env";
type ConfigSources = Record<string, ConfigSource>;

const sourcesByConfig = new WeakMap<ServerConfig, ConfigSources>();

export function loadConfig(input: { file?: unknown; env?: NodeJS.ProcessEnv }): ServerConfig {
  const file = z.record(z.unknown()).parse(input.file ?? {});
  const filePolicy = z.record(z.unknown()).parse(file.policy ?? {});
  const env = input.env ?? {};
  const merged: Record<string, unknown> = {
    ...file,
    policy: {
      ...filePolicy,
      ...definedValues({
        participantGraceMs: envNumber(env.TTYROOM_PARTICIPANT_GRACE_MS),
        hostGraceMs: envNumber(env.TTYROOM_HOST_GRACE_MS),
        scrollbackBytesPerTerminal: envNumber(env.TTYROOM_SCROLLBACK_BYTES_PER_TERMINAL),
        sendBufferDropThresholdBytes: envNumber(env.TTYROOM_SEND_BUFFER_DROP_THRESHOLD_BYTES),
        maxQueuedDataBytesPerConnection: envNumber(
          env.TTYROOM_MAX_QUEUED_DATA_BYTES_PER_CONNECTION,
        ),
        outputRateLimitBytesPerSec: envNumber(env.TTYROOM_OUTPUT_RATE_LIMIT_BYTES_PER_SEC),
      }),
    },
    ...definedValues({
      port: envNumber(env.TTYROOM_PORT),
      statePath: env.TTYROOM_STATE_PATH,
    }),
  };
  const config = configSchema.parse(merged);
  sourcesByConfig.set(config, {
    port: sourceOf(file, "port", env.TTYROOM_PORT),
    statePath: sourceOf(file, "statePath", env.TTYROOM_STATE_PATH),
    participantGraceMs: sourceOf(
      filePolicy,
      "participantGraceMs",
      env.TTYROOM_PARTICIPANT_GRACE_MS,
    ),
    hostGraceMs: sourceOf(filePolicy, "hostGraceMs", env.TTYROOM_HOST_GRACE_MS),
    scrollbackBytesPerTerminal: sourceOf(
      filePolicy,
      "scrollbackBytesPerTerminal",
      env.TTYROOM_SCROLLBACK_BYTES_PER_TERMINAL,
    ),
    sendBufferDropThresholdBytes: sourceOf(
      filePolicy,
      "sendBufferDropThresholdBytes",
      env.TTYROOM_SEND_BUFFER_DROP_THRESHOLD_BYTES,
    ),
    maxQueuedDataBytesPerConnection: sourceOf(
      filePolicy,
      "maxQueuedDataBytesPerConnection",
      env.TTYROOM_MAX_QUEUED_DATA_BYTES_PER_CONNECTION,
    ),
    outputRateLimitBytesPerSec: sourceOf(
      filePolicy,
      "outputRateLimitBytesPerSec",
      env.TTYROOM_OUTPUT_RATE_LIMIT_BYTES_PER_SEC,
    ),
  });
  return config;
}

export function printConfig(config: ServerConfig): string {
  const sources = sourcesByConfig.get(config);
  if (!sources) throw new Error("loadConfig로 생성하지 않은 설정은 출처를 출력할 수 없다");
  const rows: Array<[string, string | number, ConfigSource]> = [
    ["port", config.port, sources.port ?? "default"],
    ["statePath", config.statePath, sources.statePath ?? "default"],
    [
      "participantGraceMs",
      config.policy.participantGraceMs,
      sources.participantGraceMs ?? "default",
    ],
    ["hostGraceMs", config.policy.hostGraceMs, sources.hostGraceMs ?? "default"],
    [
      "scrollbackBytesPerTerminal",
      config.policy.scrollbackBytesPerTerminal,
      sources.scrollbackBytesPerTerminal ?? "default",
    ],
    [
      "sendBufferDropThresholdBytes",
      config.policy.sendBufferDropThresholdBytes,
      sources.sendBufferDropThresholdBytes ?? "default",
    ],
    [
      "maxQueuedDataBytesPerConnection",
      config.policy.maxQueuedDataBytesPerConnection,
      sources.maxQueuedDataBytesPerConnection ?? "default",
    ],
    [
      "outputRateLimitBytesPerSec",
      config.policy.outputRateLimitBytesPerSec,
      sources.outputRateLimitBytesPerSec ?? "default",
    ],
  ];
  return rows.map(([name, value, source]) => `${name}\t${value}\t${source}`).join("\n");
}

function envNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return raw.trim() === "" ? Number.NaN : Number(raw);
}

function definedValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function sourceOf(
  file: Record<string, unknown>,
  key: string,
  envValue: string | undefined,
): ConfigSource {
  if (envValue !== undefined) return "env";
  return Object.hasOwn(file, key) ? "file" : "default";
}
