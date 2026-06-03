/**
 * Information about a binding that is a candidate for symbolisation.
 */
export interface DependencyInfo {
  /** Local name the binding is referenced by in the file (may be an alias). */
  localName: string;
  /** Original exported name from the source module (or the local name, for local tokens). */
  importedName: string;
  /** Module specifier the binding was imported from (empty for local tokens). */
  source: string;
}

/**
 * Options shared by the transform engine and the Vite/Vitest/Rolldown plugin.
 */
export interface NeedleDiOptimiserOptions {
  /**
   * Module specifier that `inject` / `InjectionToken` are imported from.
   * @default "@needle-di/core"
   */
  needleModule?: string;

  /**
   * Module specifier that the `supply` marker is imported from. Imports whose
   * source equals this value (or starts with `"<value>/"`) are recognised.
   * @default "vitest-needle-di-inject-optimiser"
   */
  supplyModule?: string;

  /**
   * Rewrite the argument of `supply(Dependency)` into the lazy token form:
   *  - imported class → `supply(new InjectionToken(Symbol.for("Dependency"), { factory: … require(…) … }))`
   *  - local `InjectionToken` → `supply(Symbol.for("Dependency"))`
   * @default true
   */
  rewriteSupply?: boolean;

  /**
   * Rewrite `container.bind({ provide: Dependency, ... })` (and `provider:`, and
   * `bindAll`) to `Symbol.for("Dependency")` — but **only** for dependencies that
   * are `supply()`-ed somewhere (tracked across the project).
   * @default true
   */
  rewriteBind?: boolean;

  /**
   * Emit a build-time error when `inject(Dependency)` is used for a dependency that
   * is `supply()`-ed elsewhere (it would resolve eagerly and bypass the symbol).
   * @default true
   */
  diagnoseInject?: boolean;

  /**
   * Predicate deciding whether a binding should be treated as a symbolisable class
   * dependency / token. Tokens like `UPPER_CASE` constants are excluded by default.
   * @default PascalCase names that are not ALL_CAPS (i.e. look like a class)
   */
  shouldOptimise?: (info: DependencyInfo) => boolean;

  /**
   * Compute the global-symbol key for a dependency. Must be derivable from the
   * import alone so production and test code agree. Defaults to the exported name.
   * @default info => info.importedName
   */
  tokenKey?: (info: DependencyInfo) => string;

  /**
   * Map a dependency's import specifier to the string passed to `require(...)`.
   * Defaults to identity (correct for a CJS build / bundler). The Vite plugin
   * overrides this in test/dev to resolve relative specifiers to absolute paths.
   * @default specifier => specifier
   */
  resolveRequireSpecifier?: (specifier: string, importerFilename: string | undefined) => string;
}

/** PascalCase, but not ALL_CAPS — a reasonable "looks like a class" heuristic. */
export function looksLikeClass(name: string): boolean {
  return /^[A-Z]/.test(name) && name !== name.toUpperCase();
}

export function resolveOptions(options: NeedleDiOptimiserOptions = {}): Required<NeedleDiOptimiserOptions> {
  return {
    needleModule: options.needleModule ?? "@needle-di/core",
    supplyModule: options.supplyModule ?? "vitest-needle-di-inject-optimiser",
    rewriteSupply: options.rewriteSupply ?? true,
    rewriteBind: options.rewriteBind ?? true,
    diagnoseInject: options.diagnoseInject ?? true,
    shouldOptimise: options.shouldOptimise ?? ((info) => looksLikeClass(info.importedName)),
    tokenKey: options.tokenKey ?? ((info) => info.importedName),
    resolveRequireSpecifier: options.resolveRequireSpecifier ?? ((specifier) => specifier),
  };
}
