import { parseSync, type ParseResult } from "oxc-parser";
import MagicString from "magic-string";
import { type NeedleDiOptimiserOptions, resolveOptions } from "./options.js";

// We work against the oxc ESTree AST, which we treat structurally. Keep typing
// loose (the AST is plain JSON with `type`/`start`/`end` on every node).
/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

export interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
}

const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// TS nodes that wrap a *value* expression (their child stays a value reference).
const TS_VALUE_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSInstantiationExpression",
]);

function langFor(filename: string): "js" | "jsx" | "ts" | "tsx" {
  if (/\.tsx$/.test(filename)) return "tsx";
  if (/\.(ts|mts|cts)$/.test(filename)) return "ts";
  if (/\.jsx$/.test(filename)) return "jsx";
  return "jsx"; // .js/.mjs/.cjs — allow JSX as a superset
}

function symbolForSrc(key: string): string {
  return `Symbol.for(${JSON.stringify(key)})`;
}

function requireMemberSrc(source: string, member: string): string {
  const req = `require(${JSON.stringify(source)})`;
  return VALID_IDENT.test(member) ? `${req}.${member}` : `${req}[${JSON.stringify(member)}]`;
}

function lazyTokenSrc(injectionTokenLocal: string, key: string, source: string, member: string): string {
  const k = symbolForSrc(key);
  return (
    `new ${injectionTokenLocal}(${k}, { factory: (container) => ` +
    `container.get(${k}, { optional: true }) ?? ` +
    `container.bind({ provide: ${k}, useClass: ${requireMemberSrc(source, member)} }).get(${k}) })`
  );
}

function specifierImportedName(spec: Node): string {
  const im = spec.imported;
  return im.type === "Identifier" ? im.name : im.value; // Identifier | StringLiteral
}

function propKeyName(prop: Node): string | undefined {
  if (!prop.computed && prop.key?.type === "Identifier") return prop.key.name;
  if (prop.key?.type === "Literal" && typeof prop.key.value === "string") return prop.key.value;
  return undefined;
}

function memberPropName(node: Node): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.property?.type === "Literal" && typeof node.property.value === "string") return node.property.value;
  return undefined;
}

/** Generic depth-first walk that exposes the live ancestor chain (parents only). */
function walk(node: Node, visit: (n: Node, ancestors: Node[]) => void, ancestors: Node[] = []): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, ancestors);
  ancestors.push(node);
  for (const key in node) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === "object") walk(child, visit, ancestors);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      walk(value, visit, ancestors);
    }
  }
  ancestors.pop();
}

/** Collect names introduced by local bindings (used to skip shadowed dependencies). */
function collectBoundNames(program: Node): Set<string> {
  const names = new Set<string>();
  const addPattern = (p: Node): void => {
    if (!p || typeof p !== "object") return;
    switch (p.type) {
      case "Identifier":
        names.add(p.name);
        break;
      case "ObjectPattern":
        for (const prop of p.properties ?? []) addPattern(prop.type === "RestElement" ? prop.argument : prop.value);
        break;
      case "ArrayPattern":
        for (const el of p.elements ?? []) if (el) addPattern(el.type === "RestElement" ? el.argument : el);
        break;
      case "AssignmentPattern":
        addPattern(p.left);
        break;
      case "RestElement":
        addPattern(p.argument);
        break;
      case "TSParameterProperty":
        addPattern(p.parameter);
        break;
    }
  };
  walk(program, (n) => {
    switch (n.type) {
      case "VariableDeclarator":
        addPattern(n.id);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (n.id?.type === "Identifier") names.add(n.id.name);
        for (const param of n.params ?? []) addPattern(param);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (n.id?.type === "Identifier") names.add(n.id.name);
        break;
      case "CatchClause":
        if (n.param) addPattern(n.param);
        break;
    }
  });
  return names;
}

interface DepImport {
  localName: string;
  importedName: string;
  source: string;
  decl: Node;
  spec: Node;
  consumed: number;
  retainedValue: number;
  typeRefs: number;
}

interface NeedleInfo {
  injectLocal?: string;
  injectionTokenLocal?: string;
  injectionTokenSpec?: Node;
  injectionTokenDecl?: Node;
  injectionTokenIsType?: boolean;
  valueDecl?: Node; // a value import declaration we can append InjectionToken to
  imports: boolean;
}

/** Re-serialize an import declaration from a list of named specifier descriptors. */
function serializeImport(
  code: string,
  decl: Node,
  namedSpecs: Array<{ imported: string; local: string; type: boolean }>,
  extraNamed: Array<{ imported: string; local: string }> = [],
): string {
  const sourceText = code.slice(decl.source.start, decl.source.end); // preserve original quotes
  const parts: string[] = [];
  for (const spec of decl.specifiers ?? []) {
    if (spec.type === "ImportDefaultSpecifier") parts.push(spec.local.name);
    else if (spec.type === "ImportNamespaceSpecifier") parts.push(`* as ${spec.local.name}`);
  }
  const named = [
    ...namedSpecs.map((s) => `${s.type ? "type " : ""}${s.imported}${s.local !== s.imported ? ` as ${s.local}` : ""}`),
    ...extraNamed.map((s) => `${s.imported}${s.local !== s.imported ? ` as ${s.local}` : ""}`),
  ];
  if (named.length) parts.push(`{ ${named.join(", ")} }`);
  if (parts.length === 0) return ""; // caller removes the declaration entirely
  const kind = decl.importKind === "type" ? "type " : "";
  return `import ${kind}${parts.join(", ")} from ${sourceText};`;
}

function namedSpecsOf(decl: Node): Array<{ imported: string; local: string; type: boolean; spec: Node }> {
  return (decl.specifiers ?? [])
    .filter((s: Node) => s.type === "ImportSpecifier")
    .map((s: Node) => ({
      imported: specifierImportedName(s),
      local: s.local.name,
      type: s.importKind === "type",
      spec: s,
    }));
}

/**
 * Lazily rewrite needle-di `inject()` / `container.bind()` usage in a single file
 * using oxc (native parse) + magic-string (surgical edits). Returns `null` when
 * there is nothing to do (no needle-di import, or no eligible usage).
 */
export function transformNeedleDi(
  code: string,
  filename: string,
  rawOptions: NeedleDiOptimiserOptions = {},
): TransformResult | null {
  const options = resolveOptions(rawOptions);
  if (!code.includes(options.needleModule)) return null;

  let parsed: ParseResult;
  try {
    parsed = parseSync(filename, code, { sourceType: "module", lang: langFor(filename) });
  } catch {
    return null;
  }
  if (parsed.errors.length > 0) return null;
  const program = parsed.program as Node;

  // ---- 1. Collect needle + dependency imports -----------------------------
  const needle: NeedleInfo = { imports: false };
  const deps = new Map<string, DepImport>();

  for (const node of program.body) {
    if (node.type !== "ImportDeclaration") continue;
    const source = node.source.value as string;
    const declIsType = node.importKind === "type";

    if (source === options.needleModule) {
      needle.imports = true;
      for (const spec of node.specifiers ?? []) {
        if (spec.type !== "ImportSpecifier") continue;
        const imported = specifierImportedName(spec);
        const specIsType = declIsType || spec.importKind === "type";
        if (imported === "inject" && !specIsType) {
          needle.injectLocal = spec.local.name;
          if (!declIsType) needle.valueDecl = node;
        } else if (imported === "InjectionToken") {
          needle.injectionTokenLocal = spec.local.name;
          needle.injectionTokenSpec = spec;
          needle.injectionTokenDecl = node;
          needle.injectionTokenIsType = specIsType;
        }
      }
      if (!declIsType && !needle.valueDecl) needle.valueDecl = node;
      continue;
    }

    for (const spec of node.specifiers ?? []) {
      if (spec.type !== "ImportSpecifier") continue; // named imports only
      const localName = spec.local.name;
      deps.set(localName, {
        localName,
        importedName: specifierImportedName(spec),
        source,
        decl: node,
        spec,
        consumed: 0,
        retainedValue: 0,
        typeRefs: 0,
      });
    }
  }

  if (!needle.imports || deps.size === 0) return null;

  // Drop shadowed dependency names (conservative: don't optimise ambiguous ones).
  const bound = collectBoundNames(program);
  for (const [name, dep] of deps) {
    if (bound.has(name) || !options.shouldOptimise(dep)) deps.delete(name);
  }
  if (deps.size === 0) return null;

  // ---- 2. Classify references ---------------------------------------------
  interface Site {
    start: number;
    end: number;
    dep: DepImport;
  }
  const injectSites: Site[] = [];
  const provideSites: Site[] = [];

  walk(program, (node, ancestors) => {
    if (node.type !== "Identifier") return;
    const dep = deps.get(node.name);
    if (!dep) return;
    const parent = ancestors[ancestors.length - 1];
    if (!parent) return;

    // Skip binding / non-reference positions.
    if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier") return;
    if (parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) return;
    if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;

    // `typeof Dep` requires Dep to remain a value binding.
    if (parent.type === "TSTypeQuery") {
      dep.retainedValue++;
      return;
    }
    // Any other TS type position is an erasable type reference.
    if (typeof parent.type === "string" && parent.type.startsWith("TS") && !TS_VALUE_WRAPPERS.has(parent.type)) {
      dep.typeRefs++;
      return;
    }

    // inject(Dep)
    if (
      options.rewriteInject &&
      needle.injectLocal &&
      parent.type === "CallExpression" &&
      parent.callee?.type === "Identifier" &&
      parent.callee.name === needle.injectLocal &&
      parent.arguments?.[0] === node
    ) {
      dep.consumed++;
      injectSites.push({ start: node.start, end: node.end, dep });
      return;
    }

    // container.bind({ provide: Dep }) / provider: / bindAll
    if (options.rewriteBind && parent.type === "Property" && parent.value === node) {
      const key = propKeyName(parent);
      const objExpr = ancestors[ancestors.length - 2];
      const call = ancestors[ancestors.length - 3];
      if (
        (key === "provide" || key === "provider") &&
        objExpr?.type === "ObjectExpression" &&
        call?.type === "CallExpression" &&
        call.callee?.type === "MemberExpression" &&
        (memberPropName(call.callee) === "bind" || memberPropName(call.callee) === "bindAll") &&
        call.arguments?.includes(objExpr)
      ) {
        dep.consumed++;
        provideSites.push({ start: node.start, end: node.end, dep });
        return;
      }
    }

    dep.retainedValue++;
  });

  if (injectSites.length === 0 && provideSites.length === 0) return null;

  const ms = new MagicString(code);

  // ---- 3. Ensure InjectionToken is available as a value import ------------
  let injectionTokenLocal = needle.injectionTokenLocal;
  let injectionTokenReady = needle.injectionTokenLocal !== undefined && !needle.injectionTokenIsType;

  const ensureInjectionToken = (): string => {
    if (injectionTokenReady && injectionTokenLocal) return injectionTokenLocal;

    const valueDecl = needle.valueDecl;
    const itDecl = needle.injectionTokenDecl;

    // Choose the local name: reuse an existing (type) InjectionToken local, else a
    // non-colliding fresh name.
    let local: string;
    if (needle.injectionTokenLocal) {
      local = needle.injectionTokenLocal;
    } else {
      const taken = new Set<string>([...deps.keys(), ...bound]);
      if (needle.injectLocal) taken.add(needle.injectLocal);
      if (!taken.has("InjectionToken")) local = "InjectionToken";
      else {
        let i = 1;
        while (taken.has(`InjectionToken$${i}`)) i++;
        local = `InjectionToken$${i}`;
      }
    }

    // If a type-only InjectionToken lives in a DIFFERENT declaration, strip it there
    // (the same-declaration case is handled by reconstructing valueDecl below).
    if (needle.injectionTokenIsType && itDecl && itDecl !== valueDecl) {
      rewriteOrRemoveSpecifier(ms, code, itDecl, needle.injectionTokenSpec);
    }

    if (!valueDecl) {
      ms.prepend(
        `import { InjectionToken${local !== "InjectionToken" ? ` as ${local}` : ""} } from ${JSON.stringify(options.needleModule)};\n`,
      );
    } else {
      // Reconstruct valueDecl so InjectionToken is present exactly once, as a value.
      const named = namedSpecsOf(valueDecl).map((s) => ({ imported: s.imported, local: s.local, type: s.type }));
      const existing = named.find((s) => s.imported === "InjectionToken");
      if (existing) {
        existing.type = false;
        existing.local = local;
      }
      const extra = existing ? [] : [{ imported: "InjectionToken", local }];
      ms.overwrite(valueDecl.start, valueDecl.end, serializeImport(code, valueDecl, named, extra));
    }

    injectionTokenLocal = local;
    injectionTokenReady = true;
    return local;
  };

  // ---- 4. Apply edits -----------------------------------------------------
  for (const site of injectSites) {
    const local = ensureInjectionToken();
    ms.overwrite(
      site.start,
      site.end,
      lazyTokenSrc(
        local,
        options.tokenKey(site.dep),
        options.resolveRequireSpecifier(site.dep.source, filename),
        site.dep.importedName,
      ),
    );
  }
  for (const site of provideSites) {
    ms.overwrite(site.start, site.end, symbolForSrc(options.tokenKey(site.dep)));
  }

  // ---- 5. Remove / downgrade now-unused dependency imports ----------------
  const declsToRewrite = new Set<Node>();
  for (const dep of deps.values()) {
    if (dep.consumed === 0 || dep.retainedValue > 0) continue;
    declsToRewrite.add(dep.decl);
  }
  for (const decl of declsToRewrite) {
    const depsOnDecl = [...deps.values()].filter((d) => d.decl === decl && d.consumed > 0 && d.retainedValue === 0);
    const named = namedSpecsOf(decl).flatMap((s) => {
      const dep = depsOnDecl.find((d) => d.spec === s.spec);
      if (!dep) return [{ imported: s.imported, local: s.local, type: s.type }];
      if (dep.typeRefs > 0) return [{ imported: s.imported, local: s.local, type: true }]; // downgrade
      return []; // drop
    });
    const hasOther = (decl.specifiers ?? []).some(
      (s: Node) => s.type === "ImportDefaultSpecifier" || s.type === "ImportNamespaceSpecifier",
    );
    if (named.length === 0 && !hasOther) {
      removeDeclaration(ms, code, decl);
    } else {
      ms.overwrite(decl.start, decl.end, serializeImport(code, decl, named));
    }
  }

  return { code: ms.toString(), map: ms.generateMap({ source: filename, includeContent: true, hires: true }) };
}

/** Remove an import declaration plus a single trailing newline, if present. */
function removeDeclaration(ms: MagicString, code: string, decl: Node): void {
  let end = decl.end;
  if (code[end] === "\r") end++;
  if (code[end] === "\n") end++;
  ms.remove(decl.start, end);
}

/** Remove a single named specifier from a declaration (or the whole decl if it empties). */
function rewriteOrRemoveSpecifier(ms: MagicString, code: string, decl: Node, spec: Node): void {
  const remaining = namedSpecsOf(decl)
    .filter((s) => s.spec !== spec)
    .map((s) => ({ imported: s.imported, local: s.local, type: s.type }));
  const hasOther = (decl.specifiers ?? []).some(
    (s: Node) => s.type === "ImportDefaultSpecifier" || s.type === "ImportNamespaceSpecifier",
  );
  if (remaining.length === 0 && !hasOther) removeDeclaration(ms, code, decl);
  else ms.overwrite(decl.start, decl.end, serializeImport(code, decl, remaining));
}

export default transformNeedleDi;
