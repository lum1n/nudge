import type { LiveOutput } from "./live.ts";

export type Viewer = { readonly name: string; readonly send: (output: LiveOutput) => void };

/** Who watches a room's browser, and which of them controls it. */
export class Viewers {
  private readonly all = new Set<Viewer>();
  holder: Viewer | undefined;

  join(viewer: Viewer): void {
    this.all.add(viewer);
    this.holder ??= viewer;
    this.announce();
  }

  leave(viewer: Viewer): void {
    this.all.delete(viewer);
    if (this.holder === viewer) this.holder = this.all.values().next().value;
    this.announce();
  }

  take(viewer: Viewer): void {
    this.holder = viewer;
    this.announce();
  }

  broadcast(output: LiveOutput): void {
    for (const viewer of this.all) viewer.send(output);
  }

  private announce(): void {
    for (const viewer of this.all)
      viewer.send({ type: "control", holder: this.holder?.name, you: viewer === this.holder });
  }
}

// Module state, like the browser pool: it outlives `nudge reload`, which re-imports only the entry module.
const viewersByScope = new Map<string, Viewers>();
export function viewersOf(scope: string): Viewers {
  let viewers = viewersByScope.get(scope);
  if (viewers === undefined) viewersByScope.set(scope, (viewers = new Viewers()));
  return viewers;
}
