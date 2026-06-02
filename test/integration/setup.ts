import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resetProbe, type Probe } from "../fixtures/src/probe.js";

const require = createRequire(import.meta.url);

// The lazily-required dependency modules. We evict them from Node's require cache
// before each test so the MODULE-LEVEL side effect is observed deterministically,
// independent of test execution order or worker reuse.
const DEP_FILES = ["../fixtures/src/heavy-service.ts", "../fixtures/src/audit-service.ts"];

/** Reset the probe and force the dependency modules to be freshly loadable. */
export function freshStart(): Probe {
  for (const rel of DEP_FILES) {
    const abs = fileURLToPath(new URL(rel, import.meta.url));
    try {
      delete require.cache[require.resolve(abs)];
    } catch {
      /* not yet cached — fine */
    }
  }
  return resetProbe();
}
