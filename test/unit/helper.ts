import babel from "@babel/core";
import { createNeedleDiBabelPlugin } from "../../src/babel-plugin.js";
import type { NeedleDiOptimiserOptions } from "../../src/options.js";

export function transform(
  code: string,
  options: NeedleDiOptimiserOptions = {},
  filename = "input.ts",
): string {
  const result = babel.transformSync(code, {
    configFile: false,
    babelrc: false,
    filename,
    parserOpts: { plugins: ["typescript", ["decorators", { version: "2023-05" }]] },
    plugins: [[createNeedleDiBabelPlugin, options]],
  });
  if (!result?.code) throw new Error("transform produced no output");
  return result.code;
}

/** Collapse insignificant whitespace for stable structural comparisons. */
export function norm(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}
