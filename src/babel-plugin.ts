import type { PluginObj, PluginPass, NodePath } from "@babel/core";
import type * as BT from "@babel/types";
import { type NeedleDiOptimiserOptions, resolveOptions } from "./options.js";

type Types = typeof BT;

interface BabelAPI {
  types: Types;
  assertVersion?: (range: number | string) => void;
}

/** Build `Symbol.for("key")` — a fresh node each call (Babel requires unique nodes). */
function symbolFor(t: Types, key: string): BT.CallExpression {
  return t.callExpression(t.memberExpression(t.identifier("Symbol"), t.identifier("for")), [
    t.stringLiteral(key),
  ]);
}

const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Build `require("source").member` (computed if member is not a valid identifier). */
function requireMember(t: Types, source: string, member: string): BT.MemberExpression {
  const req = t.callExpression(t.identifier("require"), [t.stringLiteral(source)]);
  return VALID_IDENT.test(member)
    ? t.memberExpression(req, t.identifier(member))
    : t.memberExpression(req, t.stringLiteral(member), true);
}

/**
 * Build the lazy token expression:
 *
 *   new InjectionToken(Symbol.for(KEY), {
 *     factory: (container) =>
 *       container.get(Symbol.for(KEY), { optional: true }) ??
 *       container
 *         .bind({ provide: Symbol.for(KEY), useClass: require(SOURCE).MEMBER })
 *         .get(Symbol.for(KEY)),
 *   })
 *
 * `{ optional: true }` is required: needle-di's `container.get` THROWS when a token
 * is unbound, so the `??` fallback only works with the optional overload.
 */
function buildLazyInjectionToken(
  t: Types,
  opts: { injectionTokenLocal: string; key: string; source: string; member: string },
): BT.NewExpression {
  const { injectionTokenLocal, key, source, member } = opts;

  const getOptional = t.callExpression(
    t.memberExpression(t.identifier("container"), t.identifier("get")),
    [symbolFor(t, key), t.objectExpression([t.objectProperty(t.identifier("optional"), t.booleanLiteral(true))])],
  );

  const bindThenGet = t.callExpression(
    t.memberExpression(
      t.callExpression(t.memberExpression(t.identifier("container"), t.identifier("bind")), [
        t.objectExpression([
          t.objectProperty(t.identifier("provide"), symbolFor(t, key)),
          t.objectProperty(t.identifier("useClass"), requireMember(t, source, member)),
        ]),
      ]),
      t.identifier("get"),
    ),
    [symbolFor(t, key)],
  );

  const factory = t.arrowFunctionExpression(
    [t.identifier("container")],
    t.logicalExpression("??", getOptional, bindThenGet),
  );

  return t.newExpression(t.identifier(injectionTokenLocal), [
    symbolFor(t, key),
    t.objectExpression([t.objectProperty(t.identifier("factory"), factory)]),
  ]);
}

function importedNameOf(t: Types, spec: BT.ImportSpecifier): string {
  return t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
}

function objectKeyName(t: Types, prop: BT.ObjectProperty): string | undefined {
  if (!prop.computed && t.isIdentifier(prop.key)) return prop.key.name;
  if (t.isStringLiteral(prop.key)) return prop.key.value;
  return undefined;
}

function memberPropName(t: Types, node: BT.MemberExpression): string | undefined {
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
  if (t.isStringLiteral(node.property)) return node.property.value;
  return undefined;
}

function leftmostEntityName(t: Types, name: BT.TSEntityName): string | undefined {
  let n: BT.TSEntityName = name;
  while (t.isTSQualifiedName(n)) n = n.left;
  return t.isIdentifier(n) ? n.name : undefined;
}

/**
 * Whether an identifier reference sits in a TypeScript *type* position
 * (e.g. `: Dependency`, `as Dependency`, `typeof Dependency`). Babel's
 * `ReferencedIdentifier` virtual type also visits these, so we must filter them
 * out of value-usage counting.
 */
function isInTypePosition(t: Types, path: NodePath): boolean {
  let p: NodePath | null = path.parentPath;
  while (p) {
    const n = p.node;
    if (
      t.isTSType(n) ||
      t.isTSTypeAnnotation(n) ||
      t.isTSTypeAliasDeclaration(n) ||
      t.isTSInterfaceDeclaration(n) ||
      t.isTSTypeParameterInstantiation(n) ||
      t.isTSTypeParameterDeclaration(n)
    ) {
      return true;
    }
    if (p.isStatement() || p.isExpression() || p.isProgram()) return false;
    p = p.parentPath;
  }
  return false;
}

interface DepImport {
  localName: string;
  importedName: string;
  source: string;
  specifier: NodePath<BT.ImportSpecifier>;
  decl: NodePath<BT.ImportDeclaration>;
  /** consumable references (inject args + provide values) that will be removed. */
  consumed: number;
  /** value references that must keep the value import alive (incl. `typeof X`). */
  retainedValue: number;
  /** pure type references (e.g. `: Dependency`) — allow downgrade to `import type`. */
  typeRefs: number;
}

export function createNeedleDiBabelPlugin(
  babel: BabelAPI,
  rawOptions: NeedleDiOptimiserOptions = {},
): PluginObj<PluginPass> {
  const t = babel.types;
  babel.assertVersion?.(7);
  const options = resolveOptions(rawOptions);

  return {
    name: "needle-di-inject-optimiser",
    visitor: {
      Program(programPath: NodePath<BT.Program>, state: PluginPass) {
        const importerFilename = state.filename;

        // ---- 1. Collect needle-di imports -----------------------------------
        let injectLocal: string | undefined;
        let injectSpecNode: BT.Node | undefined;
        let injectionTokenLocal: string | undefined;
        let injectionTokenSpec: NodePath<BT.ImportSpecifier> | undefined;
        let injectionTokenIsType = false;
        let needleValueDecl: NodePath<BT.ImportDeclaration> | undefined;
        let importsNeedle = false;

        // ---- 2. Collect candidate dependency imports (named, non-needle) ----
        const deps = new Map<string, DepImport>();

        for (const decl of programPath.get("body")) {
          if (!decl.isImportDeclaration()) continue;
          const source = decl.node.source.value;
          const declIsType = decl.node.importKind === "type";

          if (source === options.needleModule) {
            importsNeedle = true;
            for (const spec of decl.get("specifiers")) {
              if (!spec.isImportSpecifier()) continue;
              const imported = importedNameOf(t, spec.node);
              const specIsType = declIsType || spec.node.importKind === "type";
              if (imported === "inject" && !specIsType) {
                injectLocal = spec.node.local.name;
                injectSpecNode = spec.node;
                if (!needleValueDecl && !declIsType) needleValueDecl = decl;
              } else if (imported === "InjectionToken") {
                injectionTokenLocal = spec.node.local.name;
                injectionTokenSpec = spec;
                injectionTokenIsType = specIsType;
              }
            }
            if (!declIsType && !needleValueDecl) needleValueDecl = decl;
            continue;
          }

          for (const spec of decl.get("specifiers")) {
            if (!spec.isImportSpecifier()) continue; // named imports only
            const localName = spec.node.local.name;
            deps.set(localName, {
              localName,
              importedName: importedNameOf(t, spec.node),
              source,
              specifier: spec,
              decl,
              consumed: 0,
              retainedValue: 0,
              typeRefs: 0,
            });
          }
        }

        // Only touch files that actually use needle-di.
        if (!importsNeedle) return;

        // ---- 2b. Collect local `const X = new InjectionToken(...)` tokens -----
        interface LocalTok {
          exportName: string;
          exported: boolean;
          argCount: number;
          initPath: NodePath;
        }
        const localTokens = new Map<string, LocalTok>();
        if (injectionTokenLocal) {
          const addVarDecl = (declPath: NodePath<BT.VariableDeclaration>, exported: boolean): void => {
            if (declPath.node.kind !== "const") return;
            for (const dtor of declPath.get("declarations")) {
              const id = dtor.node.id;
              const init = dtor.node.init;
              if (
                t.isIdentifier(id) &&
                init &&
                t.isNewExpression(init) &&
                t.isIdentifier(init.callee) &&
                init.callee.name === injectionTokenLocal
              ) {
                localTokens.set(id.name, {
                  exportName: id.name,
                  exported,
                  argCount: init.arguments.length,
                  initPath: dtor.get("init") as NodePath,
                });
              }
            }
          };
          for (const stmt of programPath.get("body")) {
            if (stmt.isVariableDeclaration()) addVarDecl(stmt, false);
            else if (stmt.isExportNamedDeclaration()) {
              const d = stmt.get("declaration");
              if (d.isVariableDeclaration()) addVarDecl(d, true);
            }
          }
          for (const stmt of programPath.get("body")) {
            if (!stmt.isExportNamedDeclaration() || stmt.node.declaration) continue;
            for (const spec of stmt.node.specifiers) {
              if (!t.isExportSpecifier(spec)) continue;
              const tok = localTokens.get(spec.local.name);
              if (tok) {
                tok.exported = true;
                tok.exportName = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
              }
            }
          }
        }

        const eligibleToken = (name: string, tok: LocalTok): boolean =>
          tok.exported && options.shouldOptimise({ localName: name, importedName: tok.exportName, source: "" });

        // Build-time assertion: an exported InjectionToken whose references become a
        // plain Symbol.for(...) must NOT carry a factory (2nd ctor arg).
        for (const [name, tok] of localTokens) {
          if (eligibleToken(name, tok) && tok.argCount >= 2) {
            throw tok.initPath.buildCodeFrameError(
              `[needle-di-inject-optimiser] Exported InjectionToken "${tok.exportName}" passes a second ` +
                `constructor argument (a factory). This plugin rewrites references to exported InjectionTokens ` +
                `into a plain Symbol.for(${JSON.stringify(tok.exportName)}), so the factory would never run. ` +
                `Remove the factory and bind a provider for the token instead.`,
            );
          }
        }

        const tokenKeyByLocal = new Map<string, string>();
        for (const [name, tok] of localTokens) {
          if (eligibleToken(name, tok)) {
            tokenKeyByLocal.set(name, options.tokenKey({ localName: name, importedName: tok.exportName, source: "" }));
          }
        }

        if (deps.size === 0 && tokenKeyByLocal.size === 0) return;

        const depOf = (path: NodePath<BT.Identifier>): DepImport | undefined => {
          const dep = deps.get(path.node.name);
          if (!dep) return undefined;
          if (!options.shouldOptimise(dep)) return undefined;
          // Confirm the identifier really resolves to the import (not a shadow).
          const binding = path.scope.getBinding(path.node.name);
          if (binding && binding.path.node !== dep.specifier.node) return undefined;
          return dep;
        };

        const injectSites: Array<{ argPath: NodePath<BT.Identifier>; dep: DepImport }> = [];
        const provideSites: Array<{ valuePath: NodePath<BT.Identifier>; dep: DepImport }> = [];
        const tokenSites: Array<{ path: NodePath<BT.Identifier>; key: string }> = [];

        const isInjectArg = (path: NodePath<BT.Identifier>): boolean => {
          const parent = path.parentPath;
          if (!options.rewriteInject || !injectLocal || !parent?.isCallExpression()) return false;
          if (path.listKey !== "arguments" || path.key !== 0) return false;
          const callee = parent.get("callee");
          return (
            callee.isIdentifier() &&
            callee.node.name === injectLocal &&
            callee.scope.getBinding(injectLocal)?.path.node === injectSpecNode
          );
        };

        const isProvideValue = (path: NodePath<BT.Identifier>): boolean => {
          const parent = path.parentPath;
          if (!options.rewriteBind || !parent?.isObjectProperty() || parent.node.value !== path.node) return false;
          const key = objectKeyName(t, parent.node);
          if (key !== "provide" && key !== "provider") return false;
          const objExpr = parent.parentPath;
          if (!objExpr?.isObjectExpression() || objExpr.listKey !== "arguments") return false;
          const call = objExpr.parentPath;
          if (!call?.isCallExpression()) return false;
          const callee = call.get("callee");
          if (!callee.isMemberExpression()) return false;
          const m = memberPropName(t, callee.node);
          return m === "bind" || m === "bindAll";
        };

        // `mocks.get(Token)` / `fixture.mocks.get(Token)` — the first argument.
        const isMocksGetArg = (path: NodePath<BT.Identifier>): boolean => {
          const parent = path.parentPath;
          if (!options.rewriteMockGet || !parent?.isCallExpression()) return false;
          if (path.listKey !== "arguments" || path.key !== 0) return false;
          const callee = parent.get("callee");
          if (!callee.isMemberExpression() || memberPropName(t, callee.node) !== "get") return false;
          const obj = callee.get("object");
          if (obj.isIdentifier() && obj.node.name === "mocks") return true;
          return obj.isMemberExpression() && memberPropName(t, obj.node) === "mocks";
        };

        // ---- 3. Classify every value reference ------------------------------
        programPath.traverse({
          ReferencedIdentifier(path) {
            if (!path.isIdentifier()) return;

            // Local exported InjectionToken -> Symbol.for(key) in inject()/provide.
            const tokenKey = tokenKeyByLocal.get(path.node.name);
            if (tokenKey !== undefined) {
              if (isInTypePosition(t, path)) return;
              if (isInjectArg(path) || isProvideValue(path) || isMocksGetArg(path)) {
                tokenSites.push({ path, key: tokenKey });
              }
              return;
            }

            const dep = depOf(path);
            if (!dep) return;
            // Type-position references are handled by the TSTypeReference pass below.
            if (isInTypePosition(t, path)) return;

            // inject(Dependency)
            if (isInjectArg(path)) {
              dep.consumed++;
              injectSites.push({ argPath: path, dep });
              return;
            }
            // .bind({ provide: Dependency }) / .bindAll(...) / provider:, or mocks.get(Dependency)
            if (isProvideValue(path) || isMocksGetArg(path)) {
              dep.consumed++;
              provideSites.push({ valuePath: path, dep });
              return;
            }

            // Any other value usage keeps the (value) import alive.
            dep.retainedValue++;
          },
        });

        // ---- 3b. Classify type references (for import downgrade decision) ----
        programPath.traverse({
          TSTypeReference(path) {
            const name = leftmostEntityName(t, path.node.typeName);
            const dep = name ? deps.get(name) : undefined;
            if (dep && options.shouldOptimise(dep)) dep.typeRefs++;
          },
          TSTypeQuery(path) {
            // `typeof X` needs X to remain a *value* binding — force keeping it.
            if (t.isTSEntityName(path.node.exprName)) {
              const name = leftmostEntityName(t, path.node.exprName);
              const dep = name ? deps.get(name) : undefined;
              if (dep && options.shouldOptimise(dep)) dep.retainedValue++;
            }
          },
        });

        if (injectSites.length === 0 && provideSites.length === 0 && tokenSites.length === 0) return;

        // ---- 4. Ensure `InjectionToken` is available as a value import ------
        let injectionTokenReady = false;
        const ensureInjectionToken = (): string => {
          if (injectionTokenReady && injectionTokenLocal) return injectionTokenLocal;

          if (injectionTokenLocal && !injectionTokenIsType) {
            injectionTokenReady = true;
            return injectionTokenLocal;
          }

          // Imported as a type — drop the type specifier, re-add as a value below.
          if (injectionTokenLocal && injectionTokenIsType && injectionTokenSpec) {
            const decl = injectionTokenSpec.parentPath as NodePath<BT.ImportDeclaration>;
            injectionTokenSpec.remove();
            if (decl.node.specifiers.length === 0) decl.remove();
          }

          const local = injectionTokenLocal && !programPath.scope.hasBinding(injectionTokenLocal)
            ? injectionTokenLocal
            : injectionTokenLocal ?? (programPath.scope.hasBinding("InjectionToken")
              ? programPath.scope.generateUid("InjectionToken")
              : "InjectionToken");

          const specifier = t.importSpecifier(t.identifier(local), t.identifier("InjectionToken"));
          if (needleValueDecl) {
            needleValueDecl.node.specifiers.push(specifier);
          } else {
            const decl = t.importDeclaration([specifier], t.stringLiteral(options.needleModule));
            programPath.unshiftContainer("body", decl);
          }
          injectionTokenLocal = local;
          injectionTokenReady = true;
          return local;
        };

        // ---- 5. Apply transforms -------------------------------------------
        for (const { argPath, dep } of injectSites) {
          const local = ensureInjectionToken();
          argPath.replaceWith(
            buildLazyInjectionToken(t, {
              injectionTokenLocal: local,
              key: options.tokenKey(dep),
              source: options.resolveRequireSpecifier(dep.source, importerFilename),
              member: dep.importedName,
            }),
          );
        }

        for (const { valuePath, dep } of provideSites) {
          valuePath.replaceWith(symbolFor(t, options.tokenKey(dep)));
        }

        for (const { path, key } of tokenSites) {
          path.replaceWith(symbolFor(t, key));
        }

        // ---- 6. Remove or downgrade now-unused dependency imports ----------
        for (const dep of deps.values()) {
          if (dep.consumed === 0) continue; // we didn't touch it
          if (dep.retainedValue > 0) continue; // still used as a value elsewhere

          if (dep.typeRefs > 0) {
            // Used only as a type now → keep as a type-only (erased) import.
            dep.specifier.node.importKind = "type";
          } else {
            const decl = dep.decl;
            dep.specifier.remove();
            if (decl.node.specifiers.length === 0) decl.remove();
          }
        }
      },
    },
  };
}

export default createNeedleDiBabelPlugin;
