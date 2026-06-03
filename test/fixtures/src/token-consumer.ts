// A locally-declared, exported InjectionToken consumed via supply() in the SAME file.
// supply(ConfigToken) becomes supply(Symbol.for("ConfigToken")), matching what
// container.bind({ provide: ConfigToken }) becomes in other files (because
// ConfigToken is in the project-wide supply set).
import { supply } from "vitest-needle-di-inject-optimiser/runtime";
import { InjectionToken } from "@needle-di/core";

export const ConfigToken = new InjectionToken<{ name: string }>("ConfigToken");

export class ConfigConsumer {
  constructor(public config = supply(ConfigToken)) {}
}
