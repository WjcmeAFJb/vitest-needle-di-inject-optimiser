import { describe, expect, it } from "vitest";
import { transforms, norm, type TransformFn } from "./helper.js";

// Run the identical assertions against BOTH the Babel plugin and the oxc transform
// to guarantee the two implementations stay in lock-step.
describe.each(transforms)("%s transform", (_name, transform: TransformFn) => {
  describe("inject() rewrite", () => {
    it("matches the documented spec example", () => {
      const out = transform(
        `import { inject } from '@needle-di/core';
         import { Dependency } from './subpath';
         class Parent {
           constructor(private dep = inject(Dependency)) { }
         }`,
      );
      const n = norm(out);
      expect(n).toContain(`import { inject, InjectionToken } from '@needle-di/core'`);
      expect(n).toContain(`new InjectionToken(Symbol.for("Dependency"), {`);
      // Babel prints `container =>`, oxc prints `(container) =>` — both valid.
      expect(n).toMatch(/factory:\s*\(?container\)?\s*=>/);
      expect(n).toContain(`container.get(Symbol.for("Dependency"), { optional: true })`);
      expect(n).toContain(
        `?? container.bind({ provide: Symbol.for("Dependency"), useClass: require("./subpath").Dependency }).get(Symbol.for("Dependency"))`,
      );
      expect(out).not.toMatch(/import\s*{\s*Dependency\s*}\s*from\s*['"]\.\/subpath['"]/);
      expect(out).toContain("private dep =");
    });

    it("reuses an existing InjectionToken value import", () => {
      const out = transform(
        `import { inject, InjectionToken } from '@needle-di/core';
         import { Dependency } from './subpath';
         const t = inject(Dependency);`,
      );
      expect(norm(out)).toContain("import { inject, InjectionToken } from '@needle-di/core'");
      expect(out.split("InjectionToken }").length).toBe(2); // appears once in the import
    });

    it("upgrades a type-only InjectionToken import to a value import", () => {
      const out = transform(
        `import { inject, type InjectionToken } from '@needle-di/core';
         import { Dependency } from './subpath';
         const t = inject(Dependency);`,
      );
      expect(out).toContain("new InjectionToken(");
      expect(out).not.toMatch(/type\s+InjectionToken/);
    });

    it("adds an InjectionToken import when imported via `import type {}`", () => {
      const out = transform(
        `import { inject } from '@needle-di/core';
         import type { InjectionToken } from '@needle-di/core';
         import { Dependency } from './subpath';
         const t = inject(Dependency);`,
      );
      expect(out).toContain("new InjectionToken(");
      expect(out).not.toMatch(/import\s+type\s*{\s*InjectionToken\s*}/);
    });

    it("keeps the import when the dependency is still used as a value elsewhere", () => {
      const out = transform(
        `import { inject } from '@needle-di/core';
         import { Dependency } from './subpath';
         const a = inject(Dependency);
         const b = new Dependency();`,
      );
      expect(out).toMatch(/import\s*{\s*Dependency\s*}\s*from\s*['"]\.\/subpath['"]/);
      expect(out).toContain("new Dependency()");
      expect(out).toContain("new InjectionToken(");
    });

    it("downgrades to a type-only import when only types remain", () => {
      const out = transform(
        `import { inject } from '@needle-di/core';
         import { Dependency } from './subpath';
         let x: Dependency;
         const a = inject(Dependency);
         function f(): Dependency { return a; }`,
      );
      expect(out).toMatch(/import\s*{\s*type\s+Dependency\s*}\s*from\s*['"]\.\/subpath['"]/);
      expect(out).toContain("new InjectionToken(");
    });

    it("uses the exported name (not the alias) for key and require member", () => {
      const out = transform(
        `import { inject } from '@needle-di/core';
         import { Dependency as Dep } from './subpath';
         const a = inject(Dep);`,
      );
      expect(out).toContain(`Symbol.for("Dependency")`);
      expect(out).toContain(`require("./subpath").Dependency`);
      expect(out).not.toContain('Symbol.for("Dep")');
    });

    it("does not transform non-class tokens (ALL_CAPS / lowercase)", () => {
      const out = transform(
        `import { inject } from '@needle-di/core';
         import { API_URL } from './config';
         import { logger } from './log';
         const a = inject(API_URL);
         const b = inject(logger);`,
      );
      expect(out).not.toContain("InjectionToken");
      expect(out).toContain("inject(API_URL)");
      expect(out).toContain("inject(logger)");
    });

    it("does not transform locally-defined classes (no import to lazify)", () => {
      const out = transform(
        `import { inject } from '@needle-di/core';
         class Local {}
         const a = inject(Local);`,
      );
      expect(out).not.toContain("InjectionToken");
      expect(out).toContain("inject(Local)");
    });
  });

  describe("container.bind() rewrite", () => {
    it("rewrites provide: Class to Symbol.for and drops the import", () => {
      const out = transform(
        `import { Container } from '@needle-di/core';
         import { Dependency } from './subpath';
         export function setup(c: Container) {
           c.bind({ provide: Dependency, useValue: { hi: () => 1 } });
         }`,
      );
      expect(out).toContain(`provide: Symbol.for("Dependency")`);
      expect(out).toContain("useValue:");
      expect(out).not.toMatch(/import\s*{\s*Dependency\s*}\s*from\s*['"]\.\/subpath['"]/);
    });

    it("supports the `provider:` key spelling", () => {
      const out = transform(
        `import { Container } from '@needle-di/core';
         import { Dependency } from './subpath';
         export function setup(c: Container) {
           c.bind({ provider: Dependency, useValue: 1 });
         }`,
      );
      expect(out).toContain(`provider: Symbol.for("Dependency")`);
    });

    it("rewrites bindAll providers", () => {
      const out = transform(
        `import { Container } from '@needle-di/core';
         import { Alpha } from './a';
         import { Beta } from './b';
         export function setup(c: Container) {
           c.bindAll({ provide: Alpha, useValue: 1 }, { provide: Beta, useValue: 2 });
         }`,
      );
      expect(out).toContain(`provide: Symbol.for("Alpha")`);
      expect(out).toContain(`provide: Symbol.for("Beta")`);
    });

    it("keeps the import when the class is also used as useClass", () => {
      const out = transform(
        `import { Container } from '@needle-di/core';
         import { Dependency } from './subpath';
         export function setup(c: Container) {
           c.bind({ provide: Dependency, useClass: Dependency });
         }`,
      );
      expect(out).toContain(`provide: Symbol.for("Dependency")`);
      expect(out).toContain("useClass: Dependency");
      expect(out).toMatch(/import\s*{\s*Dependency\s*}\s*from/);
    });

    it("does not touch Function.prototype.bind or non-provider objects", () => {
      const out = transform(
        `import { inject } from '@needle-di/core';
         import { Dependency } from './subpath';
         const f = (function(){}).bind(this);
         const obj = { provide: Dependency };
         const a = inject(Dependency);`,
      );
      expect(norm(out)).toContain("{ provide: Dependency }");
      expect(out).toContain(".bind(this)");
      expect(out).toMatch(/import\s*{\s*Dependency\s*}\s*from/);
    });
  });

  describe("gating", () => {
    it("leaves files without a needle-di import untouched", () => {
      const input = `import { Dependency } from './subpath';
         const a = something(Dependency);`;
      expect(norm(transform(input))).toBe(norm(input));
    });

    it("removes only the transformed specifier from a multi-import", () => {
      const out = transform(
        `import { inject } from '@needle-di/core';
         import { Dependency, KEEP } from './subpath';
         const a = inject(Dependency);
         console.log(KEEP);`,
      );
      expect(out).toMatch(/import\s*{\s*KEEP\s*}\s*from\s*['"]\.\/subpath['"]/);
      expect(out).not.toContain("Dependency,");
      expect(out).toContain("new InjectionToken(");
    });
  });
});
