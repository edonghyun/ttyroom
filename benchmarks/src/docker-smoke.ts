import { readFile } from "node:fs/promises";
import { SocketProbe } from "@ttyroom/test-support/socket-probe";
import { waitUntil } from "@ttyroom/test-support/wait-until";

// Fixed private Compose service, never a developer or production endpoint.
const baseUrl = "http://server:3000";
await waitUntil(
  async () => {
    try {
      return (await fetch(baseUrl + "/healthz", { signal: AbortSignal.timeout(500) })).ok;
    } catch {
      return false;
    }
  },
  { timeoutMs: 30_000 },
);

async function post(path: string, body: object) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
}
const creation = await post("/api/rooms", {});
if (creation.status !== 201) throw new Error("Fresh benchmark room was not created");
const room = (await creation.json()) as { roomId: string; token: string };
const registration = await post(`/api/rooms/${room.roomId}/participants`, { token: room.token });
if (registration.status !== 201) throw new Error("Benchmark participant was not registered");
const participant = (await registration.json()) as { credential: string };
await using peer = await SocketProbe.connect(baseUrl);
peer.send({
  type: "hello",
  protocolVersion: 8,
  roomId: room.roomId,
  credential: participant.credential,
  name: "Smoke participant",
});
const welcome = await peer.next();
peer.send({ type: "acquire-lease", terminalId: 42 });
const control = await peer.next();
const excess = await post("/api/rooms", {});
if (welcome.type !== "welcome" || control.type !== "lease-invalid" || excess.status !== 503)
  throw new Error("Benchmark admission or control contract failed");

console.log(
  JSON.stringify({
    kind: "isolation-smoke",
    completed: true,
    roomStatus: creation.status,
    excessRoomStatus: excess.status,
    welcome: welcome.type,
    control: control.type,
    generatorLimits: {
      cpuMax: (await readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim(),
      memoryMax: (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim(),
    },
  }),
);
