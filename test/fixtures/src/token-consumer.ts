// A locally-declared, exported InjectionToken used by `inject()` in the SAME file.
// The plugin rewrites `inject(ConfigToken)` -> `inject(Symbol.for("ConfigToken"))`,
// matching what `container.bind({ provide: ConfigToken })` becomes in other files.
import { inject, InjectionToken } from "@needle-di/core";

export const ConfigToken = new InjectionToken<{ name: string }>("ConfigToken");

export class ConfigConsumer {
  constructor(public config = inject(ConfigToken)) {}
}
