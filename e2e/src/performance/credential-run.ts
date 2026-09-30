import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, release } from "node:os";
import { ServerProcess } from "../server-process.js";
import { SocketProbe } from "../socket-probe.js";
import { JvmObservation } from "./jvm-observation.js";
import { Latencies } from "./capacity-report.js";

const root = process.env.TTYROOM_CAPACITY_DIR;
const javaHome = process.env.JAVA_HOME;
if (!root || !javaHome) throw new Error("Use measure-capacity.sh with the credentials profile");
const directory = resolve(root);
const limits = { credentialsPerRoom: 64, credentials: 128 };
interface Credential {
  participantId: string;
  credential: string;
}
interface Room {
  roomId: string;
  token: string;
  managerCredential: string;
}

async function trial(repetition: number) {
  const output = resolve(directory, `credentials-${repetition}`);
  await mkdir(output);
  await using server = await ServerProcess.start(
    {},
    {
      protocolVersion: 8,
      capacity: limits,
      startupTimeoutMs: 30_000,
      command: [
        resolve(javaHome!, "bin/java"),
        "-Xms256m",
        "-Xmx512m",
        "-XX:+UseG1GC",
        "-jar",
        resolve(directory, "ttyroom-backend.jar"),
      ],
    },
  );
  const observation = new JvmObservation(server.pid!, javaHome!, output);
  const peers: SocketProbe[] = [];
  const issuance = new Latencies();
  const revocation = new Latencies();
  const authentication = new Latencies();
  const checkpoints: (Awaited<ReturnType<JvmObservation["postGcHeap"]>> & {
    storageBytes: number;
  })[] = [];
  const grace = [];
  const failures: string[] = [];
  let flight;
  let recording = false;
  const start = Date.now();
  let rejections;
  async function request(path: string, method: string, body?: object, bearer?: string) {
    return fetch(server.baseUrl + path, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function participant(room: Room): Promise<Credential> {
    const started = performance.now();
    const response = await request(`/api/rooms/${room.roomId}/participants`, "POST", {
      token: room.token,
    });
    if (response.status !== 201) throw new Error(`Issuance failed: ${response.status}`);
    const credential = (await response.json()) as Credential;
    issuance.add(performance.now() - started);
    return credential;
  }
  async function revoke(room: Room, credential: Credential, anchor: SocketProbe) {
    const started = performance.now();
    const response = await request(
      `/api/rooms/${room.roomId}/participants/${credential.participantId}`,
      "DELETE",
      undefined,
      room.managerCredential,
    );
    if (response.status !== 204) throw new Error(`Revocation failed: ${response.status}`);
    const notice = await anchor.next();
    if (
      notice.type !== "room-event" ||
      notice.event.kind !== "participant-left" ||
      notice.event.clientId !== credential.participantId
    )
      throw new Error("Unexpected revocation notice");
    revocation.add(performance.now() - started);
  }
  async function connect(room: Room, credential: Credential) {
    const started = performance.now();
    const peer = await SocketProbe.connect(server.baseUrl);
    peers.push(peer);
    peer.send({
      type: "hello",
      protocolVersion: 8,
      roomId: room.roomId,
      credential: credential.credential,
      name: "Churn participant",
    });
    const welcome = await peer.next();
    if (welcome.type !== "welcome") throw new Error("Credential was not admitted");
    authentication.add(performance.now() - started);
    return { peer, members: welcome.snapshot.participants.length };
  }
  async function checkpoint(phase: string) {
    checkpoints.push({
      ...(await observation.postGcHeap(phase)),
      storageBytes: await server.storageBytes(),
    });
  }
  try {
    await checkpoint("empty");
    await observation.startRecording(resolve(directory, "capacity.jfc"));
    recording = true;
    const rooms: {
      room: Room;
      keeper: Credential;
      anchor: SocketProbe;
      credentials: Credential[];
    }[] = [];
    for (let index = 0; index < 2; index++) {
      const response = await request("/api/rooms", "POST", {});
      if (response.status !== 201) throw new Error("Room setup failed");
      const room = (await response.json()) as Room;
      const keeper = await participant(room);
      const { peer: anchor } = await connect(room, keeper);
      const credentials = [];
      for (let i = 0; i < 62; i++) credentials.push(await participant(room));
      rooms.push({ room, keeper, anchor, credentials });
    }
    await checkpoint("full-credentials");
    const excessRoom = await request("/api/rooms", "POST", {});
    const excessParticipant = await request(
      `/api/rooms/${rooms[0]!.room.roomId}/participants`,
      "POST",
      { token: rooms[0]!.room.token },
    );
    rejections = {
      managerStatus: excessRoom.status,
      managerError: await excessRoom.json(),
      participantStatus: excessParticipant.status,
      participantError: await excessParticipant.json(),
    };
    if (rejections.managerStatus !== 503 || rejections.participantStatus !== 503)
      throw new Error("Credential boundary was not enforced");
    // Keep the stored count at 128 while replacing one credential per room 100 times.
    for (let round = 0; round < 100; round++) {
      for (const state of rooms) {
        await revoke(state.room, state.credentials[0]!, state.anchor);
        state.credentials[0] = await participant(state.room);
      }
    }
    await checkpoint("registration-churn");
    for (const state of rooms) {
      let peakMembers = 0;
      const started = performance.now();
      for (const credential of state.credentials) {
        const joined = await connect(state.room, credential);
        peakMembers = Math.max(peakMembers, joined.members);
        await joined.peer.disconnect();
      }
      // Membership is observed through the wire, separately from persisted credential count.
      let joined = 0;
      let left = 0;
      while (joined < 62 || left < 62) {
        const message = await state.anchor.next(20_000);
        if (message.type !== "room-event") throw new Error("Unexpected membership packet");
        if (message.event.kind === "participant-joined") joined++;
        else if (message.event.kind === "participant-left") left++;
        else throw new Error("Unexpected membership event");
      }
      const refreshed = await connect(state.room, state.keeper);
      await state.anchor.closed();
      state.anchor = refreshed.peer;
      grace.push({
        joined,
        left,
        peakMembers,
        afterGraceMembers: refreshed.members,
        elapsedMs: performance.now() - started,
      });
      if (refreshed.members !== 1) throw new Error("Grace membership did not return to the keeper");
    }
    await checkpoint("after-grace");
    for (const state of rooms) {
      state.anchor.send({ type: "acquire-lease", terminalId: 999 });
      if ((await state.anchor.next()).type !== "lease-invalid")
        throw new Error("Healthy keeper lost responsiveness");
      for (const credential of state.credentials)
        await revoke(state.room, credential, state.anchor);
    }
    await checkpoint("revoked");
  } catch (error) {
    failures.push(String(error));
  } finally {
    if (recording) {
      try {
        flight = await observation.recording(start, Date.now());
      } catch (error) {
        failures.push(`JFR: ${String(error)}`);
      }
    }
    await observation.stop();
    if (observation.failures.length) failures.push("RSS observation failed");
    if (observation.samples.some((sample) => sample.serverRssBytes > 768 * 1048576))
      failures.push("RSS threshold exceeded");
    await Promise.all(peers.map((peer) => peer[Symbol.asyncDispose]()));
    const result = {
      repetition,
      completed: failures.length === 0,
      failures,
      limits,
      graceMs: 15000,
      registrationReplacementRounds: 100,
      rejections,
      checkpoints,
      grace,
      issuance: issuance.summary(),
      revocation: revocation.summary(),
      authentication: authentication.summary(),
      environment: {
        os: `${process.platform} ${release()}`,
        cpu: cpus()[0]?.model,
        node: process.version,
      },
      flight,
      rss: observation.samples,
      rssFailures: observation.failures,
    };
    await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
    if (failures.length) await writeFile(resolve(output, "server.log"), server.diagnostics());
    console.log(JSON.stringify({ repetition, completed: result.completed, failures }));
    return result;
  }
}
const results = [];
for (let repetition = 1; repetition <= 3; repetition++) {
  const result = await trial(repetition);
  results.push(result);
  if (!result.completed) break;
}
await writeFile(resolve(directory, "results.json"), JSON.stringify(results, null, 2) + "\n");
if (results.length !== 3 || results.some((result) => !result.completed)) process.exitCode = 1;
