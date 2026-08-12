import { Grid, Link, MoreVertical, Monitor, Plus, Terminal } from "react-feather";

export type ConnectionLabel = "connected" | "reconnecting" | "restoring";

export function TopBar({
  roomName,
  connection,
  invite,
  arrange,
  overview,
  openMenu,
  addHost,
}: {
  readonly roomName: string;
  readonly connection: ConnectionLabel;
  readonly invite: () => void;
  readonly arrange: () => void;
  readonly overview: () => void;
  readonly openMenu: () => void;
  readonly addHost?: () => void;
}) {
  return (
    <header className="top-bar">
      <a className="brand" href="/">
        <span className="brand-mark" data-icon="terminal">
          <Terminal size={17} strokeWidth={1.5} aria-hidden="true" />
        </span>
        TTYRoom
      </a>
      <strong className="room-name">{roomName}</strong>
      <span className={`connection connection-${connection}`} role="status">
        {connection === "connected"
          ? "Connected"
          : connection === "restoring"
            ? "Restoring"
            : "Reconnecting"}
      </span>
      <nav aria-label="Room commands">
        <button type="button" onClick={invite}>
          <Link size={16} strokeWidth={1.5} aria-hidden="true" /> Invite link
        </button>
        <button type="button" onClick={arrange} aria-label="Arrange terminals">
          <Grid size={16} strokeWidth={1.5} aria-hidden="true" /> Arrange
        </button>
        <button type="button" onClick={overview} aria-label="Open overview">
          <Monitor size={16} strokeWidth={1.5} aria-hidden="true" /> Overview
        </button>
        <button type="button" onClick={openMenu} aria-label="Open room menu">
          <MoreVertical size={16} strokeWidth={1.5} aria-hidden="true" /> Room menu
        </button>
        {addHost && (
          <button type="button" className="add-host-command" onClick={addHost}>
            <Plus size={16} strokeWidth={1.5} aria-hidden="true" /> Add host
          </button>
        )}
      </nav>
    </header>
  );
}
