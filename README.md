# vitest-needle-di-inject-optimiser

A **Vite / Vitest / Rolldown plugin** that makes [`@needle-di/core`](https://needle-di.io)
dependencies **lazy and overridable** — opt in per dependency with `supply()` instead of
`inject()`.

Mark a dependency with `supply(Dependency)` and the plugin rewrites it to load the real module
**lazily, via `require()` on demand**, behind a global `Symbol.for("Dependency")` token. In a
test you override it with `container.bind(...)` and the **real module never loads** — its
import-time and constructor side effects never run.

```ts
// You write:
import { supply } from "vitest-needle-di-inject-optimiser/runtime";
import { Dependency } from "./subpath";

class Parent {
  constructor(private dep = supply(Dependency)) {}
}
```

```ts
// The plugin produces (the `./subpath` import is dropped):
import { supply } from "vitest-needle-di-inject-optimiser/runtime";
import { InjectionToken } from "@needle-di/core";

class Parent {
  constructor(
    private dep = supply(
      new InjectionToken(Symbol.for("Dependency"), {
        factory: (container) =>
          container.get(Symbol.for("Dependency"), { optional: true }) ??
          container
            .bind({ provide: Symbol.for("Dependency"), useClass: require("./subpath").Dependency })
            .get(Symbol.for("Dependency")),
      }),
    ),
  ) {}
}
```

> `supply` is a runtime alias for needle-di's `inject` (see [runtime](#the-supply-marker)), so
> `supply(new InjectionToken(…))` is exactly `inject(new InjectionToken(…))`. Your code behaves
> identically whether or not the plugin runs.

## Why `supply()` instead of catching every `inject()`?

`inject()` is left **completely untouched** — everything you already have keeps working. Only
the dependencies you explicitly mark with `supply()` change. That makes the optimisation
opt-in and predictable, and it gives the plugin a precise, project-wide list of which
dependencies are "lazy tokens". From that list it can:

- **Rewrite `container.bind({ provide: Dependency })` → `provide: Symbol.for("Dependency")`** —
  but **only** for dependencies that are `supply()`-ed somewhere, so unrelated binds are never
  touched.
- **Error at build time on `inject(Dependency)`** when `Dependency` is `supply()`-ed elsewhere
  — an eager `inject()` would resolve the real class and bypass the override, so it's almost
  certainly a mistake.

## How it works

`Symbol.for("Dependency")` is a key in the **global symbol registry**, so the symbol is the
same object in every module — production and test code agree on it without sharing an import.

- **No override** — the `InjectionToken` factory asks the container for the symbol; nothing is
  bound, so it lazily `require()`s the real class, binds it, returns it. Loaded only on first use.
- **Override in a test** — your `container.bind({ provide: Dependency, useValue: mock })`
  (rewritten to the symbol) is found by `container.get(…, { optional: true })`, so the
  `require()` is **never reached** and the real module never evaluates.

> ℹ️ `{ optional: true }` is required: needle-di's `container.get()` throws when a token is
> unbound, so the `??` fallback only works with the optional overload.

## Install

```bash
pnpm add -D vitest-needle-di-inject-optimiser
pnpm add @needle-di/core   # peer dependency (the `supply` runtime re-exports its `inject`)
```

Distributed as a pnpm-installable tarball on GitHub Releases — see
[Consuming the release tarball](#consuming-the-release-tarball).

## Usage

### Plugin (Vite / Vitest / Rolldown)

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import needleDiInjectOptimiser from "vitest-needle-di-inject-optimiser/vite";

export default defineConfig({
  plugins: [needleDiInjectOptimiser()],
});
```

`enforce: "pre"`, parses with **oxc** (rolldown's native Rust parser) and edits with
`magic-string` — no Babel, no full re-print. It also works in `vite build`, `rolldown`, and
`rolldown-vite`. In Vitest/dev it resolves the `require()` specifier to an absolute on-disk
path (so Node's `require` finds the source); in a production `vite build` it preserves the
original specifier. Override with [`requireResolution`](#options).

### The `supply` marker

```ts
import { supply } from "vitest-needle-di-inject-optimiser/runtime";

class ReportService {
  constructor(private pdf = supply(PdfRenderer)) {}
}
```

`supply` is just `inject` at runtime, so this works with or without the plugin active.

## Writing tests

Override the natural way — against the class — and let the plugin line up the token:

```ts
import { Container } from "@needle-di/core";
import { ReportService } from "../src/report-service.js";
import { PdfRenderer } from "../src/pdf-renderer.js"; // used only as a bind() token → dropped

test("uses the mock and never loads the real PdfRenderer", () => {
  const container = new Container();
  container.bind({ provide: PdfRenderer, useValue: { render: () => "mock" } });
  container.bind(ReportService);

  expect(container.get(ReportService).pdf.render()).toBe("mock");
  // ./pdf-renderer was never imported or evaluated.
});
```

## Cross-file tracking (the project scan)

To know a dependency is `supply()`-ed *somewhere* (for bind-rewriting and the `inject()`
diagnostic), the plugin builds a project-wide set. Because Vitest transforms modules lazily,
there's no "all files seen" moment — so it does a **one-time filesystem scan** at startup:
glob source files under the Vite root, skip anything without `supply` in it, parse the rest
with oxc, collect the keys. On this repo that's **~8.6 ms total**; see
[Performance](#performance--why-not-a-native-wasm-plugin).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `needleModule` | `"@needle-di/core"` | Where `inject` / `InjectionToken` come from. |
| `supplyModule` | `"vitest-needle-di-inject-optimiser"` | Where the `supply` marker is imported from (matches `<value>` and `<value>/…`). |
| `rewriteSupply` | `true` | Rewrite the `supply(X)` argument to the lazy token form. |
| `rewriteBind` | `true` | Rewrite `provide:`/`provider:` in `bind`/`bindAll` to `Symbol.for(...)`, for supplied deps only. |
| `diagnoseInject` | `true` | Error on `inject(X)` when `X` is supplied elsewhere. |
| `shouldOptimise` | PascalCase, non-`ALL_CAPS` | Which names are symbolisable (classes/tokens). |
| `tokenKey` | `info => info.importedName` | The `Symbol.for(...)` key (exported name; stable across files). |
| `resolveRequireSpecifier` | identity | Map a dep specifier to the `require(...)` string. |

Vite plugin also: `include` (`/\.[cm]?[jt]sx?$/`), `exclude` (`/node_modules/`),
`requireResolution` (`"absolute"` in test/dev, `"preserve"` in `vite build`), and `scanRoot`
(defaults to the Vite root).

## What gets transformed

- ✅ `supply(Class)` → lazy `InjectionToken` + `require()` (imported classes).
- ✅ `supply(Token)` → `supply(Symbol.for("Token"))` (local exported `InjectionToken`s).
- ✅ `container.bind({ provide: X })` / `provider:` / `bindAll` → `Symbol.for("X")` — **only**
  for `supply()`-ed deps.
- ✅ Adds the `InjectionToken` value import; drops a dependency's import once it's no longer a
  value reference (or downgrades to `import { type X }` when only types remain).
- 🚫 `inject(X)` is never rewritten — but it errors at build time if `X` is supplied elsewhere.
- 🚫 `container.get(X)` is never touched.

## Performance — why not a native (WASM) plugin?

The transform uses **oxc** (native Rust parser, via N-API) + `magic-string`, **no Babel**. On
a 3.8 KB module with 48 calls: parse ≈ 0.08 ms, full transform ≈ 0.55 ms/file. The project
scan adds ≈ 0.34 ms per file that contains `supply` (others are skipped by a string gate) —
this whole repo scans in ~8.6 ms. A rolldown/rollup **`transform` hook filter** (evaluated in
Rust) keeps files that import neither needle-di nor this package out of the JS hot path entirely.

**Can't it be a real rolldown native (Rust/WASM) plugin?** Not usefully today: rolldown's
"native plugins" are Rust built-ins shipped *inside* rolldown (alias, resolve, replace, the oxc
transform); there's no public API to register your own arbitrary Rust/WASM transform (the
`rolldown_plugin_wasm_*` crates are for *importing `.wasm` modules*, not authoring plugins). For
custom logic the extension point is a JS plugin, and the cost there is the parse — which oxc
already does at native speed. A hand-written N-API addon would only shave the tiny JS-side walk
while forcing per-platform binaries, and rolldown would still see a JS plugin wrapper.

## Caveats

- **Named imports only.** Default/namespace imports are skipped (the `Symbol.for` key is the
  *exported* name, the one identifier prod and test can both compute). Aliases are fine.
- **Tokens vs classes.** `shouldOptimise` defaults to PascalCase, so `supply(MY_TOKEN)` /
  `supply(someToken)` are ignored. An **exported `InjectionToken` that is `supply()`-ed must
  not pass a factory** (2nd ctor arg) — references become a plain `Symbol.for(...)`, so the
  factory could never run; the plugin throws a build error pointing at it.
- **needle-di stays one instance.** Vitest externalises `node_modules`, so the lazily
  `require()`d module shares the same `@needle-di/core` as your test (injection context works
  across the boundary).
- **Node ≥ 22.18 for the Vitest path.** The lazily-`require()`d module is your TypeScript
  source, which relies on Node's native type stripping. Production builds (compiled `.js`) don't.
- **Scan scope is the Vite root.** Dependencies `supply()`-ed outside the root aren't tracked;
  set `scanRoot` for unusual layouts.

## Consuming the release tarball

```bash
pnpm add -D https://github.com/WjcmeAFJb/vitest-needle-di-inject-optimiser/releases/download/v0.5.0/vitest-needle-di-inject-optimiser-0.5.0.tgz
pnpm add @needle-di/core
```

## Development

```bash
pnpm install
pnpm build      # tsup -> dist (ESM + CJS + d.ts): index, vite, runtime
pnpm test       # builds, then runs vitest (unit + integration)
pnpm typecheck
```

## License

[MIT](./LICENSE)
