import { beforeEach, describe, expect, it } from "vitest";
import { Container } from "@needle-di/core";
import { Parent } from "../fixtures/src/parent.js";
import { probe } from "../fixtures/src/probe.js";
import { freshStart } from "./setup.js";

// Only HeavyService is imported (to override it). AuditService is left to load for real.
import { HeavyService } from "../fixtures/src/heavy-service.js";

describe("selective override — override one dependency, let the other load for real", () => {
  beforeEach(() => freshStart());

  it("skips the overridden module entirely while the other loads lazily", () => {
    const container = new Container();
    container.bind({ provide: HeavyService, useValue: { greet: () => "mock-heavy" } });
    container.bind(Parent);
    const parent = container.get(Parent);

    // Overridden one: mock used, real module untouched.
    expect(parent.heavy.greet()).toBe("mock-heavy");
    expect(probe().heavyLoaded).toBe(false);
    expect(probe().heavyConstructed).toBe(0);

    // Non-overridden one: real module lazily loaded and constructed.
    expect(parent.audit.log()).toBe("real-audit");
    expect(probe().auditLoaded).toBe(true);
    expect(probe().auditConstructed).toBe(1);
    expect(parent.audit.ctxOk).toBe(true);
  });
});
