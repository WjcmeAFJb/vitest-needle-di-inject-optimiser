import { defineConfig } from "vitest/config";
// Use the built artifact so the integration tests exercise the real published plugin.
import { needleDiInjectOptimiser } from "./dist/vite.js";

export default defineConfig({
  plugins: [
    needleDiInjectOptimiser({
      // Only rewrite the fixtures (production-style code) and the integration test
      // files (which contain the container.bind overrides). Unit tests call Babel
      // directly and must not be pre-transformed.
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
