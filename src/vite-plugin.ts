import transformNeedleDi from "./oxc-transform.js";
import { resolveSourceSpecifierSync } from "./resolve.js";
import { type NeedleDiOptimiserOptions } from "./options.js";

/** Minimal Rollup/Vite/Rolldown plugin shape (avoids a hard dependency on vite types). */
interface MinimalPlugin {
  name: string;
  enforce?: "pre" | "post";
  configResolved?(config: { command?: string; test?: unknown }): void;
  transform: {
    /**
     * Rolldown/Rollup hook filter — evaluated in Rust, so files that don't import
     * needle-di never cross into JS at all.
     */
    filter?: { code?: RegExp };
    order?: "pre" | "post";
    handler(this: unknown, code: string, id: string): { code: string; map?: unknown } | null;
  };
}

export interface NeedleDiVitePluginOptions extends NeedleDiOptimiserOptions {
  /** Files to process. @default /\.[cm]?[jt]sx?$/ */
  include?: RegExp | RegExp[];
  /** Files to ignore. @default /node_modules/ */
  exclude?: RegExp | RegExp[];
  /**
   * How to resolve the `require(...)` specifier.
   *  - `"absolute"`: resolve relative specifiers to on-disk paths so Vitest's Node
   *    `require` can load them. Best for tests.
   *  - `"preserve"`: keep the original specifier (for production bundles).
   *  Defaults to `"absolute"` in test/dev and `"preserve"` in a production `vite build`.
   */
  requireResolution?: "absolute" | "preserve";
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function matches(patterns: RegExp[], id: string): boolean {
  return patterns.some((re) => re.test(id));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Vite / Vitest / Rolldown plugin that lazily rewrites needle-di `inject()` and
 * `container.bind()` usage.
 *
 * It parses with **oxc** (the native Rust parser, also used by rolldown) and edits
 * with **magic-string** — no Babel, no full re-print. A rolldown `transform` hook
 * filter keeps files that don't import needle-di entirely out of the JS hot path.
 *
 * Works in any Rollup-compatible pipeline (`enforce: "pre"`), including `vite build`,
 * `rolldown`, and `rolldown-vite`. TypeScript is preserved for the host pipeline
 * (esbuild/oxc) to strip.
 */
export function needleDiInjectOptimiser(options: NeedleDiVitePluginOptions = {}): MinimalPlugin {
  const needleModule = options.needleModule ?? "@needle-di/core";
  const include = toArray(options.include).length ? toArray(options.include) : [/\.[cm]?[jt]sx?$/];
  const exclude = toArray(options.exclude).length ? toArray(options.exclude) : [/node_modules/];
  // Resolved lazily: explicit option wins; otherwise inferred from the Vite mode.
  let requireResolution = options.requireResolution;

  return {
    name: "vitest-needle-di-inject-optimiser",
    enforce: "pre",
    configResolved(config) {
      if (requireResolution) return; // user was explicit
      const isVitest = Boolean(config.test) || Boolean(process.env.VITEST);
      requireResolution = config.command === "build" && !isVitest ? "preserve" : "absolute";
    },
    transform: {
      filter: { code: new RegExp(escapeRegExp(needleModule)) },
      order: "pre",
      handler(code: string, id: string) {
        const filepath = id.split("?")[0];
        if (matches(exclude, filepath)) return null;
        if (!matches(include, filepath)) return null;
        if (!code.includes(needleModule)) return null;

        const mode = requireResolution ?? "absolute";
        const resolveRequireSpecifier =
          mode === "absolute"
            ? (specifier: string) => resolveSourceSpecifierSync(specifier, filepath)
            : options.resolveRequireSpecifier;

        const result = transformNeedleDi(code, filepath, { ...options, resolveRequireSpecifier });
        if (!result) return null;
        return { code: result.code, map: result.map };
      },
    },
  };
}

export default needleDiInjectOptimiser;
