import { describe, expect, it } from "vitest";
import { Container } from "@needle-di/core";
import { FlagConsumer, FeatureFlag, readFlagMock } from "../fixtures/src/mock-getter.js";

describe("mocks.get(Token) is keyed by the same Symbol as inject()/bind()", () => {
  it("resolves a mock from a registry keyed by Symbol.for(...)", () => {
    // The fixture's `fixture.mocks.get(FeatureFlag)` was rewritten to
    // `...get(Symbol.for("FeatureFlag"))`, so this symbol-keyed registry matches.
    const mocks = new Map<unknown, unknown>([[Symbol.for("FeatureFlag"), "mocked-flag"]]);
    expect(readFlagMock({ mocks })).toBe("mocked-flag");
  });

  it("the same symbol drives inject()/bind() too", () => {
    const container = new Container();
    container.bind({ provide: FeatureFlag, useValue: true });
    container.bind(FlagConsumer);
    expect(container.get(FlagConsumer).enabled).toBe(true);
  });
});
