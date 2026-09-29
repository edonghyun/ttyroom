import { useState, type FormEvent } from "react";

export function CreateRoomEntry({
  createRoom,
}: {
  readonly createRoom: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState("Quick Room");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = name.trim();
    if (!normalized || creating) return;
    setCreating(true);
    setError(null);
    try {
      await createRoom(normalized);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create room. Try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <EntryShell heading="Start a Quick Room">
      <form onSubmit={submit}>
        {error && <p role="alert">{error}</p>}
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
  error,
  join,
}: {
  readonly roomName: string;
  readonly initialName: string;
  readonly error?: string;
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
        {error && <p role="alert">{error}</p>}
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
          Keep this tab to manage your room. Share only the invitation link.
        </p>
      </section>
    </main>
  );
}
