import fs from "node:fs/promises";
import path from "node:path";
import { collectSupplyKeys, transformNeedleDi } from "./oxc-transform.js";
import { resolveSourceSpecifierSync } from "./resolve.js";
import { type NeedleDiOptimiserOptions } from "./options.js";

/** Minimal Rollup/Vite/Rolldown plugin shape (avoids a hard dependency on vite types). */
interface MinimalPlugin {
  name: string;
  enforce?: "pre" | "post";
  configResolved?(config: { command?: string; test?: unknown; root?: string }): void;
  buildStart?(this: unknown): void;
  transform: {
    filter?: { code?: RegExp };
    order?: "pre" | "post";
    handler(this: unknown, code: string, id: string): Promise<{ code: string; map?: unknown } | null>;
  };
}

export interface NeedleDiVitePluginOptions extends NeedleDiOptimiserOptions {
  /** Files to process. @default /\.[cm]?[jt]sx?$/ */
  include?: RegExp | RegExp[];
  /** Files to ignore. @default /node_modules/ */
  exclude?: RegExp | RegExp[];
  /**
   * How to resolve the `require(...)` specifier. Defaults to `"absolute"` in
   * test/dev (so Vitest's Node `require` finds the source) and `"preserve"` in a
   * production `vite build`.
   */
  requireResolution?: "absolute" | "preserve";
  /**
   * Directory to scan for `supply()` usage. Defaults to the Vite `root`.
   */
  scanRoot?: string;
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const ALWAYS_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
  ".hg",
  ".cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
]);

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

/** Walk the project once and collect every `supply(X)` token key. */
async function scanSupplyKeys(
  root: string,
  options: NeedleDiOptimiserOptions,
  include: RegExp[],
  exclude: RegExp[],
): Promise<Set<string>> {
  const supplyModule = options.supplyModule ?? "vitest-needle-di-inject-optimiser";
  const keys = new Set<string>();

  async function walkDir(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (ALWAYS_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) return;
          if (matches(exclude, full)) return;
          await walkDir(full);
        } else if (entry.isFile()) {
          if (!SOURCE_EXT.test(entry.name)) return;
          if (matches(exclude, full) || !matches(include, full)) return;
          let code: string;
          try {
            code = await fs.readFile(full, "utf8");
          } catch {
            return;
          }
          if (!code.includes(supplyModule)) return; // cheap gate before parsing
          for (const key of collectSupplyKeys(code, full, options)) keys.add(key);
        }
      }),
    );
  }

  await walkDir(root);
  return keys;
}

/**
 * Vite / Vitest / Rolldown plugin. `supply(Dependency)` becomes the lazy
 * `Symbol.for(...)` form; `inject(Dependency)` is left as-is unless `Dependency` is
 * `supply()`-ed elsewhere (then it's a build error). `container.bind({ provide })`
 * is rewritten only for supply()-ed dependencies. The supply set is built from a
 * one-time project scan.
 */
export function needleDiInjectOptimiser(options: NeedleDiVitePluginOptions = {}): MinimalPlugin {
  const needleModule = options.needleModule ?? "@needle-di/core";
  const supplyModule = options.supplyModule ?? "vitest-needle-di-inject-optimiser";
  const include = toArray(options.include).length ? toArray(options.include) : [/\.[cm]?[jt]sx?$/];
  const exclude = toArray(options.exclude).length ? toArray(options.exclude) : [/node_modules/];
  let requireResolution = options.requireResolution;

  let root = options.scanRoot ?? process.cwd();
  let scanPromise: Promise<Set<string>> | undefined;
  const ensureScan = (): Promise<Set<string>> => (scanPromise ??= scanSupplyKeys(root, options, include, exclude));

  const filter = new RegExp(`${escapeRegExp(needleModule)}|${escapeRegExp(supplyModule)}`);

  return {
    name: "vitest-needle-di-inject-optimiser",
    enforce: "pre",
    configResolved(config) {
      if (config.root) root = options.scanRoot ?? config.root;
      if (!requireResolution) {
        const isVitest = Boolean(config.test) || Boolean(process.env.VITEST);
        requireResolution = config.command === "build" && !isVitest ? "preserve" : "absolute";
      }
    },
    buildStart() {
      // Kick the scan off early; transform() awaits the same promise.
      void ensureScan();
    },
    transform: {
      filter: { code: filter },
      order: "pre",
      async handler(code: string, id: string) {
        const filepath = id.split("?")[0];
        if (matches(exclude, filepath)) return null;
        if (!matches(include, filepath)) return null;
        if (!code.includes(needleModule) && !code.includes(supplyModule)) return null;

        const suppliedKeys = await ensureScan();

        const mode = requireResolution ?? "absolute";
        const resolveRequireSpecifier =
          mode === "absolute"
            ? (specifier: string) => resolveSourceSpecifierSync(specifier, filepath)
            : options.resolveRequireSpecifier;

        const result = transformNeedleDi(code, filepath, { ...options, resolveRequireSpecifier }, suppliedKeys);
        if (!result) return null;
        return { code: result.code, map: result.map };
      },
    },
  };
}

export default needleDiInjectOptimiser;
