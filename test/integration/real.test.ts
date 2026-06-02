import { beforeEach, describe, expect, it } from "vitest";
import { Container } from "@needle-di/core";
import { Parent } from "../fixtures/src/parent.js";
import { probe } from "../fixtures/src/probe.js";
import { freshStart } from "./setup.js";

describe("no override — dependencies load lazily and really run", () => {
  beforeEach(() => freshStart());

  it("does not load the dependency modules merely by importing Parent", () => {
    // Parent was imported at the top of this file; the plugin removed its static
    // imports of HeavyService / AuditService, so nothing loaded yet.
    expect(probe().heavyLoaded).toBe(false);
    expect(probe().auditLoaded).toBe(false);
  });

  it("lazily requires each real dependency on first inject and runs its code", () => {
    const container = new Container();
    container.bind(Parent);
    const parent = container.get(Parent);

    // Real implementations are used:
    expect(parent.heavy.greet()).toBe("real-heavy");
    expect(parent.audit.log()).toBe("real-audit");

    // Both module-level side effects ran (the modules were actually required):
    expect(probe().heavyLoaded).toBe(true);
    expect(probe().auditLoaded).toBe(true);

    // Both constructors ran exactly once (singletons):
    expect(probe().heavyConstructed).toBe(1);
    expect(probe().auditConstructed).toBe(1);

    // needle-di's injection context is shared across the require() boundary:
    expect(parent.heavy.ctxOk).toBe(true);
    expect(parent.audit.ctxOk).toBe(true);
  });
});
