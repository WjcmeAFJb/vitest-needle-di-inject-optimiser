// Production-style consumer. The plugin rewrites both `inject(...)` calls into the
// lazy `InjectionToken` + `require()` form and removes these two value imports.
import { inject } from "@needle-di/core";
import { HeavyService } from "./heavy-service.js";
import { AuditService } from "./audit-service.js";

export class Parent {
  constructor(
    public heavy = inject(HeavyService),
    public audit = inject(AuditService),
  ) {}
}
