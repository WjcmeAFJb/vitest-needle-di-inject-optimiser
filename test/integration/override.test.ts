import { beforeEach, describe, expect, it } from "vitest";
import { Container } from "@needle-di/core";
import { Parent } from "../fixtures/src/parent.js";
import { probe } from "../fixtures/src/probe.js";
import { freshStart } from "./setup.js";

// These imports exist ONLY to be used as `provide:` tokens below. The plugin
// rewrites `provide: HeavyService` -> `provide: Symbol.for("HeavyService")` and
// drops these imports — so importing them here must NOT load the real modules.
import { HeavyService } from "../fixtures/src/heavy-service.js";
import { AuditService } from "../fixtures/src/audit-service.js";

describe("override via container.bind — the real dependency code never runs", () => {
  beforeEach(() => freshStart());

  it("uses the mocks and never loads/constructs the real dependencies", () => {
    const container = new Container();

    // Written against the *class* token, exactly like normal needle-di usage.
    // The plugin makes these match the lazy production token.
    container.bind({ provide: HeavyService, useValue: { greet: () => "mock-heavy" } });
    container.bind({ provide: AuditService, useValue: { log: () => "mock-audit" } });

    container.bind(Parent);
    const parent = container.get(Parent);

    // Mocks are injected:
    expect(parent.heavy.greet()).toBe("mock-heavy");
    expect(parent.audit.log()).toBe("mock-audit");

    // The real dependency modules were NEVER loaded (no module-level side effect)...
    expect(probe().heavyLoaded).toBe(false);
    expect(probe().auditLoaded).toBe(false);
    // ...and their constructors NEVER ran:
    expect(probe().heavyConstructed).toBe(0);
    expect(probe().auditConstructed).toBe(0);
  });
});
