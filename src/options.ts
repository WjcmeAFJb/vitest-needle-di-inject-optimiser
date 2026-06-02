/**
 * Information about an imported binding that is a candidate for lazy optimisation.
 */
export interface DependencyInfo {
  /** Local name the binding is referenced by in the file (may be an alias). */
  localName: string;
  /** Original exported name from the source module. */
  importedName: string;
  /** Module specifier the binding was imported from. */
  source: string;
}

/**
 * Options shared by the Babel plugin and the Vite/Vitest/Rolldown plugin.
 */
export interface NeedleDiOptimiserOptions {
  /**
   * Module specifier that `inject` / `InjectionToken` are imported from.
   * @default "@needle-di/core"
   */
  needleModule?: string;

  /**
   * Rewrite `inject(Dependency)` into the lazy `InjectionToken` + `require()` form.
   * @default true
   */
  rewriteInject?: boolean;

  /**
   * Rewrite `container.bind({ provide: Dependency, ... })` (and `provider:`, and
   * `bindAll`) so the token becomes `Symbol.for("Dependency")`, matching the token
   * produced for the lazy `inject` form.
   * @default true
   */
  rewriteBind?: boolean;

  /**
   * Rewrite the argument of a `mocks.get(Dependency)` call (e.g. a test fixture's
   * mock registry, possibly prefixed like `fixture.mocks.get(Dependency)`) to
   * `Symbol.for("Dependency")`, so it matches the rewritten provider token.
   * @default true
   */
  rewriteMockGet?: boolean;

  /**
   * Predicate deciding whether a named import should be treated as a lazy class
   * dependency. Tokens (e.g. `InjectionToken` instances, symbols, `UPPER_CASE`
   * constants) must NOT be optimised, otherwise their identity would break.
   *
   * @default PascalCase names that are not ALL_CAPS (i.e. look like a class)
   */
  shouldOptimise?: (info: DependencyInfo) => boolean;

  /**
   * Compute the global-symbol key used for a dependency. Production code and test
   * code must agree on this key for overrides to work, so it must be derivable
   * from the import alone. Defaults to the *exported* name, which is stable across
   * files regardless of local aliasing.
   *
   * @default info => info.importedName
   */
  tokenKey?: (info: DependencyInfo) => string;

  /**
   * Map a dependency's import specifier to the string passed to `require(...)`.
   *
   * The default preserves the specifier verbatim, which is what you want for a
   * production CJS build or a bundler. The Vite/Vitest plugin overrides this to
   * resolve relative specifiers to absolute on-disk paths so that Node's
   * `require` (used by Vitest) can locate the real source file.
   *
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
    rewriteInject: options.rewriteInject ?? true,
    rewriteBind: options.rewriteBind ?? true,
    rewriteMockGet: options.rewriteMockGet ?? true,
    shouldOptimise: options.shouldOptimise ?? ((info) => looksLikeClass(info.importedName)),
    tokenKey: options.tokenKey ?? ((info) => info.importedName),
    resolveRequireSpecifier: options.resolveRequireSpecifier ?? ((specifier) => specifier),
  };
}
