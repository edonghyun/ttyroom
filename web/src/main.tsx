import "@fontsource-variable/fira-code";
import "@fontsource-variable/inter";
import "@xterm/xterm/css/xterm.css";
import "./ui/theme.css";
import "./ui/app.css";

import { createWebApp } from "./app/create-web-app.js";
import { createProductionRoomRuntime } from "./app/room-app.js";
import { RoomIdentity } from "./app/room-identity.js";
import { parseRoomRoute } from "./app/room-route.js";
import { claimRoomIdentityForTab } from "./app/tab-identity-claim.js";

const root = document.querySelector<HTMLElement>("#root");

if (!root) {
  throw new Error("TTYRoom application root is missing");
}

async function start(appRoot: HTMLElement): Promise<void> {
  const route = parseRoomRoute(globalThis.location);
  if (route.kind === "entry") {
    createWebApp({ root: appRoot });
    return;
  }

  const claim = await claimRoomIdentityForTab(route.roomId, new RoomIdentity());
  createWebApp({
    root: appRoot,
    runtime: createProductionRoomRuntime({ identity: claim.identity }),
  });
}

void start(root);
