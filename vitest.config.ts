import { defineConfig } from "vitest/config";
// Use the built artifact so the integration tests exercise the real published plugin.
import { needleDiInjectOptimiser } from "./dist/vite.js";

export default defineConfig({
  plugins: [
    needleDiInjectOptimiser({
      // Scan + rewrite only the fixtures (production-style code, where supply() lives)
      // and the integration test files (which contain the container.bind overrides).
      // Unit tests call the transform directly and must not be pre-processed.
      include: [/[\\/]test[\\/]fixtures[\\/]/, /[\\/]test[\\/]integration[\\/]/],
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    experimental: {
      fsModuleCache: true
    }
  },
  server: {
    allowedHosts: true
  }
});
