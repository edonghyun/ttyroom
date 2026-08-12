import { useState, useSyncExternalStore } from "react";

import type { RoomRoute } from "./room-route.js";
import { parseRoomRoute } from "./room-route.js";
import { RoomIdentity } from "./room-identity.js";
import { RoomApi } from "./room-api.js";
import { RoomProjection } from "../projection/room-projection.js";
import type { RoomSessionEvent } from "../session/room-session.js";
import { RoomSession } from "../session/room-session.js";
import { BrowserTransport } from "../transport/browser-transport.js";
import { NativeBrowserSocketFactory } from "../transport/browser-socket.js";
import { LayoutRepository, type LayoutScope } from "../layout/layout-repository.js";
import { WindowManager } from "../windows/window-manager.js";
import { TerminalController } from "../terminal/terminal-controller.js";
import { XtermAdapter } from "../terminal/xterm-adapter.js";
import { App, type AppState } from "../ui/App.js";
import { RoomWorkspace } from "../ui/room/RoomWorkspace.js";
import { TerminalScene } from "../ui/terminal/TerminalScene.js";
import { CloseTerminalDialog } from "../ui/overlays/CloseTerminalDialog.js";
import { ToastRegion, type ToastMessage } from "../ui/overlays/ToastRegion.js";
import { AddHostDrawer } from "../ui/overlays/AddHostDrawer.js";
import { useWorkspaceKeyboard } from "../ui/use-workspace-keyboard.js";

import type { TerminalControllerPort, TerminalWindowModel } from "../ui/terminal/TerminalWindow.js";

export interface RuntimeTerminalController extends TerminalControllerPort {
  acceptOutput(frame: {
    readonly seq: number;
    readonly bytes: Uint8Array;
    readonly replace: boolean;
  }): void;
  resetOutput(): void;
  dispose(): void;
}

export interface RoomAppSession {
  start(): void;
  stop(): void;
  subscribe(subscriber: (event: RoomSessionEvent) => void): () => void;
  takeControl(terminalId: number): void;
  releaseControl(terminalId: number): void;
  closeTerminal(terminalId: number): void;
  openTerminal(hostId: string): void;
  resize(terminalId: number, cols: number, rows: number): void;
  setMode(terminalId: number, mode: "exclusive" | "shared"): void;
}

interface RoomAppIdentity extends Pick<RoomIdentity, "clientId" | "nickname" | "saveNickname"> {}

export interface RoomAppRuntimeDeps {
  readonly route: RoomRoute;
  readonly identity: RoomAppIdentity;
  readonly projection: RoomProjection;
  readonly windowManager: WindowManager;
  readonly layoutRepository?: LayoutRepository;
  readonly createSession: (identity: {
    roomId: string;
    token: string;
    clientId: string;
    name: string;
  }) => RoomAppSession;
  readonly createController: (terminalId: number) => RuntimeTerminalController;
  readonly createRoom: (name: string) => Promise<void> | void;
  readonly navigate: (location: string) => void;
  readonly copyInvite: () => void;
  readonly copyText?: (text: string) => void;
  readonly inviteUrl?: string;
  readonly narrowViewport?: boolean;
  readonly viewportBucket?: string;
  readonly viewportChanges?: {
    subscribe(
      subscriber: (viewport: { readonly width: number; readonly height: number }) => void,
    ): () => void;
  };
}

export interface RoomAppView {
  readonly state: AppState;
  readonly roomName: string;
  readonly terminals: readonly TerminalWindowModel[];
  readonly activeTerminalId: number | null;
  readonly overview: boolean;
  readonly participants: readonly string[];
  readonly connection: "connected" | "reconnecting" | "restoring";
  readonly toasts: readonly ToastMessage[];
}

type Subscriber = () => void;

export class RoomAppRuntime {
  private readonly controllers = new Map<number, RuntimeTerminalController>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly unsubscribeProjection: () => void;
  private readonly unsubscribeWindows: () => void;
  private readonly unsubscribeViewport: () => void;
  private session: RoomAppSession | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private joined = false;
  private disposed = false;
  private currentView: RoomAppView;
  private toasts: ToastMessage[] = [];
  private readonly layoutScope: LayoutScope | null;
  private layoutPersistenceStopped = false;
  private narrowViewport: boolean;

  constructor(private readonly deps: RoomAppRuntimeDeps) {
    this.narrowViewport = Boolean(deps.narrowViewport);
    this.layoutScope =
      deps.layoutRepository && deps.route.kind === "room"
        ? {
            roomId: deps.route.roomId,
            clientId: deps.identity.clientId(deps.route.roomId),
            viewportBucket: deps.viewportBucket ?? "default",
          }
        : null;
    if (this.layoutScope && deps.layoutRepository) {
      deps.windowManager.restoreLayout(deps.layoutRepository.load(this.layoutScope));
    }
    this.unsubscribeProjection = deps.projection.subscribe(() => {
      if (
        deps.projection.view().connection === "gone" &&
        deps.route.kind === "room" &&
        deps.layoutRepository
      ) {
        this.layoutPersistenceStopped = true;
        deps.layoutRepository.clearRoom(deps.route.roomId);
        this.publish();
        return;
      }
      this.reconcileTerminals();
      this.publish();
    });
    this.unsubscribeWindows = deps.windowManager.subscribe((windowView) => {
      if (this.layoutScope && deps.layoutRepository && !this.layoutPersistenceStopped) {
        deps.layoutRepository.save(
          this.layoutScope,
          windowView.windows.map((window) => ({
            terminalId: window.terminalId,
            ...window.rect,
            z: window.z,
            state: window.minimized
              ? ("minimized" as const)
              : window.maximized
                ? ("maximized" as const)
                : ("floating" as const),
          })),
        );
      }
      this.publish();
    });
    this.currentView = this.computeView();
    this.unsubscribeViewport =
      deps.viewportChanges?.subscribe((viewport) => this.resizeViewport(viewport)) ??
      (() => undefined);
  }

  subscribe = (subscriber: Subscriber): (() => void) => {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  };

  view = (): RoomAppView => this.currentView;

  private computeView(): RoomAppView {
    const projection = this.deps.projection.view();
    const room = projection.room;
    const ownLease = room?.leases.find((lease) => lease.holderClientId === projection.selfClientId);
    const windowView = this.deps.windowManager.view();
    const terminals: TerminalWindowModel[] = [];
    for (const managed of windowView.windows) {
      const projected = this.deps.projection.terminal(managed.terminalId);
      if (!projected) continue;
      const capability =
        projected.terminal.status === "exited"
          ? ({ kind: "exited", exitCode: projected.terminal.exitCode } as const)
          : projected.inputCapability;
      terminals.push({
        terminalId: projected.terminal.terminalId,
        title: projected.terminal.title,
        host: projected.host?.name ?? "Unknown Host",
        cwd: projected.terminal.meta.cwd ?? undefined,
        branch: projected.terminal.meta.gitBranch ?? undefined,
        status: capability,
        mode: projected.terminal.mode,
        controlAction: capability.kind === "available" ? (ownLease ? "switch" : "take") : undefined,
        rect: managed.rect,
        z: managed.z,
        minimized: managed.minimized,
        maximized: managed.maximized,
        activity: projected.terminal.meta.fgProcess ?? "Idle",
      });
    }
    return {
      state: this.screenState(),
      roomName: room?.name ?? "Quick Room",
      terminals,
      activeTerminalId:
        windowView.windows.reduce<{ terminalId: number; z: number } | null>(
          (active, window) => (!active || window.z > active.z ? window : active),
          null,
        )?.terminalId ?? null,
      overview: windowView.overview,
      participants:
        room?.participants.map((participant) => {
          const lease = room.leases.find((item) => item.holderClientId === participant.clientId);
          const terminal = room.terminals.find((item) => item.terminalId === lease?.terminalId);
          const name = participant.clientId === projection.selfClientId ? "You" : participant.name;
          return terminal ? `${name} → ${terminal.title}` : name;
        }) ?? [],
      connection:
        projection.connection === "reconnecting"
          ? "reconnecting"
          : this.screenState() === "restoring"
            ? "restoring"
            : "connected",
      toasts: this.toasts.map((toast) => ({ ...toast })),
    };
  }

  join = (_roomId: string, nickname: string): void => {
    if (this.deps.route.kind !== "room" || this.session) return;
    this.deps.identity.saveNickname(this.deps.route.roomId, nickname);
    this.joined = true;
    this.session = this.deps.createSession({
      roomId: this.deps.route.roomId,
      token: this.deps.route.token,
      clientId: this.deps.identity.clientId(this.deps.route.roomId),
      name: nickname,
    });
    this.unsubscribeSession = this.session.subscribe((event) => {
      if (event.kind === "terminal-output")
        this.controllers.get(event.terminalId)?.acceptOutput(event);
      if (event.kind === "reset-terminal-output")
        this.controllers.get(event.terminalId)?.resetOutput();
      if (event.kind === "lease-acquired") {
        const title = this.deps.projection.terminal(event.terminalId)?.terminal.title ?? "terminal";
        this.toasts = [
          ...this.toasts,
          {
            id: `lease-acquired-${event.terminalId}-${this.toasts.length}`,
            severity: "success",
            message: `Control acquired · ${title}`,
          },
        ];
        this.publish();
      }
      if (event.kind === "lease-denied") {
        const title = this.deps.projection.terminal(event.terminalId)?.terminal.title ?? "terminal";
        this.toasts = [
          ...this.toasts,
          {
            id: `lease-denied-${event.terminalId}-${this.toasts.length}`,
            severity: "error",
            message: `${event.holderName} now controls ${title}`,
          },
        ];
        this.publish();
      }
    });
    this.session.start();
    this.publish();
  };

  controllerCount(): number {
    return this.controllers.size;
  }

  controllersForScene(): ReadonlyMap<number, RuntimeTerminalController> {
    return this.controllers;
  }

  invite(): void {
    this.deps.copyInvite();
  }

  arrange(): void {
    this.deps.windowManager.arrange();
  }

  enterOverview(): void {
    this.deps.windowManager.enterOverview();
  }

  exitOverview(): void {
    this.deps.windowManager.exitOverview();
  }

  activate(terminalId: number): void {
    this.deps.windowManager.activate(terminalId);
    if (this.deps.windowManager.view().overview) this.deps.windowManager.exitOverview();
  }

  takeControl(terminalId: number): void {
    this.session?.takeControl(terminalId);
  }

  releaseControl(terminalId: number): void {
    this.session?.releaseControl(terminalId);
  }

  move(terminalId: number, position: { x: number; y: number }): void {
    this.deps.windowManager.move(terminalId, position);
  }

  resize(terminalId: number, size: { width: number; height: number }): void {
    this.deps.windowManager.resize(terminalId, size);
  }

  resizeViewport(viewport: { readonly width: number; readonly height: number }): void {
    this.narrowViewport = viewport.width < 1024;
    this.deps.windowManager.setViewport(viewport);
  }

  minimize(terminalId: number): void {
    this.deps.windowManager.minimize(terminalId);
  }

  maximize(terminalId: number): void {
    this.deps.windowManager.maximize(terminalId);
  }

  restore(terminalId: number): void {
    this.deps.windowManager.restore(terminalId);
  }

  closeTerminal(terminalId: number): void {
    this.session?.closeTerminal(terminalId);
  }

  setMode(terminalId: number, mode: "exclusive" | "shared"): void {
    this.session?.setMode(terminalId, mode);
  }

  openTerminal(): void {
    const host = this.deps.projection.view().room?.hosts.find((candidate) => candidate.online);
    if (host) this.session?.openTerminal(host.hostId);
  }

  openNew(hostName: string): void {
    const hostId = this.deps.projection
      .view()
      .room?.hosts.find((host) => host.name === hostName)?.hostId;
    if (hostId) this.session?.openTerminal(hostId);
  }

  createRoom = (name: string): Promise<void> | void => this.deps.createRoom(name);
  navigate = (location: string): void => this.deps.navigate(location);
  route = (): RoomRoute => this.deps.route;
  inputBlocked(): boolean {
    return this.narrowViewport || this.currentView.connection === "restoring";
  }

  hostCommand(): string {
    return `npx ttyroom join ${this.deps.inviteUrl ?? "this-room-url"}`;
  }

  copyText(text: string): void {
    this.deps.copyText?.(text);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.dispose();
    this.controllers.clear();
    this.unsubscribeWindows();
    this.unsubscribeViewport();
    this.unsubscribeSession?.();
    this.unsubscribeProjection();
    this.session?.stop();
    this.subscribers.clear();
  }

  private reconcileTerminals(): void {
    const terminalIds =
      this.deps.projection.view().room?.terminals.map((item) => item.terminalId) ?? [];
    const retained = new Set(terminalIds);
    for (const [terminalId, controller] of this.controllers) {
      if (!retained.has(terminalId)) {
        controller.dispose();
        this.controllers.delete(terminalId);
      }
    }
    for (const terminalId of terminalIds) {
      if (!this.controllers.has(terminalId))
        this.controllers.set(terminalId, this.deps.createController(terminalId));
    }
    this.deps.windowManager.reconcile(terminalIds);
  }

  private screenState(): AppState {
    if (this.deps.route.kind === "entry") return "nickname";
    const connection = this.deps.projection.view().connection;
    if (connection === "gone") return "gone";
    if (connection === "incompatible") return "incompatible";
    if (!this.joined) return "nickname";
    if (!this.deps.projection.view().room) return "joining";
    const restoring = this.deps.projection
      .view()
      .room?.terminals.some(
        (terminal) =>
          this.deps.projection.terminal(terminal.terminalId)?.output.status === "restoring",
      );
    return restoring ? "restoring" : "live";
  }

  private publish(): void {
    this.currentView = this.computeView();
    for (const subscriber of this.subscribers) subscriber();
  }
}

export function RoomApp({ runtime }: { readonly runtime: RoomAppRuntime }) {
  const view = useSyncExternalStore(runtime.subscribe, runtime.view, runtime.view);
  const [closingTerminalId, setClosingTerminalId] = useState<number | null>(null);
  const [addHostOpen, setAddHostOpen] = useState(false);
  const closingTerminal = view.terminals.find(
    (terminal) => terminal.terminalId === closingTerminalId,
  );
  const controlledTerminal = view.terminals.find((terminal) => terminal.status.kind === "mine");
  useWorkspaceKeyboard({
    overlayOpen: addHostOpen || closingTerminalId !== null,
    closeOverlay: () => {
      setAddHostOpen(false);
      setClosingTerminalId(null);
    },
    releaseLease: () => {
      if (controlledTerminal) runtime.releaseControl(controlledTerminal.terminalId);
    },
    overview: view.overview,
    enterOverview: () => runtime.enterOverview(),
    exitOverview: () => runtime.exitOverview(),
  });
  const workspace = (
    <RoomWorkspace
      roomName={view.roomName}
      connection={view.connection}
      terminals={view.terminals.map((terminal) => ({
        terminalId: terminal.terminalId,
        title: terminal.title,
        host: terminal.host,
        cwd: terminal.cwd,
        branch: terminal.branch,
        statusLabel: terminal.status.kind,
      }))}
      commands={{
        invite: () => runtime.invite(),
        arrange: () => runtime.arrange(),
        overview: () => runtime.enterOverview(),
        openMenu: () => undefined,
        addHost: () => setAddHostOpen(true),
      }}
      narrowViewport={runtime.inputBlocked() && view.connection !== "restoring"}
    >
      <TerminalScene
        terminals={view.terminals}
        controllers={runtime.controllersForScene()}
        participants={view.participants}
        activeTerminalId={view.activeTerminalId}
        overview={view.overview}
        inputBlocked={runtime.inputBlocked()}
        actions={{
          activate: (id) => runtime.activate(id),
          takeControl: (id) => runtime.takeControl(id),
          move: (id, position) => runtime.move(id, position),
          resize: (id, size) => runtime.resize(id, size),
          minimize: (id) => runtime.minimize(id),
          maximize: (id) => runtime.maximize(id),
          restore: (id) => runtime.restore(id),
          requestClose: (id) => setClosingTerminalId(id),
          setMode: (id, mode) => runtime.setMode(id, mode),
          exitOverview: () => runtime.exitOverview(),
          addTerminal: () => runtime.openTerminal(),
          openNew: (host) => runtime.openNew(host),
        }}
      />
      <AddHostDrawer
        open={addHostOpen}
        command={runtime.hostCommand()}
        state={{ kind: "waiting" }}
        copy={(command) => runtime.copyText(command)}
        close={() => setAddHostOpen(false)}
      />
      <CloseTerminalDialog
        open={Boolean(closingTerminal)}
        terminalName={closingTerminal?.title ?? "terminal"}
        cancel={() => setClosingTerminalId(null)}
        confirm={() => {
          if (closingTerminalId !== null) runtime.closeTerminal(closingTerminalId);
          setClosingTerminalId(null);
        }}
      />
      <ToastRegion toasts={view.toasts} />
    </RoomWorkspace>
  );
  return (
    <App
      route={runtime.route()}
      roomName={view.roomName}
      state={view.state}
      createRoom={runtime.createRoom}
      navigate={runtime.navigate}
      join={runtime.join}
    >
      {workspace}
    </App>
  );
}

export function createProductionRoomRuntime(
  options: {
    readonly location?: Pick<Location, "pathname" | "hash" | "href">;
    readonly storage?: Storage;
    readonly navigate?: (location: string) => void;
  } = {},
): RoomAppRuntime {
  const location = options.location ?? globalThis.location;
  const storage = options.storage ?? globalThis.localStorage;
  const route = parseRoomRoute(location);
  const identity = new RoomIdentity({ storage, createId: () => globalThis.crypto.randomUUID() });
  const projection = new RoomProjection();
  const windowManager = new WindowManager({
    viewport: {
      width: Math.max(1, globalThis.innerWidth),
      height: Math.max(1, globalThis.innerHeight - 194),
    },
  });
  const viewportBucket = `${Math.max(1, globalThis.innerWidth)}x${Math.max(1, globalThis.innerHeight - 194)}`;
  // The repository owns the versioned browser storage boundary; WindowManager owns clamping.
  const layoutRepository = new LayoutRepository({ storage });
  const roomApi = new RoomApi();
  let session: RoomSession | null = null;
  const navigate = options.navigate ?? ((next: string) => globalThis.location.assign(next));

  return new RoomAppRuntime({
    route,
    identity,
    projection,
    windowManager,
    layoutRepository,
    createSession: (sessionIdentity) => {
      session = new RoomSession(
        {
          projection,
          transportFactory: {
            create: (hello) =>
              new BrowserTransport(
                { socketFactory: new NativeBrowserSocketFactory(), locationHref: location.href },
                { hello },
              ),
          },
          clock: {
            schedule: (delayMs, callback) => {
              const timer = globalThis.setTimeout(callback, delayMs);
              return () => globalThis.clearTimeout(timer);
            },
          },
        },
        { identity: sessionIdentity, reconnectDelaysMs: [250, 500, 1_000, 2_000, 5_000] },
      );
      return session;
    },
    createController: (terminalId) =>
      new TerminalController(
        {
          adapterFactory: { create: () => new XtermAdapter() },
          frameScheduler: {
            schedule: (callback) => {
              const frame = globalThis.requestAnimationFrame(callback);
              return () => globalThis.cancelAnimationFrame(frame);
            },
          },
        },
        {
          terminalId,
          sendInput: (bytes) => {
            session?.sendInput(terminalId, bytes);
          },
          resize: ({ cols, rows }) => session?.resize(terminalId, cols, rows),
        },
      ),
    createRoom: async (name) => {
      const result = await roomApi.createRoom(name);
      if (result.kind === "created") navigate(result.joinUrl);
    },
    navigate,
    copyInvite: () => {
      void globalThis.navigator.clipboard?.writeText(location.href);
    },
    copyText: (text) => {
      void globalThis.navigator.clipboard?.writeText(text);
    },
    inviteUrl: location.href,
    narrowViewport: globalThis.innerWidth < 1024,
    viewportChanges: {
      subscribe: (subscriber) => {
        const handleResize = () =>
          subscriber({
            width: Math.max(1, globalThis.innerWidth),
            height: Math.max(1, globalThis.innerHeight - 194),
          });
        globalThis.addEventListener("resize", handleResize);
        return () => globalThis.removeEventListener("resize", handleResize);
      },
    },
    viewportBucket,
  });
}
