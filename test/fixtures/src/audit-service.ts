import { inject } from "@needle-di/core";

const g = globalThis as Record<string, any>;
const KEY = "__needleDiOptimiserProbe__";
(g[KEY] ??= {}).auditLoaded = true; // side effect

export class AuditService {
  readonly ctxOk: boolean;

  constructor() {
    g[KEY].auditConstructed = (g[KEY].auditConstructed ?? 0) + 1;
    try {
      inject(Symbol.for("never-bound"), { optional: true });
      this.ctxOk = true;
    } catch {
      this.ctxOk = false;
    }
  }

  log(): string {
    return "real-audit";
  }
}
