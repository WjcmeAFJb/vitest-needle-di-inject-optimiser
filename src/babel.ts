// Entry point for Babel: `plugins: ["vitest-needle-di-inject-optimiser/babel"]`.
// Babel expects the module's default export to be the plugin factory `(api, options) => PluginObj`.
export { createNeedleDiBabelPlugin as default, createNeedleDiBabelPlugin } from "./babel-plugin.js";
export type { NeedleDiOptimiserOptions, DependencyInfo } from "./options.js";
export { looksLikeClass } from "./options.js";
