import { inject, InjectionToken } from "@needle-di/core";

export const FeatureFlag = new InjectionToken<boolean>("FeatureFlag");

export class FlagConsumer {
  constructor(public enabled = inject(FeatureFlag)) {}
}

// `fixture.mocks.get(FeatureFlag)` is rewritten to `...get(Symbol.for("FeatureFlag"))`,
// so a registry keyed by that symbol resolves correctly.
export function readFlagMock(fixture: { mocks: { get(token: unknown): unknown } }): unknown {
  return fixture.mocks.get(FeatureFlag);
}
