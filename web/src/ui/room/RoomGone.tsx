export function RoomGone({ createNew }: { readonly createNew: () => void }) {
  return (
    <main className="entry-screen room-gone">
      <section className="entry-sheet" aria-labelledby="room-gone-heading">
        <p className="eyebrow">Room gone</p>
        <h1 id="room-gone-heading">This Quick Room no longer exists</h1>
        <p>
          The server may have restarted. Local processes can still be running if TTYRoom Connector
          is still running on that computer.
        </p>
        <button type="button" onClick={createNew}>
          Create a new room
        </button>
      </section>
    </main>
  );
}
