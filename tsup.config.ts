import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    babel: "src/babel.ts",
    vite: "src/vite.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  splitting: false,
  // These are provided by the host; never bundle them in.
  external: ["@babel/core", "@babel/types", "vite", "vitest"],
});
