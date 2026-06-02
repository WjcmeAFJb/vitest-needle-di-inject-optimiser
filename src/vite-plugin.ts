import { createNeedleDiBabelPlugin } from "./babel-plugin.js";
import { resolveSourceSpecifierSync } from "./resolve.js";
import { type NeedleDiOptimiserOptions } from "./options.js";

/** Minimal Rollup/Vite/Rolldown plugin shape (avoids a hard dependency on vite types). */
interface MinimalPlugin {
  name: string;
  enforce?: "pre" | "post";
  configResolved?(config: { command?: string; test?: unknown }): void;
  transform(
    this: unknown,
    code: string,
    id: string,
  ): Promise<{ code: string; map?: unknown } | null> | { code: string; map?: unknown } | null;
}

export interface NeedleDiVitePluginOptions extends NeedleDiOptimiserOptions {
  /** Files to process. @default /\.[cm]?[jt]sx?$/ */
  include?: RegExp | RegExp[];
  /** Files to ignore. @default /node_modules/ */
  exclude?: RegExp | RegExp[];
  /**
   * Extra `@babel/parser` plugins. Decorators (stage-3 `2023-05`) and TypeScript
   * are enabled automatically based on the file extension.
   */
  parserPlugins?: unknown[];
  /**
   * How to resolve the `require(...)` specifier.
   *  - `"absolute"` (default): resolve relative specifiers to on-disk paths so
   *    Vitest's Node `require` can load them. Recommended for tests.
   *  - `"preserve"`: keep the original specifier (use when building for production).
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

function parserPluginsFor(filepath: string, extra: unknown[]): unknown[] {
  const isTsx = /\.tsx$/.test(filepath);
  const isJsx = /\.(jsx|mjs|cjs|js)$/.test(filepath);
  const isTs = /\.(ts|mts|cts|tsx)$/.test(filepath);
  const plugins: unknown[] = [];
  if (isTs) plugins.push(isTsx ? ["typescript", { isTSX: true, dts: false }] : "typescript");
  if (isTsx || isJsx) plugins.push("jsx");
  plugins.push(["decorators", { version: "2023-05" }]);
  plugins.push("importAttributes", "explicitResourceManagement");
  return [...plugins, ...extra];
}

/**
 * Vite / Vitest / Rolldown plugin that lazily rewrites needle-di `inject()` and
 * `container.bind()` usage. Works in any Rollup-compatible pipeline (it only uses
 * the standard `transform` hook with `enforce: "pre"`); TypeScript is preserved
 * and left for the host pipeline (esbuild) to strip.
 */
export function needleDiInjectOptimiser(options: NeedleDiVitePluginOptions = {}): MinimalPlugin {
  const needleModule = options.needleModule ?? "@needle-di/core";
  const include = toArray(options.include).length ? toArray(options.include) : [/\.[cm]?[jt]sx?$/];
  const exclude = toArray(options.exclude).length ? toArray(options.exclude) : [/node_modules/];
  const extraParserPlugins = options.parserPlugins ?? [];
  // Resolved lazily: explicit option wins; otherwise inferred from the Vite mode.
  let requireResolution = options.requireResolution;

  let babelCore: typeof import("@babel/core") | undefined;

  return {
    name: "vitest-needle-di-inject-optimiser",
    enforce: "pre",
    configResolved(config) {
      if (requireResolution) return; // user was explicit
      const isVitest = Boolean(config.test) || Boolean(process.env.VITEST);
      // A production `vite build` must not bake absolute machine paths into the
      // bundle, so preserve the original specifier there; tests/dev resolve to
      // absolute paths so Vitest's Node `require` can find the source file.
      requireResolution = config.command === "build" && !isVitest ? "preserve" : "absolute";
    },
    async transform(code: string, id: string) {
      const filepath = id.split("?")[0];
      if (matches(exclude, filepath)) return null;
      if (!matches(include, filepath)) return null;
      // Cheap gate: the Babel plugin only acts on files importing the needle module.
      if (!code.includes(needleModule)) return null;

      babelCore ??= await import("@babel/core");

      const mode = requireResolution ?? "absolute";
      const resolveRequireSpecifier =
        mode === "absolute"
          ? (specifier: string) => resolveSourceSpecifierSync(specifier, filepath)
          : options.resolveRequireSpecifier;

      const result = await babelCore.transformAsync(code, {
        configFile: false,
        babelrc: false,
        filename: filepath,
        sourceType: "module",
        sourceMaps: true,
        parserOpts: { plugins: parserPluginsFor(filepath, extraParserPlugins) as never },
        plugins: [[createNeedleDiBabelPlugin as never, { ...options, resolveRequireSpecifier }]],
      });

      if (!result || result.code == null) return null;
      return { code: result.code, map: result.map ?? undefined };
    },
  };
}

export default needleDiInjectOptimiser;
