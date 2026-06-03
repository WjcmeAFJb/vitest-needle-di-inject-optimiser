import { parseSync, type ParseResult } from "oxc-parser";
import MagicString from "magic-string";
import { type NeedleDiOptimiserOptions, resolveOptions } from "./options.js";

// We work against the oxc ESTree AST structurally (plain JSON with type/start/end).
/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

export interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
}

const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
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
  return "jsx";
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
  return im.type === "Identifier" ? im.name : im.value;
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

/** True for identifier occurrences that are NOT value references (declarations, keys, etc.). */
function isNonReference(node: Node, parent: Node): boolean {
  switch (parent.type) {
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
      return true;
    case "VariableDeclarator":
      return parent.id === node;
    case "Property":
      return parent.key === node && !parent.computed && !parent.shorthand;
    case "MemberExpression":
      return parent.property === node && !parent.computed;
    default:
      return false;
  }
}

function lineOf(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i++) if (code[i] === "\n") line++;
  return line;
}

/** Depth-first walk exposing the live ancestor chain (parents only). */
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

/** Names introduced by local bindings (used to skip shadowed dependencies). */
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

interface LocalToken {
  exportName: string;
  argCount: number;
  start: number;
}

/** Collect `const X = new InjectionToken(...)` declarations. */
function collectLocalTokens(program: Node, injectionTokenLocal: string | undefined): Map<string, LocalToken> {
  const tokens = new Map<string, LocalToken>();
  if (!injectionTokenLocal) return tokens;
  const addVarDecl = (varDecl: Node): void => {
    if (varDecl.kind !== "const") return;
    for (const d of varDecl.declarations ?? []) {
      if (
        d.id?.type === "Identifier" &&
        d.init?.type === "NewExpression" &&
        d.init.callee?.type === "Identifier" &&
        d.init.callee.name === injectionTokenLocal
      ) {
        tokens.set(d.id.name, { exportName: d.id.name, argCount: (d.init.arguments ?? []).length, start: d.init.start });
      }
    }
  };
  for (const node of program.body) {
    if (node.type === "VariableDeclaration") addVarDecl(node);
    else if (node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration") {
      addVarDecl(node.declaration);
    }
  }
  for (const node of program.body) {
    if (node.type !== "ExportNamedDeclaration" || node.declaration) continue;
    for (const s of node.specifiers ?? []) {
      if (s.local?.type !== "Identifier") continue;
      const tok = tokens.get(s.local.name);
      if (tok) tok.exportName = s.exported.type === "Identifier" ? s.exported.name : s.exported.value;
    }
  }
  return tokens;
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

interface Imports {
  needleImports: boolean;
  injectLocal?: string;
  injectionTokenLocal?: string;
  injectionTokenSpec?: Node;
  injectionTokenDecl?: Node;
  injectionTokenIsType?: boolean;
  needleValueDecl?: Node;
  supplyLocal?: string;
  deps: Map<string, DepImport>;
}

function collectImports(program: Node, options: Required<NeedleDiOptimiserOptions>): Imports {
  const r: Imports = { needleImports: false, deps: new Map() };
  const isSupplyModule = (s: string): boolean => s === options.supplyModule || s.startsWith(`${options.supplyModule}/`);

  for (const node of program.body) {
    if (node.type !== "ImportDeclaration") continue;
    const source = node.source.value as string;
    const declIsType = node.importKind === "type";

    if (source === options.needleModule) {
      r.needleImports = true;
      for (const spec of node.specifiers ?? []) {
        if (spec.type !== "ImportSpecifier") continue;
        const imported = specifierImportedName(spec);
        const specIsType = declIsType || spec.importKind === "type";
        if (imported === "inject" && !specIsType) {
          r.injectLocal = spec.local.name;
          if (!declIsType) r.needleValueDecl = node;
        } else if (imported === "InjectionToken") {
          r.injectionTokenLocal = spec.local.name;
          r.injectionTokenSpec = spec;
          r.injectionTokenDecl = node;
          r.injectionTokenIsType = specIsType;
        }
      }
      if (!declIsType && !r.needleValueDecl) r.needleValueDecl = node;
      continue;
    }

    if (isSupplyModule(source)) {
      for (const spec of node.specifiers ?? []) {
        if (spec.type === "ImportSpecifier" && specifierImportedName(spec) === "supply" && spec.importKind !== "type") {
          r.supplyLocal = spec.local.name;
        }
      }
      continue;
    }

    for (const spec of node.specifiers ?? []) {
      if (spec.type !== "ImportSpecifier") continue;
      r.deps.set(spec.local.name, {
        localName: spec.local.name,
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
  return r;
}

interface Analysis extends Imports {
  localTokens: Map<string, LocalToken>;
  tokenKeyByLocal: Map<string, string>;
}

function analyze(program: Node, options: Required<NeedleDiOptimiserOptions>): Analysis {
  const imp = collectImports(program, options);
  const localTokens = collectLocalTokens(program, imp.injectionTokenLocal);
  const bound = collectBoundNames(program);
  for (const [name, dep] of imp.deps) {
    if (bound.has(name) || !options.shouldOptimise(dep)) imp.deps.delete(name);
  }
  const tokenKeyByLocal = new Map<string, string>();
  for (const [name, tok] of localTokens) {
    const info = { localName: name, importedName: tok.exportName, source: "" };
    if (options.shouldOptimise(info)) tokenKeyByLocal.set(name, options.tokenKey(info));
  }
  return { ...imp, localTokens, tokenKeyByLocal };
}

/** The Symbol.for key for an identifier name, if it is an eligible dep or local token. */
function keyForName(name: string, a: Analysis, options: Required<NeedleDiOptimiserOptions>): string | undefined {
  const dep = a.deps.get(name);
  if (dep) return options.tokenKey(dep);
  return a.tokenKeyByLocal.get(name);
}

/**
 * Scan a single file for the keys of every `supply(X)` call. Used to build the
 * project-wide supply set.
 */
export function collectSupplyKeys(
  code: string,
  filename: string,
  rawOptions: NeedleDiOptimiserOptions = {},
): Set<string> {
  const options = resolveOptions(rawOptions);
  const keys = new Set<string>();
  if (!code.includes(options.supplyModule)) return keys;

  let parsed: ParseResult;
  try {
    parsed = parseSync(filename, code, { sourceType: "module", lang: langFor(filename) });
  } catch {
    return keys;
  }
  if (parsed.errors.length > 0) return keys;

  const a = analyze(parsed.program as Node, options);
  if (a.supplyLocal === undefined) return keys;

  walk(parsed.program as Node, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === a.supplyLocal &&
      node.arguments?.[0]?.type === "Identifier"
    ) {
      const key = keyForName(node.arguments[0].name, a, options);
      if (key !== undefined) keys.add(key);
    }
  });
  return keys;
}

/**
 * Rewrite a single file. `suppliedKeys` is the project-wide set of `Symbol.for`
 * keys that appear in some `supply(...)` call; it gates `bind` rewriting and the
 * `inject()` diagnostic.
 */
export function transformNeedleDi(
  code: string,
  filename: string,
  rawOptions: NeedleDiOptimiserOptions = {},
  suppliedKeys: ReadonlySet<string> = new Set(),
): TransformResult | null {
  const options = resolveOptions(rawOptions);
  if (!code.includes(options.needleModule) && !code.includes(options.supplyModule)) return null;

  let parsed: ParseResult;
  try {
    parsed = parseSync(filename, code, { sourceType: "module", lang: langFor(filename) });
  } catch {
    return null;
  }
  if (parsed.errors.length > 0) return null;
  const program = parsed.program as Node;

  const a = analyze(program, options);
  if (!a.needleImports && a.supplyLocal === undefined) return null;

  // Build-time assertion: a supplied local InjectionToken must not carry a factory.
  for (const [name, tok] of a.localTokens) {
    const key = a.tokenKeyByLocal.get(name);
    if (key !== undefined && suppliedKeys.has(key) && tok.argCount >= 2) {
      throw new Error(
        `[needle-di-inject-optimiser] InjectionToken "${tok.exportName}" (${filename}:${lineOf(code, tok.start)}) ` +
          `is supply()-ed somewhere but passes a second constructor argument (a factory). supply() rewrites it to a ` +
          `plain Symbol.for(${JSON.stringify(tok.exportName)}), so the factory would never run. Remove the factory.`,
      );
    }
  }

  // --- helpers for call-shape detection ---
  const isSupplyArg = (node: Node, parent: Node): boolean =>
    options.rewriteSupply &&
    a.supplyLocal !== undefined &&
    parent.type === "CallExpression" &&
    parent.callee?.type === "Identifier" &&
    parent.callee.name === a.supplyLocal &&
    parent.arguments?.[0] === node;

  const isInjectArg = (node: Node, parent: Node): boolean =>
    a.injectLocal !== undefined &&
    parent.type === "CallExpression" &&
    parent.callee?.type === "Identifier" &&
    parent.callee.name === a.injectLocal &&
    parent.arguments?.[0] === node;

  const isProvideValue = (node: Node, parent: Node, ancestors: Node[]): boolean => {
    if (!options.rewriteBind || parent.type !== "Property" || parent.value !== node) return false;
    const key = propKeyName(parent);
    const objExpr = ancestors[ancestors.length - 2];
    const call = ancestors[ancestors.length - 3];
    return (
      (key === "provide" || key === "provider") &&
      objExpr?.type === "ObjectExpression" &&
      call?.type === "CallExpression" &&
      call.callee?.type === "MemberExpression" &&
      (memberPropName(call.callee) === "bind" || memberPropName(call.callee) === "bindAll") &&
      !!call.arguments?.includes(objExpr)
    );
  };

  const injectError = (name: string, key: string, start: number): never => {
    throw new Error(
      `[needle-di-inject-optimiser] inject(${name}) at ${filename}:${lineOf(code, start)} — "${name}" is ` +
        `supply()-ed elsewhere, so it is resolved via Symbol.for(${JSON.stringify(key)}). An eager inject() here ` +
        `would bypass that token and overrides would not apply. Use supply(${name}) instead (or stop supplying it).`,
    );
  };

  // --- classify references ---
  const supplyClassSites: Array<{ start: number; end: number; dep: DepImport; key: string }> = [];
  const symbolSites: Array<{ start: number; end: number; key: string }> = []; // supply(token) + supplied provide

  walk(program, (node, ancestors) => {
    if (node.type !== "Identifier") return;
    const parent = ancestors[ancestors.length - 1];
    if (!parent || isNonReference(node, parent)) return;
    const name = node.name;

    // Local exported InjectionToken
    const tokenKey = a.tokenKeyByLocal.get(name);
    if (tokenKey !== undefined) {
      if (isSupplyArg(node, parent)) {
        symbolSites.push({ start: node.start, end: node.end, key: tokenKey });
      } else if (isInjectArg(node, parent)) {
        if (options.diagnoseInject && suppliedKeys.has(tokenKey)) injectError(name, tokenKey, node.start);
      } else if (isProvideValue(node, parent, ancestors) && suppliedKeys.has(tokenKey)) {
        symbolSites.push({ start: node.start, end: node.end, key: tokenKey });
      }
      return;
    }

    const dep = a.deps.get(name);
    if (!dep) return;

    if (parent.type === "TSTypeQuery") {
      dep.retainedValue++;
      return;
    }
    if (typeof parent.type === "string" && parent.type.startsWith("TS") && !TS_VALUE_WRAPPERS.has(parent.type)) {
      dep.typeRefs++;
      return;
    }

    const key = options.tokenKey(dep);
    if (isSupplyArg(node, parent)) {
      dep.consumed++;
      supplyClassSites.push({ start: node.start, end: node.end, dep, key });
      return;
    }
    if (isInjectArg(node, parent)) {
      if (options.diagnoseInject && suppliedKeys.has(key)) injectError(name, key, node.start);
      dep.retainedValue++; // left as-is; X is still referenced as a value
      return;
    }
    if (isProvideValue(node, parent, ancestors)) {
      if (suppliedKeys.has(key)) {
        dep.consumed++;
        symbolSites.push({ start: node.start, end: node.end, key });
      } else {
        dep.retainedValue++;
      }
      return;
    }
    dep.retainedValue++;
  });

  if (supplyClassSites.length === 0 && symbolSites.length === 0) return null;

  const ms = new MagicString(code);

  // Ensure InjectionToken value import (only needed for class supply sites).
  let injectionTokenLocal = a.injectionTokenLocal;
  let injectionTokenReady = a.injectionTokenLocal !== undefined && !a.injectionTokenIsType;
  const ensureInjectionToken = (): string => {
    if (injectionTokenReady && injectionTokenLocal) return injectionTokenLocal;
    const valueDecl = a.needleValueDecl;
    let local: string;
    if (a.injectionTokenLocal) local = a.injectionTokenLocal;
    else {
      const taken = new Set<string>([...a.deps.keys()]);
      if (a.injectLocal) taken.add(a.injectLocal);
      if (a.supplyLocal) taken.add(a.supplyLocal);
      if (!taken.has("InjectionToken")) local = "InjectionToken";
      else {
        let i = 1;
        while (taken.has(`InjectionToken$${i}`)) i++;
        local = `InjectionToken$${i}`;
      }
    }
    if (a.injectionTokenIsType && a.injectionTokenDecl && a.injectionTokenDecl !== valueDecl) {
      rewriteOrRemoveSpecifier(ms, code, a.injectionTokenDecl, a.injectionTokenSpec);
    }
    if (!valueDecl) {
      ms.prepend(
        `import { InjectionToken${local !== "InjectionToken" ? ` as ${local}` : ""} } from ${JSON.stringify(options.needleModule)};\n`,
      );
    } else {
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

  // --- apply edits ---
  for (const site of supplyClassSites) {
    const local = ensureInjectionToken();
    ms.overwrite(
      site.start,
      site.end,
      lazyTokenSrc(local, site.key, options.resolveRequireSpecifier(site.dep.source, filename), site.dep.importedName),
    );
  }
  for (const site of symbolSites) {
    ms.overwrite(site.start, site.end, symbolForSrc(site.key));
  }

  // --- remove / downgrade now-unused dependency imports ---
  const declsToRewrite = new Set<Node>();
  for (const dep of a.deps.values()) {
    if (dep.consumed === 0 || dep.retainedValue > 0) continue;
    declsToRewrite.add(dep.decl);
  }
  for (const decl of declsToRewrite) {
    const depsOnDecl = [...a.deps.values()].filter((d) => d.decl === decl && d.consumed > 0 && d.retainedValue === 0);
    const named = namedSpecsOf(decl).flatMap((s) => {
      const dep = depsOnDecl.find((d) => d.spec === s.spec);
      if (!dep) return [{ imported: s.imported, local: s.local, type: s.type }];
      if (dep.typeRefs > 0) return [{ imported: s.imported, local: s.local, type: true }];
      return [];
    });
    const hasOther = (decl.specifiers ?? []).some(
      (s: Node) => s.type === "ImportDefaultSpecifier" || s.type === "ImportNamespaceSpecifier",
    );
    if (named.length === 0 && !hasOther) removeDeclaration(ms, code, decl);
    else ms.overwrite(decl.start, decl.end, serializeImport(code, decl, named));
  }

  return { code: ms.toString(), map: ms.generateMap({ source: filename, includeContent: true, hires: true }) };
}

function serializeImport(
  code: string,
  decl: Node,
  namedSpecs: Array<{ imported: string; local: string; type: boolean }>,
  extraNamed: Array<{ imported: string; local: string }> = [],
): string {
  const sourceText = code.slice(decl.source.start, decl.source.end);
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
  if (parts.length === 0) return "";
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

function removeDeclaration(ms: MagicString, code: string, decl: Node): void {
  let end = decl.end;
  if (code[end] === "\r") end++;
  if (code[end] === "\n") end++;
  ms.remove(decl.start, end);
}

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
