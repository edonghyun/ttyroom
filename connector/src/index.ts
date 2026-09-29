#!/usr/bin/env node
import { hostname } from "node:os";
import { PROTOCOL_VERSION } from "@ttyroom/protocol";
import { parseCli } from "./cli.js";
import { readCredential } from "./read-credential.js";
import { runConnector } from "./run-connector.js";

const command = parseCli(process.argv.slice(2), { hostname: hostname() });
if (command.kind === "invalid") {
  console.error(command.reason);
  process.exit(1);
}
try {
  const credential = await readCredential(process.stdin, (text) => process.stderr.write(text));
  process.stderr.write("\n");
  runConnector(command.wsUrl, {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    roomId: command.roomId,
    credential,
    name: command.name,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not read host credential");
  process.exit(1);
}
