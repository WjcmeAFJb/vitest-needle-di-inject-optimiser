import babel from "@babel/core";
import { createNeedleDiBabelPlugin } from "../../src/babel-plugin.js";
import { transformNeedleDi } from "../../src/oxc-transform.js";
import type { NeedleDiOptimiserOptions } from "../../src/options.js";

export type TransformFn = (code: string, options?: NeedleDiOptimiserOptions, filename?: string) => string;

export const transformBabel: TransformFn = (code, options = {}, filename = "input.ts") => {
  const result = babel.transformSync(code, {
    configFile: false,
    babelrc: false,
    filename,
    parserOpts: { plugins: ["typescript", ["decorators", { version: "2023-05" }]] },
    plugins: [[createNeedleDiBabelPlugin, options]],
  });
  if (!result?.code) throw new Error("transform produced no output");
  return result.code;
};

export const transformOxc: TransformFn = (code, options = {}, filename = "input.ts") => {
  // The oxc transform returns null when there is nothing to do; in that case the
  // input is unchanged.
  return transformNeedleDi(code, filename, options)?.code ?? code;
};

export const transforms: Array<[name: string, fn: TransformFn]> = [
  ["babel", transformBabel],
  ["oxc", transformOxc],
];

/** Collapse insignificant whitespace for stable structural comparisons. */
export function norm(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}
