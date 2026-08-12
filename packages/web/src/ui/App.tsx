import type { ReactNode } from "react";

import type { RoomRoute } from "../app/room-route.js";
import { CreateRoomEntry, JoinRoomEntry } from "./room/RoomEntry.js";
import { RoomGone } from "./room/RoomGone.js";

export type AppState = "nickname" | "joining" | "restoring" | "live" | "gone" | "incompatible";

export function App({
  route,
  roomName,
  state,
  createRoom,
  navigate,
  join,
  children,
}: {
  readonly route: RoomRoute;
  readonly roomName: string;
  readonly state: AppState;
  readonly createRoom: (name: string) => Promise<void> | void;
  readonly navigate: (location: string) => void;
  readonly join: (roomId: string, nickname: string) => void;
  readonly children?: ReactNode;
}) {
  if (state === "gone") return <RoomGone createNew={() => navigate("/")} />;
  if (state === "incompatible") {
    return (
      <main className="entry-screen">
        <section className="entry-sheet">
          <h1>TTYRoom needs an update</h1>
          <p>This client and server use incompatible protocol versions. Update and try again.</p>
        </section>
      </main>
    );
  }
  if (route.kind === "entry") return <CreateRoomEntry createRoom={createRoom} />;
  if (state === "nickname") {
    return (
      <JoinRoomEntry
        roomName={roomName}
        initialName=""
        join={(nickname) => join(route.roomId, nickname)}
      />
    );
  }
  if (state === "joining" || (state === "restoring" && !children)) {
    return (
      <main className="entry-screen">
        <p role="status">
          {state === "joining" ? `Joining ${roomName}…` : "Restoring terminals and output…"}
        </p>
      </main>
    );
  }

  if (state === "restoring") return <>{children}</>;

  return <>{children}</>;
}
