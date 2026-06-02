// A "heavy" dependency with an observable MODULE-LEVEL side effect.
// It imports only node_modules (needle-di), never another source file, so it can
// be loaded via Node `require` without a separate source module graph.
import { inject } from "@needle-di/core";

const g = globalThis as Record<string, any>;
const KEY = "__needleDiOptimiserProbe__";
(g[KEY] ??= {}).heavyLoaded = true; // <-- side effect: runs only if this module is actually loaded

export class HeavyService {
  /** Proof that needle-di's injection context is shared across the require boundary. */
  readonly ctxOk: boolean;

  constructor() {
    g[KEY].heavyConstructed = (g[KEY].heavyConstructed ?? 0) + 1; // constructor side effect
    try {
      inject(Symbol.for("never-bound"), { optional: true });
      this.ctxOk = true;
    } catch {
      this.ctxOk = false;
    }
  }

  greet(): string {
    return "real-heavy";
  }
}
