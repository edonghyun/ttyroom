import { given } from "./harness.js";

await using server = await given.server({ participantGraceMs: 60_000, hostGraceMs: 60_000 });
const room = await server.room();
await given.agent(room, "teardown-host");
