import { transformNeedleDi, collectSupplyKeys } from "../../src/oxc-transform.js";
import type { NeedleDiOptimiserOptions } from "../../src/options.js";

/** Run the transform; `supplied` is the project-wide supply set (gates bind/inject). */
export function transform(
  code: string,
  supplied: Iterable<string> = [],
  options: NeedleDiOptimiserOptions = {},
  filename = "input.ts",
): string {
  return transformNeedleDi(code, filename, options, new Set(supplied))?.code ?? code;
}

export function supplyKeys(code: string, options: NeedleDiOptimiserOptions = {}, filename = "input.ts"): Set<string> {
  return collectSupplyKeys(code, filename, options);
}

/** Collapse insignificant whitespace for stable structural comparisons. */
export function norm(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}

/** Convenience: the standard supply import line used in fixtures. */
export const SUPPLY_IMPORT = `import { supply } from 'vitest-needle-di-inject-optimiser/runtime';`;
