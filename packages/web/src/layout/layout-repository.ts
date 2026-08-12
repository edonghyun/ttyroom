import { z } from "zod";

const windowLayoutSchema = z.object({
  terminalId: z.number().int().nonnegative(),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  z: z.number().int().nonnegative(),
  state: z.enum(["floating", "minimized", "maximized"]),
});
const storedLayoutsSchema = z.array(windowLayoutSchema);

export type WindowLayout = z.infer<typeof windowLayoutSchema>;
export interface LayoutScope {
  roomId: string;
  clientId: string;
  viewportBucket: string;
}

export class LayoutRepository {
  constructor(private readonly deps: { storage: Storage }) {}

  load(scope: LayoutScope): WindowLayout[] {
    try {
      const raw = this.deps.storage.getItem(this.key(scope));
      if (!raw) return [];

      const parsedJson: unknown = JSON.parse(raw);
      const parsed = storedLayoutsSchema.safeParse(parsedJson);
      return parsed.success ? parsed.data.map((layout) => ({ ...layout })) : [];
    } catch {
      return [];
    }
  }

  save(scope: LayoutScope, layouts: readonly WindowLayout[]): void {
    const sanitized = storedLayoutsSchema.parse(layouts);
    try {
      this.deps.storage.setItem(this.key(scope), JSON.stringify(sanitized));
    } catch {
      // Layout persistence is optional; browser storage policy must not break the live workspace.
    }
  }

  pruneTerminal(scope: LayoutScope, terminalId: number): void {
    this.save(
      scope,
      this.load(scope).filter((layout) => layout.terminalId !== terminalId),
    );
  }

  clearRoom(roomId: string): void {
    const prefix = `ttyroom:layout:v1:${encodeURIComponent(roomId)}:`;
    try {
      const matchingKeys: string[] = [];
      for (let index = 0; index < this.deps.storage.length; index += 1) {
        const key = this.deps.storage.key(index);
        if (key?.startsWith(prefix)) matchingKeys.push(key);
      }
      for (const key of matchingKeys) this.deps.storage.removeItem(key);
    } catch {
      // Room teardown must complete even when browser storage becomes unavailable.
    }
  }

  private key(scope: LayoutScope): string {
    return [
      "ttyroom:layout:v1",
      encodeURIComponent(scope.roomId),
      encodeURIComponent(scope.clientId),
      encodeURIComponent(scope.viewportBucket),
    ].join(":");
  }
}
