// A globalThis-backed probe so that observations are shared across the
// Vite (test) <-> Node `require` (lazily-loaded dependency) module boundary.
export interface Probe {
  heavyLoaded: boolean;
  heavyConstructed: number;
  auditLoaded: boolean;
  auditConstructed: number;
}

const KEY = "__needleDiOptimiserProbe__";

export function probe(): Probe {
  const g = globalThis as Record<string, unknown>;
  return (g[KEY] ??= {
    heavyLoaded: false,
    heavyConstructed: 0,
    auditLoaded: false,
    auditConstructed: 0,
  }) as Probe;
}

export function resetProbe(): Probe {
  const fresh: Probe = { heavyLoaded: false, heavyConstructed: 0, auditLoaded: false, auditConstructed: 0 };
  (globalThis as Record<string, unknown>)[KEY] = fresh;
  return fresh;
}
