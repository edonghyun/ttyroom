import { RoomIdentity } from "./room-identity.js";

interface IdentityChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  close(): void;
}

interface IdentityProbe {
  readonly kind: "identity-probe";
  readonly clientId: string;
  readonly tabId: string;
}

interface IdentityOccupied {
  readonly kind: "identity-occupied";
  readonly clientId: string;
  readonly claimantTabId: string;
}

type IdentityMessage = IdentityProbe | IdentityOccupied;

export interface TabIdentityClaim {
  readonly identity: RoomIdentity;
  dispose(): void;
}

export async function claimRoomIdentityForTab(
  roomId: string,
  identity: RoomIdentity,
  deps: {
    readonly createTabId?: () => string;
    readonly createChannel?: (name: string) => IdentityChannel | null;
    readonly waitForResponses?: () => Promise<void>;
  } = {},
): Promise<TabIdentityClaim> {
  const createChannel =
    deps.createChannel ??
    ((name: string) =>
      typeof globalThis.BroadcastChannel === "undefined" ? null : new BroadcastChannel(name));
  const channel = createChannel(`ttyroom:identity-claim:v1:${encodeURIComponent(roomId)}`);
  if (!channel) return { identity, dispose: () => undefined };

  const tabId = (deps.createTabId ?? (() => globalThis.crypto.randomUUID()))();
  const waitForResponses =
    deps.waitForResponses ??
    (() => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 80)));
  let claimedClientId = identity.clientId(roomId);
  let occupied = false;

  const receive = (event: MessageEvent<unknown>) => {
    const message = parseIdentityMessage(event.data);
    if (!message) return;
    if (
      message.kind === "identity-probe" &&
      message.tabId !== tabId &&
      message.clientId === claimedClientId
    ) {
      channel.postMessage({
        kind: "identity-occupied",
        clientId: claimedClientId,
        claimantTabId: message.tabId,
      } satisfies IdentityOccupied);
      return;
    }
    if (
      message.kind === "identity-occupied" &&
      message.claimantTabId === tabId &&
      message.clientId === claimedClientId
    ) {
      occupied = true;
    }
  };
  channel.addEventListener("message", receive);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    occupied = false;
    channel.postMessage({
      kind: "identity-probe",
      clientId: claimedClientId,
      tabId,
    } satisfies IdentityProbe);
    await waitForResponses();
    if (!occupied) break;
    claimedClientId = identity.renewClientId(roomId);
  }

  return {
    identity,
    dispose(): void {
      channel.removeEventListener("message", receive);
      channel.close();
    },
  };
}

function parseIdentityMessage(value: unknown): IdentityMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<IdentityMessage>;
  if (
    candidate.kind === "identity-probe" &&
    typeof candidate.clientId === "string" &&
    typeof candidate.tabId === "string"
  ) {
    return candidate as IdentityProbe;
  }
  if (
    candidate.kind === "identity-occupied" &&
    typeof candidate.clientId === "string" &&
    typeof candidate.claimantTabId === "string"
  ) {
    return candidate as IdentityOccupied;
  }
  return null;
}
