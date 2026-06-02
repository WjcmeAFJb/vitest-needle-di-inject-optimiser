import fs from "node:fs";
import path from "node:path";

const EXT_CANDIDATES = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const INDEX_CANDIDATES = [
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.cts",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
];

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a *relative* import specifier to an absolute on-disk path so that the
 * Node `require` used by Vitest can find the real source file (Vitest authors
 * source with `.js`/extension-less specifiers that only Vite, not Node, remaps).
 *
 * Bare (`node_modules`) specifiers are returned unchanged: Node resolves them the
 * same way Vitest externalises them, so they share a single module instance.
 */
export function resolveSourceSpecifierSync(specifier: string, importerFilename: string | undefined): string {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return specifier; // bare
  if (!importerFilename) return specifier;

  const abs = path.resolve(path.dirname(importerFilename), specifier);

  const candidates: string[] = [];
  const jsExt = abs.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsExt) {
    // TS ESM convention: `./x.js` on disk is `./x.ts`. Prefer the real file, then TS twins.
    const noExt = abs.slice(0, -jsExt[0].length);
    candidates.push(abs, `${noExt}.ts`, `${noExt}.tsx`, `${noExt}.mts`, `${noExt}.cts`);
  } else {
    for (const ext of EXT_CANDIDATES) candidates.push(abs + ext);
  }
  for (const c of candidates) if (isFile(c)) return c;

  for (const idx of INDEX_CANDIDATES) {
    const c = path.join(abs, idx);
    if (isFile(c)) return c;
  }

  return specifier; // give up — keep the original specifier
}
