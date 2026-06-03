// Production-style consumer. `supply(X)` opts each dependency into lazy loading:
// the plugin rewrites the argument into the InjectionToken + require() form, drops
// these two value imports, and adds the InjectionToken import.
import { supply } from "vitest-needle-di-inject-optimiser/runtime";
import { HeavyService } from "./heavy-service.js";
import { AuditService } from "./audit-service.js";

export class Parent {
  constructor(
    public heavy = supply(HeavyService),
    public audit = supply(AuditService),
  ) {}
}
