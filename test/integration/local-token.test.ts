import { describe, expect, it } from "vitest";
import { Container } from "@needle-di/core";
import { ConfigConsumer, ConfigToken } from "../fixtures/src/token-consumer.js";

describe("local exported InjectionToken — inject() and bind() agree on the symbol", () => {
  it("binds via the imported token and resolves in the consumer's inject()", () => {
    const container = new Container();
    // `provide: ConfigToken` is rewritten to `Symbol.for("ConfigToken")`, matching the
    // consumer's `inject(ConfigToken)` which was rewritten the same way.
    container.bind({ provide: ConfigToken, useValue: { name: "mock-config" } });
    container.bind(ConfigConsumer);

    const consumer = container.get(ConfigConsumer);
    expect(consumer.config.name).toBe("mock-config");
  });

  it("uses a different bound value (proves the symbol wiring, not a constant)", () => {
    const container = new Container();
    container.bind({ provide: ConfigToken, useValue: { name: "real-config" } });
    container.bind(ConfigConsumer);

    expect(container.get(ConfigConsumer).config.name).toBe("real-config");
  });
});
