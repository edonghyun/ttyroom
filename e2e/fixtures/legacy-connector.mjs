import { randomUUID } from "node:crypto";
import { runConnector } from "../../connector/dist/run-connector.js";
const [joinUrl, name] = process.argv.slice(2);
const url = new URL(joinUrl);
runConnector(`${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/ws`, {
  type: "hello",
  protocolVersion: 7,
  roomId: url.pathname.slice(3),
  token: url.hash.slice(1),
  clientId: randomUUID(),
  name,
  role: "host",
});
