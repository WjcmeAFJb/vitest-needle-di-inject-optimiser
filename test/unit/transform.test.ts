import { describe, expect, it } from "vitest";
import { transform, supplyKeys, norm, SUPPLY_IMPORT } from "./helper.js";

describe("supply() rewrite", () => {
  it("rewrites supply(Class) to the lazy InjectionToken form and adjusts imports", () => {
    const out = transform(
      `${SUPPLY_IMPORT}
       import { Dependency } from './subpath';
       class Parent { constructor(private dep = supply(Dependency)) {} }`,
    );
    const n = norm(out);
    // callee stays `supply` (runtime-equivalent to inject); the argument is rewritten
    expect(n).toContain(`supply(new InjectionToken(Symbol.for("Dependency"), {`);
    expect(n).toContain(`container.get(Symbol.for("Dependency"), { optional: true })`);
    expect(n).toContain(
      `?? container.bind({ provide: Symbol.for("Dependency"), useClass: require("./subpath").Dependency }).get(Symbol.for("Dependency"))`,
    );
    // InjectionToken value import is added from needle
    expect(n).toMatch(/import\s*{\s*InjectionToken\s*}\s*from\s*['"]@needle-di\/core['"]/);
    // the dependency import is dropped; the supply import is kept
    expect(out).not.toMatch(/import\s*{\s*Dependency\s*}\s*from\s*['"]\.\/subpath['"]/);
    expect(out).toMatch(/import\s*{\s*supply\s*}\s*from/);
    expect(out).toContain("private dep =");
  });

  it("uses the exported name (not the alias) for key and require member", () => {
    const out = transform(
      `${SUPPLY_IMPORT}
       import { Dependency as Dep } from './subpath';
       const a = supply(Dep);`,
    );
    expect(out).toContain(`Symbol.for("Dependency")`);
    expect(out).toContain(`require("./subpath").Dependency`);
  });

  it("rewrites supply(LocalToken) to supply(Symbol.for(...)) and keeps the declaration", () => {
    const out = transform(
      `${SUPPLY_IMPORT}
       import { InjectionToken } from '@needle-di/core';
       export const Name = new InjectionToken("Name");
       class P { constructor(private x = supply(Name)) {} }`,
    );
    expect(out).toContain(`supply(Symbol.for("Name"))`);
    expect(out).toContain(`new InjectionToken("Name")`);
  });

  it("leaves supply() of a non-class token (ALL_CAPS) untouched", () => {
    const out = transform(
      `${SUPPLY_IMPORT}
       import { InjectionToken } from '@needle-di/core';
       export const API_TOKEN = new InjectionToken("API_TOKEN");
       const a = supply(API_TOKEN);`,
      ["API_TOKEN"],
    );
    expect(out).toContain("supply(API_TOKEN)");
    expect(out).not.toContain("Symbol.for");
  });
});

describe("inject() is left alone unless supplied", () => {
  it("does not touch inject(Dependency) when it is not supplied anywhere", () => {
    const input = `import { inject } from '@needle-di/core';
       import { Dependency } from './subpath';
       const a = inject(Dependency);`;
    expect(norm(transform(input, []))).toBe(norm(input));
  });

  it("errors on inject(Dependency) when Dependency is supplied elsewhere", () => {
    expect(() =>
      transform(
        `import { inject } from '@needle-di/core';
         import { Dependency } from './subpath';
         const a = inject(Dependency);`,
        ["Dependency"],
      ),
    ).toThrow(/supply\(Dependency\)/);
  });
});

describe("container.bind() rewrite is gated on the supply set", () => {
  const code = `import { Container } from '@needle-di/core';
     import { Dependency } from './subpath';
     export function setup(c: Container) { c.bind({ provide: Dependency, useValue: 1 }); }`;

  it("leaves bind({ provide }) untouched when the dep is not supplied", () => {
    const out = transform(code, []);
    expect(out).toContain("provide: Dependency");
    expect(out).not.toContain("Symbol.for");
    expect(out).toMatch(/import\s*{\s*Dependency\s*}\s*from/);
  });

  it("rewrites bind({ provide }) and drops the import when the dep is supplied", () => {
    const out = transform(code, ["Dependency"]);
    expect(out).toContain(`provide: Symbol.for("Dependency")`);
    expect(out).not.toMatch(/import\s*{\s*Dependency\s*}\s*from\s*['"]\.\/subpath['"]/);
  });

  it("rewrites bindAll and supports provider: spelling (when supplied)", () => {
    const out = transform(
      `import { Container } from '@needle-di/core';
       import { Alpha } from './a';
       import { Beta } from './b';
       export function s(c: Container) { c.bindAll({ provider: Alpha, useValue: 1 }, { provide: Beta, useValue: 2 }); }`,
      ["Alpha", "Beta"],
    );
    expect(out).toContain(`provider: Symbol.for("Alpha")`);
    expect(out).toContain(`provide: Symbol.for("Beta")`);
  });

  it("does not touch container.get / Function.prototype.bind", () => {
    const out = transform(
      `import { Container } from '@needle-di/core';
       import { Dependency } from './subpath';
       export function s(c: Container) {
         const x = c.get(Dependency);
         const f = (function(){}).bind(this);
       }`,
      ["Dependency"],
    );
    expect(out).toContain("c.get(Dependency)");
    expect(out).toContain(".bind(this)");
    expect(out).toMatch(/import\s*{\s*Dependency\s*}\s*from/);
  });
});

describe("collectSupplyKeys", () => {
  it("collects keys from supply() calls (exported names), ignoring non-class tokens", () => {
    const keys = supplyKeys(
      `${SUPPLY_IMPORT}
       import { Dependency as Dep } from './subpath';
       import { InjectionToken } from '@needle-di/core';
       export const Tok = new InjectionToken("Tok");
       export const API_TOKEN = new InjectionToken("API_TOKEN");
       const a = supply(Dep);
       const b = supply(Tok);
       const c = supply(API_TOKEN);`,
    );
    expect([...keys].sort()).toEqual(["Dependency", "Tok"]);
  });

  it("returns nothing for a file that doesn't import supply", () => {
    const keys = supplyKeys(
      `import { inject } from '@needle-di/core';
       import { Dependency } from './subpath';
       const a = inject(Dependency);`,
    );
    expect(keys.size).toBe(0);
  });
});

describe("build-time assertion", () => {
  it("throws when a supplied InjectionToken carries a factory", () => {
    expect(() =>
      transform(
        `${SUPPLY_IMPORT}
         import { InjectionToken } from '@needle-di/core';
         export const Name = new InjectionToken("Name", { factory: () => 1 });
         const a = supply(Name);`,
        ["Name"],
      ),
    ).toThrow(/second constructor argument/);
  });

  it("does not assert on a token that is not supplied", () => {
    const out = transform(
      `${SUPPLY_IMPORT}
       import { InjectionToken } from '@needle-di/core';
       export const Name = new InjectionToken("Name", { factory: () => 1 });
       export class Thing {}`,
      [],
    );
    // no supply()/bind/inject of Name → file unchanged
    expect(out).toContain('new InjectionToken("Name", { factory: () => 1 })');
  });
});
