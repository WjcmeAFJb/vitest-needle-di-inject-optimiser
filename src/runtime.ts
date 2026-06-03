// Runtime marker. `supply(token)` is an alias for needle-di's `inject(token)`, so
// your code works identically with or without the plugin. When the plugin is
// active, it rewrites `supply(Dependency)` into the lazy `Symbol.for(...)` form.
//
//   import { supply } from "vitest-needle-di-inject-optimiser/runtime";
//   class Foo { constructor(private dep = supply(HeavyService)) {} }
export { inject as supply } from "@needle-di/core";
