import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    vite: "src/vite.ts",
    runtime: "src/runtime.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  splitting: false,
  // Provided by the host or are runtime deps; never bundle them in.
  external: ["vite", "vitest", "oxc-parser", "magic-string", "@needle-di/core"],
});
