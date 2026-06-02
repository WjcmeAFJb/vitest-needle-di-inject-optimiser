# vitest-needle-di-inject-optimiser

A **Babel plugin** and a **Vite / Vitest / Rolldown plugin** that rewrite
[`@needle-di/core`](https://needle-di.io) `inject()` and `container.bind()` usage so that
dependencies are loaded **lazily, via `require()` on demand** instead of through an eager
static `import`.

The payoff: in your tests you can override a dependency with `container.bind(...)` and the
**real dependency's module is never loaded** — its import-time and constructor side effects
never run.

```ts
// You write:
import { inject } from "@needle-di/core";
import { Dependency } from "./subpath";

class Parent {
  constructor(private dep = inject(Dependency)) {}
}
```

```ts
// The plugin produces:
import { inject, InjectionToken } from "@needle-di/core";
// (the `./subpath` import is dropped — it is no longer referenced as a value)

class Parent {
  constructor(
    private dep = inject(
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

And on the test/binding side:

```ts
// You write:
container.bind({ provide: Dependency, useValue: fakeDep });
// The plugin produces:
container.bind({ provide: Symbol.for("Dependency"), useValue: fakeDep });
```

## Why this works

`Symbol.for("Dependency")` is a key in the **global symbol registry**, so the symbol is the
*same* object in every module — production code and test code agree on it without sharing an
import. That symbol becomes the real DI token:

- **Production / no override** — the `InjectionToken` factory asks the container for
  `Symbol.for("Dependency")`. Nothing is bound, so it lazily `require()`s the real class,
  binds it, and returns it. The module is loaded **only on first use**.
- **Test / override** — your test binds a mock to `Symbol.for("Dependency")` *before*
  resolving. The factory finds it via `container.get(..., { optional: true })` and returns
  the mock — the `require()` is **never reached**, so the real module is never evaluated.

> ℹ️ The `{ optional: true }` is required: needle-di's `container.get()` **throws** when a
> token is unbound, so the `??` fallback only works with the optional overload.

## Install

```bash
pnpm add -D vitest-needle-di-inject-optimiser
```

This package is distributed as a tarball on GitHub Releases (see
[Consuming the release tarball](#consuming-the-release-tarball)).

## Usage

### Vite / Vitest / Rolldown

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import needleDiInjectOptimiser from "vitest-needle-di-inject-optimiser/vite";

export default defineConfig({
  plugins: [needleDiInjectOptimiser()],
});
```

The Vite/Vitest/Rolldown plugin is **not** Babel-based. It parses with
[**oxc**](https://oxc.rs) — the native Rust parser that rolldown itself uses — and rewrites
only the touched ranges with [`magic-string`](https://github.com/Rich-Harris/magic-string).
There's no full re-print: your TypeScript is preserved byte-for-byte except where `inject()` /
`bind()` are edited, and type stripping is left to the host pipeline. See
[Performance](#performance--why-not-a-native-wasm-plugin) for the why and the numbers.

It runs with `enforce: "pre"` and is a standard Rollup-compatible plugin, so it also works in
`vite build`, `rolldown`, and `rolldown-vite`.

In **Vitest / dev** it resolves the `require()` specifier to an absolute on-disk path so
Node's `require` (which Vitest provides) can find your TypeScript source. In a production
`vite build` it automatically switches to preserving the original specifier (so no absolute
paths leak into your bundle). Override with the [`requireResolution`](#options) option.

### Babel

```jsonc
// babel.config.json — for a production (CommonJS) build
{
  "plugins": ["vitest-needle-di-inject-optimiser/babel"]
}
```

The Babel plugin emits the original specifier verbatim (`require("./subpath")`), which is
correct for a CommonJS build or any bundler that understands `require`.

## Writing tests

Write the override the natural way — against the class — and let the plugin line the token up
with production:

```ts
import { Container } from "@needle-di/core";
import { Parent } from "../src/parent.js";
import { Dependency } from "../src/subpath.js"; // used only as a bind() token → dropped by the plugin

test("uses the mock and never runs the real dependency", () => {
  const container = new Container();
  container.bind({ provide: Dependency, useValue: { doThing: () => "mock" } });
  container.bind(Parent);

  const parent = container.get(Parent);
  expect(parent.dep.doThing()).toBe("mock");
  // The real ./subpath module was never imported or evaluated.
});
```

## Options

Both plugins accept the same core options (the Vite plugin adds a few more):

| Option | Default | Description |
| --- | --- | --- |
| `needleModule` | `"@needle-di/core"` | Module specifier that `inject` / `InjectionToken` come from. |
| `rewriteInject` | `true` | Rewrite `inject(Class)` into the lazy `InjectionToken` form. |
| `rewriteBind` | `true` | Rewrite `provide:`/`provider:` class tokens in `bind`/`bindAll` to `Symbol.for(...)`. |
| `shouldOptimise` | PascalCase, non-`ALL_CAPS` | Predicate deciding whether a named import is a lazy class dependency. |
| `tokenKey` | `info => info.importedName` | The `Symbol.for(...)` key. Defaults to the **exported** name (stable across files). |
| `resolveRequireSpecifier` | identity | Map a dependency specifier to the string used inside `require(...)`. |

Vite plugin only:

| Option | Default | Description |
| --- | --- | --- |
| `include` | `/\.[cm]?[jt]sx?$/` | Files to process. |
| `exclude` | `/node_modules/` | Files to skip. |
| `requireResolution` | auto (`"absolute"` in test/dev, `"preserve"` in `vite build`) | How to resolve the `require(...)` specifier. |

## What gets transformed

- ✅ `inject(Class)` where `Class` is a **named import** that looks like a class.
- ✅ `container.bind({ provide: Class, ... })`, `provider:`, and `container.bindAll(...)`.
- ✅ `inject(Token)` / `provide: Token` where `Token` is a **local, exported**
  `const Token = new InjectionToken(...)` declared in the same file — see
  [Local injection tokens](#local-injection-tokens).
- ✅ Adds `InjectionToken` as a value import (converting a type-only import if needed).
- ✅ Drops the dependency's import when it is no longer referenced as a value, or downgrades
  it to `import { type Dependency }` when only type references remain.

## Local injection tokens

A very common needle-di pattern is to declare a token next to where it's injected and
override it from elsewhere:

```ts
// service.ts
export const ApiBaseUrl = new InjectionToken<string>("ApiBaseUrl");

class ApiClient {
  constructor(private baseUrl = inject(ApiBaseUrl)) {}
}
```

```ts
// some.test.ts
import { ApiBaseUrl } from "./service.js";
container.bind({ provide: ApiBaseUrl, useValue: "http://localhost" });
```

Because the test rewrites `provide: ApiBaseUrl` → `provide: Symbol.for("ApiBaseUrl")`, the
`inject(ApiBaseUrl)` in `service.ts` must use the **same** symbol. So the plugin also rewrites
`inject(ApiBaseUrl)` (and `provide: ApiBaseUrl`) in the *defining* file to
`Symbol.for("ApiBaseUrl")`, keyed on the **exported** name. The
`export const ApiBaseUrl = new InjectionToken(...)` declaration is left in place.

> Build-time assertion: because every reference becomes a plain `Symbol.for(...)`, an
> **exported** `InjectionToken` that the plugin rewrites **must not pass a factory** (a second
> constructor argument) — that factory could never run. The plugin throws a build error
> pointing at the offending token. (Non-exported tokens, and tokens whose name isn't class-like
> per `shouldOptimise`, are left untouched and may keep a factory.)

## Performance — why not a native (WASM) plugin?

The Vite/Vitest path uses **oxc** (native Rust parser, via N-API) + `magic-string`, **no
Babel**. On a 4.4 KB module with 48 `inject()` calls:

| Transform | per file | relative |
| --- | --- | --- |
| `@babel/core` + plugin | ~6.5 ms | 1× |
| **oxc + magic-string** | **~0.7 ms** | **~9× faster** |

On top of that, the plugin declares a rolldown/rollup **`transform` hook filter**
(`{ filter: { code: /@needle-di\/core/ } }`). That filter is evaluated **in Rust**, so files
that don't import needle-di never cross the Rust→JS boundary at all — most of your codebase is
never even handed to the plugin.

**Can't it be a *real* rolldown native (Rust/WASM) plugin?** Not usefully, today:

- Rolldown's "native plugins" are **Rust built-ins shipped inside rolldown** (alias, resolve,
  replace, the oxc transform). There is **no public API to register your own arbitrary
  Rust/WASM transform** as a rolldown plugin. (The `rolldown_plugin_wasm_*` crates are for
  *importing `.wasm` modules*, not for authoring plugins in WASM.)
- For custom logic, the supported extension point is a **JS plugin**. The cost there is the
  *parse*, and oxc already does the parse at native speed (it's the same parser rolldown uses
  internally). A hand-written Rust/N-API addon would only shave the tiny JS-side walk while
  forcing you to ship and maintain per-platform binaries — and rolldown would *still* see a JS
  plugin wrapper. So oxc + a Rust-side hook filter captures essentially all of the win.

## Caveats & design notes

- **Named imports only.** Default and namespace imports are skipped, because the
  `Symbol.for(...)` key is derived from the *exported* name (the one stable identifier that
  production and test code can both compute). Aliases are fine:
  `import { Dependency as Dep }` still keys on `"Dependency"`.
- **Tokens are not optimised.** The default `shouldOptimise` only targets PascalCase names,
  so `inject(MY_TOKEN)` / `inject(someToken)` (symbols, `InjectionToken` instances) keep
  their identity. Customise via `shouldOptimise` if your classes are named differently.
- **needle-di stays a single instance.** Vitest externalises `node_modules`, so the lazily
  `require()`d module shares the *same* `@needle-di/core` instance as your test — the
  injection context works across the boundary, and lazily-loaded services can themselves use
  `inject()`.
- **Production uses real `require`.** The lazy form relies on synchronous `require`, which is
  native in CommonJS and supported by bundlers. For an ESM-only production target, bundle
  with a tool that lowers `require` (Rollup/Rolldown/webpack/esbuild) or emit CJS.
- **Node ≥ 22.18 for the Vitest path.** In Vitest the lazily-`require()`d module is your
  **TypeScript source**, so it relies on Node's native type stripping (Node ≥ 22.18). On
  older Node, `require()` cannot load a `.ts` file. Production builds (compiled `.js`) have no
  such requirement.

## Consuming the release tarball

Each GitHub Release attaches a pnpm-installable tarball:

```bash
pnpm add -D https://github.com/WjcmeAFJb/vitest-needle-di-inject-optimiser/releases/download/v0.3.0/vitest-needle-di-inject-optimiser-0.3.0.tgz
```

You can also pin it in `package.json`:

```jsonc
{
  "devDependencies": {
    "vitest-needle-di-inject-optimiser": "https://github.com/WjcmeAFJb/vitest-needle-di-inject-optimiser/releases/download/v0.3.0/vitest-needle-di-inject-optimiser-0.3.0.tgz"
  }
}
```

## Development

```bash
pnpm install
pnpm build      # tsup -> dist (ESM + CJS + d.ts)
pnpm test       # builds, then runs vitest (unit + integration)
pnpm typecheck
```

## License

[MIT](./LICENSE)
