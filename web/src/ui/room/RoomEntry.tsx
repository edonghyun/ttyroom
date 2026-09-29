import { useState, type FormEvent } from "react";

export function CreateRoomEntry({
  createRoom,
}: {
  readonly createRoom: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState("Quick Room");
  const [creating, setCreating] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = name.trim();
    if (!normalized || creating) return;
    setCreating(true);
    try {
      await createRoom(normalized);
    } finally {
      setCreating(false);
    }
  }

  return (
    <EntryShell heading="Start a Quick Room">
      <form onSubmit={submit}>
        <label>
          Room name
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <button type="submit" disabled={!name.trim() || creating}>
          {creating ? "Creating…" : "Create room"}
        </button>
      </form>
    </EntryShell>
  );
}

export function JoinRoomEntry({
  roomName,
  initialName,
  join,
}: {
  readonly roomName: string;
  readonly initialName: string;
  readonly join: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = name.trim();
    if (normalized) join(normalized);
  }

  return (
    <EntryShell heading={roomName}>
      <form onSubmit={submit}>
        <label>
          Nickname
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="nickname"
            autoFocus
          />
        </label>
        <button type="submit" disabled={!name.trim()}>
          Join room
        </button>
      </form>
    </EntryShell>
  );
}

function EntryShell({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: React.ReactNode;
}) {
  return (
    <main className="entry-screen">
      <section className="entry-sheet" aria-labelledby="entry-heading">
        <p className="eyebrow">TTYRoom</p>
        <h1 id="entry-heading">{heading}</h1>
        {children}
        <p className="entry-note">
          Quick Rooms are temporary and disappear when the server restarts.
        </p>
      </section>
    </main>
  );
}
