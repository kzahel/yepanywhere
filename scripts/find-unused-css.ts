#!/usr/bin/env npx tsx
/**
 * Find and optionally remove unused CSS class selectors.
 *
 * Two analyses run side by side, because the two kinds of stylesheet have
 * different namespaces (see topics/css-architecture.md):
 *
 * - Global stylesheets share one document-wide class namespace, so a class is
 *   used when production client source names a whole token or a reviewed
 *   runtime/generated family declares its emitter.
 * - `*.module.css` selectors are scoped per file and reached only through the
 *   binding an importer gives them (`styles.foo`, `styles["foo"]`), so usage is
 *   resolved per module rather than by name. Two modules may both define
 *   `.error` without being the same class, and a module `.container` is not
 *   used merely because the word "container" appears somewhere in the client.
 *
 * Usage:
 *   npx tsx scripts/find-unused-css.ts [options]
 *   pnpm css:unused
 *
 * Options:
 *   --css-dir <dir>  Directory to scan for CSS (default: packages/client/src)
 *   --src-dir <dir>  Directory to scan for source files (default: packages)
 *   --verbose        Show which files each class was found in
 *   --json           Output as JSON
 *   --remove         Remove unused global CSS rules (writes changes to files)
 *   --dry-run        Show what would be removed without making changes
 *   --modules-check  Check only blocking CSS Module contracts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import * as ts from "typescript";

export interface Options {
  cssDir: string;
  srcDir: string;
  verbose: boolean;
  json: boolean;
  remove: boolean;
  dryRun: boolean;
  modulesCheck: boolean;
}

export interface ClassInfo {
  name: string;
  cssFile: string;
  line: number;
  usedIn: string[];
}

/** Why a module's selectors cannot be judged unused. */
export type ModuleUnknownReason = "side-effect-import" | "computed-access";

export interface ModuleSelectorInfo extends ClassInfo {
  productionUsedIn: string[];
  testUsedIn: string[];
}

export interface ModuleUndeclaredAccess {
  name: string;
  productionUsedIn: string[];
  testUsedIn: string[];
}

export interface ModuleUnknownUsage {
  reason: ModuleUnknownReason;
  file: string;
}

export interface ModuleGlobalUse {
  name: string;
  line: number;
  selector: string;
  localAnchors: string[];
  kind: "selector" | "composes";
}

export type ModuleGlobalIssueKind = "missing-global" | "unanchored-global";

export interface ModuleGlobalIssue extends ModuleGlobalUse {
  issue: ModuleGlobalIssueKind;
}

export interface ModuleReport {
  cssFile: string;
  /** Source files importing this module. */
  importers: string[];
  /** Non-test source files importing this module directly. */
  productionImporters: string[];
  /** Tests, Playwright fixtures, and package scripts importing this module. */
  testImporters: string[];
  /** Directly imported or reached through a production module's composes. */
  productionReachable: boolean;
  /** Other modules reaching this one through `composes ... from`. */
  composers: string[];
  selectors: ModuleSelectorInfo[];
  /** Selectors reached by neither production nor tests. */
  unused: ModuleSelectorInfo[];
  /** Selectors with no statically known production reach. */
  productionUnused: ModuleSelectorInfo[];
  /** Selectors reached by tests but not by production. */
  testOnly: ModuleSelectorInfo[];
  /** Binding accesses that do not name a selector declared by this module. */
  undeclared: ModuleUndeclaredAccess[];
  /** Global class names this module references through `:global(...)`. */
  globalRefs: string[];
  globalUses: ModuleGlobalUse[];
  globalIssues: ModuleGlobalIssue[];
  /**
   * Set when usage cannot be determined statically. Selectors are then
   * reported as unknown rather than unused.
   */
  unknownReasons: ModuleUnknownReason[];
  unknownUsage: ModuleUnknownUsage[];
}

export interface AnalysisResult {
  globalClasses: ClassInfo[];
  globalUsed: ClassInfo[];
  globalUnused: ClassInfo[];
  modules: ModuleReport[];
  moduleUnused: ClassInfo[];
  moduleProductionUnused: ModuleSelectorInfo[];
  runtimeFamilies: RuntimeClassFamily[];
  cssFileCount: number;
  moduleFileCount: number;
  srcFileCount: number;
}

const USAGE = `
Find and optionally remove unused CSS class selectors.

Usage:
  npx tsx scripts/find-unused-css.ts [options]

Options:
  --css-dir <dir>  Directory to scan for CSS (default: packages/client/src)
  --src-dir <dir>  Directory to scan for source files (default: packages)
  --verbose        Show which files each class was found in
  --json           Output as JSON
  --remove         Remove unused global CSS rules (writes changes to files)
  --dry-run        Show what would be removed without making changes
  --modules-check  Check only blocking CSS Module contracts; ignore legacy debt
  --help           Show this help

CSS Module rules are never removed automatically; module selectors are reported
so their owning component can delete them deliberately.
`;

export function parseArgs(argv: string[] = process.argv.slice(2)): Options {
  const options: Options = {
    cssDir: "packages/client/src",
    srcDir: "packages",
    verbose: false,
    json: false,
    remove: false,
    dryRun: false,
    modulesCheck: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") continue;
    switch (argv[i]) {
      case "--css-dir":
        options.cssDir = argv[++i];
        break;
      case "--src-dir":
        options.srcDir = argv[++i];
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--remove":
        options.remove = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--modules-check":
        options.modulesCheck = true;
        break;
      case "--help":
        console.log(USAGE);
        process.exit(0);
    }
  }

  return options;
}

export function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  const skippedDirectories = new Set([
    "node_modules",
    "dist",
    "build",
    "coverage",
    "target",
    "test-results",
    "playwright-report",
  ]);

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (
          !entry.name.startsWith(".") &&
          !skippedDirectories.has(entry.name)
        ) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

const PACKAGE_ANALYSIS_ROOTS = ["src", "e2e", "scripts"];

/** Scan authored package roots without pulling compiled assets back in. */
export function findSourceFiles(dir: string, extensions: string[]): string[] {
  if (path.basename(path.resolve(dir)) !== "packages") {
    return findFiles(dir, extensions);
  }

  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const rootName of PACKAGE_ANALYSIS_ROOTS) {
      const sourceRoot = path.join(dir, entry.name, rootName);
      if (fs.existsSync(sourceRoot)) {
        results.push(...findFiles(sourceRoot, extensions));
      }
    }
  }
  return results;
}

export function isTestSourceFile(file: string): boolean {
  const normalized = file.split(path.sep).join("/");
  return (
    /(^|\/)(__tests__|__fixtures__|__mocks__|tests?|e2e)(\/|\.|$)/.test(
      normalized,
    ) ||
    /(^|\/)packages\/[^/]+\/scripts\//.test(normalized) ||
    /\.(test|spec|specimen|stories)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

/** The three purpose globals are not component-migration candidates. */
export function isPurposeStylesheet(file: string): boolean {
  const absolute = path.resolve(file);
  return ["tokens.css", "base.css", "generated.css"].some(
    (name) => absolute === path.resolve("packages/client/src/styles", name),
  );
}

export function isModuleStylesheet(file: string): boolean {
  return file.endsWith(".module.css");
}

interface SelectorClassBranch {
  selector: string;
  localClassNames: string[];
  globalClassNames: string[];
}

interface SelectorClassAnalysis {
  branches: SelectorClassBranch[];
  globalClassNames: string[];
  scoped: string;
}

function analyzeSelectorClasses(selector: string): SelectorClassAnalysis {
  const root = selectorParser().astSync(selector);
  const globalClassNames = new Set<string>();
  const branches = root.nodes.map((branch) => {
    const local = new Set<string>();
    const global = new Set<string>();
    branch.walkClasses((node) => {
      let parent = node.parent;
      let globalClass = false;
      while (parent && parent !== branch) {
        if (parent.type === "pseudo" && parent.value === ":global") {
          globalClass = true;
          break;
        }
        parent = parent.parent;
      }
      (globalClass ? global : local).add(node.value);
    });
    for (const name of global) globalClassNames.add(name);
    return {
      selector: branch.toString().trim(),
      localClassNames: Array.from(local),
      globalClassNames: Array.from(global),
    };
  });
  root.walkPseudos((pseudo) => {
    if (pseudo.value === ":global") pseudo.remove();
  });
  return {
    branches,
    globalClassNames: Array.from(globalClassNames),
    scoped: root.toString(),
  };
}

/** Extract decoded class-selector nodes, excluding dots in strings and values. */
export function extractSelectorClassNames(selector: string): string[] {
  const names = new Set<string>();
  for (const branch of analyzeSelectorClasses(selector).branches) {
    for (const name of branch.localClassNames) names.add(name);
    for (const name of branch.globalClassNames) names.add(name);
  }
  return Array.from(names);
}

export function extractClassSelectors(
  cssContent: string,
  filename: string,
): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const seen = new Set<string>();

  postcss.parse(cssContent, { from: filename }).walkRules((rule) => {
    for (const className of extractSelectorClassNames(rule.selector)) {
      if (seen.has(className)) continue;
      seen.add(className);
      classes.push({
        name: className,
        cssFile: filename,
        line: rule.source?.start?.line ?? 1,
        usedIn: [],
      });
    }
  });

  return classes;
}

/**
 * Split a module line into its module-scoped part and the class names it
 * references through `:global(...)`.
 *
 * `:global(.modal):has(.content)` declares nothing global; it reaches an
 * existing global class from inside the module. The global names are returned
 * as references so the global analysis counts them as used, and are removed
 * from the line so they are not mistaken for module-owned selectors.
 */
export function splitGlobalReferences(line: string): {
  scoped: string;
  globalRefs: string[];
} {
  const analysis = analyzeSelectorClasses(line);
  return {
    scoped: analysis.scoped,
    globalRefs: analysis.globalClassNames,
  };
}

export interface ComposesReference {
  /** Local class names this module composes from itself. */
  local: string[];
  /** Class names composed from another module, keyed by import specifier. */
  external: Array<{ specifier: string; names: string[] }>;
  /** Class names composed from the global namespace. */
  global: string[];
}

export function extractComposes(cssContent: string): ComposesReference {
  const result: ComposesReference = { local: [], external: [], global: [] };
  postcss.parse(cssContent).walkDecls("composes", (declaration) => {
    const value = declaration.value.trim();
    const fromMatch = /^([\s\S]+?)\s+from\s+(.+)$/.exec(value);

    if (!fromMatch) {
      result.local.push(...value.split(/\s+/).filter(Boolean));
      return;
    }

    const names = fromMatch[1].split(/\s+/).filter(Boolean);
    const source = fromMatch[2].trim();
    if (source === "global") {
      result.global.push(...names);
      return;
    }
    const specifier = source.replace(/^["']|["']$/g, "");
    result.external.push({ specifier, names });
  });

  return result;
}

/**
 * Extract module-scoped selectors from a `*.module.css` file, along with the
 * global class names it references.
 */
export function extractModuleSelectors(
  cssContent: string,
  filename: string,
): {
  selectors: ModuleSelectorInfo[];
  globalRefs: string[];
  globalUses: ModuleGlobalUse[];
} {
  const selectors: ModuleSelectorInfo[] = [];
  const globalRefs = new Set<string>();
  const globalUses: ModuleGlobalUse[] = [];
  const seen = new Set<string>();

  const root = postcss.parse(cssContent, { from: filename });
  root.walkRules((rule) => {
    const analysis = analyzeSelectorClasses(rule.selector);
    for (const branch of analysis.branches) {
      for (const name of branch.globalClassNames) {
        globalRefs.add(name);
        globalUses.push({
          name,
          line: rule.source?.start?.line ?? 1,
          selector: branch.selector,
          localAnchors: branch.localClassNames,
          kind: "selector",
        });
      }

      for (const className of branch.localClassNames) {
        if (seen.has(className)) continue;
        seen.add(className);
        selectors.push({
          name: className,
          cssFile: filename,
          line: rule.source?.start?.line ?? 1,
          usedIn: [],
          productionUsedIn: [],
          testUsedIn: [],
        });
      }
    }
  });

  root.walkDecls("composes", (declaration) => {
    const match = /^([\s\S]+?)\s+from\s+global$/.exec(declaration.value.trim());
    if (!match) return;
    const rule = declaration.parent;
    const selector = rule?.type === "rule" ? rule.selector : "<declaration>";
    const branches =
      rule?.type === "rule"
        ? analyzeSelectorClasses(rule.selector).branches
        : [
            {
              selector,
              localClassNames: [],
              globalClassNames: [],
            },
          ];
    for (const name of match[1].split(/\s+/).filter(Boolean)) {
      globalRefs.add(name);
      for (const branch of branches) {
        globalUses.push({
          name,
          line: declaration.source?.start?.line ?? 1,
          selector: branch.selector,
          localAnchors: branch.localClassNames,
          kind: "composes",
        });
      }
    }
  });

  return {
    selectors,
    globalRefs: Array.from(globalRefs),
    globalUses,
  };
}

export interface ModuleImport {
  /** Local binding, or null for a side-effect import. */
  binding: string | null;
  specifier: string;
}

export function extractModuleImports(
  content: string,
  filename = "source.tsx",
): ModuleImport[] {
  const imports: ModuleImport[] = [];
  const sourceFile = ts.createSourceFile(
    filename,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filename),
  );

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.endsWith(".module.css")
    ) {
      continue;
    }
    const importClause = statement.importClause;
    const namespaceBinding = importClause?.namedBindings;
    const binding =
      importClause?.name?.text ??
      (namespaceBinding && ts.isNamespaceImport(namespaceBinding)
        ? namespaceBinding.name.text
        : null);
    imports.push({ binding, specifier: statement.moduleSpecifier.text });
  }
  return imports;
}

export interface BindingUsage {
  names: Set<string>;
  accesses: Array<{ name: string; line: number }>;
  /** The binding was used in a way that hides which selectors it reaches. */
  computed: boolean;
}

/**
 * Resolve which module selectors an importer reaches through its binding.
 *
 * Recognizes `styles.foo`, `styles?.foo`, and string-literal bracket access.
 * Any other use of the binding — a computed key, a spread, passing the object
 * to a helper — makes the module's usage unknown rather than unused.
 */
export function extractBindingUsage(
  content: string,
  binding: string,
  filename = "source.tsx",
): BindingUsage {
  const names = new Set<string>();
  const accesses: Array<{ name: string; line: number }> = [];
  let computed = false;
  const sourceFile = ts.createSourceFile(
    filename,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === binding) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        names.add(parent.name.text);
        accesses.push({
          name: parent.name.text,
          line:
            sourceFile.getLineAndCharacterOfPosition(parent.name.getStart())
              .line + 1,
        });
        return;
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const argument = parent.argumentExpression;
        if (argument && ts.isStringLiteralLike(argument)) {
          names.add(argument.text);
          accesses.push({
            name: argument.text,
            line:
              sourceFile.getLineAndCharacterOfPosition(argument.getStart())
                .line + 1,
          });
        } else {
          computed = true;
        }
        return;
      }
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
        return;
      }
      computed = true;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return { names, accesses, computed };
}

export interface SourceUsageIndex {
  /**
   * Complete whitespace-delimited source tokens, plus decoded classes from
   * selector strings, generated markup attributes, and regex literals.
   */
  exact: Map<string, Set<string>>;
  /** Template-literal prefixes such as `status-` in `status-${tone}`. */
  dynamic: Map<string, Set<string>>;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function scriptKind(filename: string): ts.ScriptKind {
  if (filename.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filename.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(filename)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function addSourceFact(
  facts: Map<string, Set<string>>,
  value: string,
  filename: string,
): void {
  const files = facts.get(value) ?? new Set<string>();
  files.add(filename);
  facts.set(value, files);
}

function addExactTokens(
  exact: Map<string, Set<string>>,
  value: string,
  filename: string,
): void {
  for (const token of value.split(/\s+/u)) {
    if (token) addSourceFact(exact, token, filename);
  }
}

function addSelectorStringTokens(
  exact: Map<string, Set<string>>,
  value: string,
  filename: string,
): void {
  const selector = value.trim();
  if (!selector.startsWith(".")) return;
  try {
    for (const token of extractSelectorClassNames(selector)) {
      addSourceFact(exact, token, filename);
    }
  } catch {
    // Most source strings are not selectors; their exact tokens still count.
  }
}

function addMarkupClassTokens(
  exact: Map<string, Set<string>>,
  value: string,
  filename: string,
): void {
  for (const match of value.matchAll(
    /\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)')/gu,
  )) {
    addExactTokens(exact, match[1] ?? match[2] ?? "", filename);
  }
}

function addSourceStringTokens(
  exact: Map<string, Set<string>>,
  value: string,
  filename: string,
): void {
  addExactTokens(exact, value, filename);
  addSelectorStringTokens(exact, value, filename);
  addMarkupClassTokens(exact, value, filename);
}

function addDynamicPrefix(
  dynamic: Map<string, Set<string>>,
  value: string,
  filename: string,
): void {
  const match = /(?:^|\s)(\S*-)$/.exec(value);
  if (match) addSourceFact(dynamic, match[1], filename);
}

/**
 * Record the class selectors a regular-expression literal spells out.
 *
 * Stylesheet-contract tests assert against CSS text with patterns such as
 * `/\.turn-image-gallery-item\s*\{/`, so their whole selector vocabulary can
 * live in regex literals and in no string literal anywhere. Without this the
 * class reads as unreferenced by that file.
 *
 * The escaped dot is the only anchor that unambiguously means "a class
 * selector": a bare `.` is the any-character metacharacter, and the rest of a
 * pattern — alternations, character classes, group names, and the trailing
 * flags — is punctuation rather than vocabulary. Matching only `\.` followed
 * by a class token keeps a regex from inventing usage for every word it
 * happens to contain. `literal` is the full literal text including its
 * delimiters and flags; a flag letter can never follow `\.`, so it needs no
 * separate stripping pass.
 */
function addRegexClassTokens(
  exact: Map<string, Set<string>>,
  literal: string,
  filename: string,
): void {
  for (let index = 0; index < literal.length; index++) {
    if (literal[index] !== "\\") continue;
    const escaped = literal[index + 1];
    // Consume the escaped character so `\\.` reads as an escaped backslash
    // followed by the any-character metacharacter, not as an escaped dot.
    index++;
    if (escaped !== ".") continue;
    const token = /^[a-zA-Z_][a-zA-Z0-9_-]*/.exec(literal.slice(index + 1));
    if (token) addSourceFact(exact, token[0], filename);
  }
}

/** Interpolation edges are fragments, not whole runtime class tokens. */
function addTemplateTokens(
  exact: Map<string, Set<string>>,
  value: string,
  filename: string,
  startsAtBoundary: boolean,
  endsAtBoundary: boolean,
): void {
  let complete = value;
  if (!startsAtBoundary) complete = complete.replace(/^\S+/u, "");
  if (!endsAtBoundary) complete = complete.replace(/\S+$/u, "");
  addSourceStringTokens(exact, complete, filename);
  // Complete quoted attributes may sit inside a template that also interpolates.
  addMarkupClassTokens(exact, value, filename);
}

/** Build an exact, comment-free source index using the TypeScript parser. */
export function buildSourceUsageIndex(
  srcFiles: Map<string, string>,
): SourceUsageIndex {
  const exact = new Map<string, Set<string>>();
  const dynamic = new Map<string, Set<string>>();

  for (const [filename, content] of srcFiles) {
    const sourceFile = ts.createSourceFile(
      filename,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(filename),
    );

    function visit(node: ts.Node): void {
      if (ts.isStringLiteralLike(node)) {
        addSourceStringTokens(exact, node.text, filename);
      }
      if (ts.isRegularExpressionLiteral(node)) {
        // Selector-only vocabulary; a regex builds no class, so it never
        // contributes a dynamic prefix.
        addRegexClassTokens(exact, node.text, filename);
      }
      if (ts.isTemplateExpression(node)) {
        addTemplateTokens(exact, node.head.text, filename, true, false);
        addDynamicPrefix(dynamic, node.head.text, filename);
        for (let index = 0; index < node.templateSpans.length; index++) {
          const literal = node.templateSpans[index].literal.text;
          addTemplateTokens(
            exact,
            literal,
            filename,
            false,
            index === node.templateSpans.length - 1,
          );
          if (index < node.templateSpans.length - 1) {
            addDynamicPrefix(dynamic, literal, filename);
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return { exact, dynamic };
}

/**
 * Build the narrower source index used to infer React ownership.
 *
 * The unused-CSS scan intentionally treats every source string as possible
 * runtime vocabulary. Ownership needs stronger evidence: a generic state,
 * role, or protocol string must not make its containing component the owner of
 * a same-named global selector. This index follows values that flow directly
 * into class-producing syntax while leaving the permissive index unchanged.
 */
export function buildClassProducerUsageIndex(
  srcFiles: Map<string, string>,
): SourceUsageIndex {
  const exact = new Map<string, Set<string>>();
  const dynamic = new Map<string, Set<string>>();
  const contentsByPath = new Map(
    Array.from(srcFiles, ([filename, content]) => [
      path.resolve(filename),
      content,
    ]),
  );
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(compilerOptions);
  host.fileExists = (filename) => contentsByPath.has(path.resolve(filename));
  host.readFile = (filename) => contentsByPath.get(path.resolve(filename));
  host.getSourceFile = (filename, languageVersion) => {
    const content = contentsByPath.get(path.resolve(filename));
    return content === undefined
      ? undefined
      : ts.createSourceFile(
          path.resolve(filename),
          content,
          languageVersion,
          true,
          scriptKind(filename),
        );
  };
  const program = ts.createProgram({
    rootNames: Array.from(contentsByPath.keys()),
    options: compilerOptions,
    host,
  });
  const checker = program.getTypeChecker();

  for (const filename of srcFiles.keys()) {
    const sourceFile = program.getSourceFile(path.resolve(filename));
    if (!sourceFile) {
      throw new Error(`Could not parse source file: ${filename}`);
    }

    const transparentClassHelpers = new Set(["classNames", "clsx", "cn", "cx"]);

    function resolveIdentifierInitializer(
      node: ts.Identifier,
      seenDeclarations: Set<ts.Symbol>,
    ): { initializer: ts.Expression; symbol: ts.Symbol } | undefined {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || seenDeclarations.has(symbol)) return undefined;
      const declaration = symbol.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration)) {
        return undefined;
      }
      if (!declaration.initializer) return undefined;
      return { initializer: declaration.initializer, symbol };
    }

    function resolveObjectLiteral(
      node: ts.Expression,
      seenDeclarations: Set<ts.Symbol>,
    ): ts.ObjectLiteralExpression | undefined {
      if (ts.isObjectLiteralExpression(node)) return node;
      if (!ts.isIdentifier(node)) return undefined;
      const binding = resolveIdentifierInitializer(node, seenDeclarations);
      if (!binding) return undefined;
      const nextSeen = new Set(seenDeclarations);
      nextSeen.add(binding.symbol);
      return resolveObjectLiteral(binding.initializer, nextSeen);
    }

    function collectObjectValue(
      object: ts.ObjectLiteralExpression,
      propertyName: string | undefined,
      seenDeclarations: Set<ts.Symbol>,
    ): void {
      for (const property of object.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spreadObject = resolveObjectLiteral(
            property.expression,
            seenDeclarations,
          );
          if (spreadObject) {
            collectObjectValue(spreadObject, propertyName, seenDeclarations);
          }
          continue;
        }
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyNameText(property.name);
        if (propertyName === undefined || name === propertyName) {
          collectClassExpression(property.initializer, seenDeclarations);
        }
      }
    }

    function collectClassHelperArgument(
      node: ts.Expression,
      seenDeclarations: Set<ts.Symbol>,
    ): void {
      const object = resolveObjectLiteral(node, seenDeclarations);
      if (object) {
        for (const property of object.properties) {
          if (ts.isPropertyAssignment(property)) {
            const name = propertyNameText(property.name);
            if (name) addExactTokens(exact, name, filename);
          } else if (ts.isShorthandPropertyAssignment(property)) {
            addExactTokens(exact, property.name.text, filename);
          } else if (ts.isSpreadAssignment(property)) {
            collectClassHelperArgument(property.expression, seenDeclarations);
          }
        }
        return;
      }
      collectClassExpression(node, seenDeclarations);
    }

    function collectClassExpression(
      node: ts.Expression,
      seenDeclarations = new Set<ts.Symbol>(),
    ): void {
      if (ts.isTemplateExpression(node)) {
        addExactTokens(exact, node.head.text, filename);
        addDynamicPrefix(dynamic, node.head.text, filename);
        for (let index = 0; index < node.templateSpans.length; index++) {
          collectClassExpression(
            node.templateSpans[index].expression,
            seenDeclarations,
          );
          const literal = node.templateSpans[index].literal.text;
          addExactTokens(exact, literal, filename);
          if (index < node.templateSpans.length - 1) {
            addDynamicPrefix(dynamic, literal, filename);
          }
        }
        return;
      }
      if (ts.isStringLiteralLike(node)) {
        addExactTokens(exact, node.text, filename);
        return;
      }
      if (ts.isIdentifier(node)) {
        const binding = resolveIdentifierInitializer(node, seenDeclarations);
        if (binding) {
          const nextSeen = new Set(seenDeclarations);
          nextSeen.add(binding.symbol);
          collectClassExpression(binding.initializer, nextSeen);
        }
        return;
      }
      if (ts.isConditionalExpression(node)) {
        collectClassExpression(node.whenTrue, seenDeclarations);
        collectClassExpression(node.whenFalse, seenDeclarations);
        return;
      }
      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
          collectClassExpression(node.right, seenDeclarations);
        } else if (
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken ||
          operator === ts.SyntaxKind.PlusToken
        ) {
          collectClassExpression(node.left, seenDeclarations);
          collectClassExpression(node.right, seenDeclarations);
        } else if (operator === ts.SyntaxKind.CommaToken) {
          collectClassExpression(node.right, seenDeclarations);
        }
        return;
      }
      if (ts.isParenthesizedExpression(node)) {
        collectClassExpression(node.expression, seenDeclarations);
        return;
      }
      if (
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isAwaitExpression(node)
      ) {
        collectClassExpression(node.expression, seenDeclarations);
        return;
      }
      if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements) {
          if (ts.isSpreadElement(element)) {
            collectClassExpression(element.expression, seenDeclarations);
          } else if (!ts.isOmittedExpression(element)) {
            collectClassExpression(element, seenDeclarations);
          }
        }
        return;
      }
      if (ts.isPropertyAccessExpression(node)) {
        const object = resolveObjectLiteral(node.expression, seenDeclarations);
        if (object) {
          collectObjectValue(object, node.name.text, seenDeclarations);
        }
        return;
      }
      if (ts.isElementAccessExpression(node)) {
        const object = resolveObjectLiteral(node.expression, seenDeclarations);
        if (object) {
          const propertyName =
            node.argumentExpression &&
            ts.isStringLiteralLike(node.argumentExpression)
              ? node.argumentExpression.text
              : undefined;
          collectObjectValue(object, propertyName, seenDeclarations);
        }
        return;
      }
      if (ts.isCallExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          transparentClassHelpers.has(node.expression.text)
        ) {
          for (const argument of node.arguments) {
            collectClassHelperArgument(argument, seenDeclarations);
          }
          return;
        }
        if (ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          if (method === "join" || method === "filter") {
            collectClassExpression(
              node.expression.expression,
              seenDeclarations,
            );
          }
        }
      }
    }

    function visit(node: ts.Node): void {
      if (ts.isJsxAttribute(node)) {
        const name = node.name.getText(sourceFile);
        if ((name === "className" || name === "class") && node.initializer) {
          if (ts.isJsxExpression(node.initializer)) {
            if (node.initializer.expression) {
              collectClassExpression(node.initializer.expression);
            }
          } else if (ts.isStringLiteralLike(node.initializer)) {
            collectClassExpression(node.initializer);
          }
        }
      }

      if (ts.isPropertyAssignment(node)) {
        const name = propertyNameText(node.name);
        if (name === "className" || name === "class") {
          collectClassExpression(node.initializer);
        }
      }

      if (
        ts.isBinaryExpression(node) &&
        ts.isPropertyAccessExpression(node.left) &&
        (node.left.name.text === "className" || node.left.name.text === "class")
      ) {
        collectClassExpression(node.right);
      }

      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        if (
          ts.isPropertyAccessExpression(receiver) &&
          receiver.name.text === "classList" &&
          ["add", "contains", "remove", "replace", "toggle"].includes(method)
        ) {
          for (const argument of node.arguments) {
            collectClassExpression(argument);
          }
        }
        if (
          method === "setAttribute" &&
          node.arguments.length >= 2 &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          ["class", "className"].includes(node.arguments[0].text)
        ) {
          collectClassExpression(node.arguments[1]);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return { exact, dynamic };
}

/** Advisory ownership evidence for css:inventory; never global liveness. */
export function findDynamicUsage(
  className: string,
  sourceIndex: SourceUsageIndex,
): string[] {
  const files = new Set<string>();
  for (const [prefix, origins] of sourceIndex.dynamic) {
    if (!className.startsWith(prefix)) continue;
    for (const file of origins) files.add(file);
  }
  return Array.from(files);
}

export interface RuntimeClassFamily {
  pattern: string;
  source: string;
  reason: string;
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const clientSourceRoot = path.join(repoRoot, "packages/client/src");

/** Families are reviewed evidence, never inferred from arbitrary templates. */
export function validateRuntimeFamilies(
  families: RuntimeClassFamily[],
  globalNames: Iterable<string>,
): Map<string, Set<string>> {
  const names = [...globalNames];
  const usage = new Map<string, Set<string>>();
  for (const family of families) {
    if (
      !family.pattern?.startsWith("^") ||
      !family.pattern.endsWith("$") ||
      !family.source ||
      !family.reason?.trim()
    ) {
      throw new Error(`Invalid CSS runtime family: ${JSON.stringify(family)}`);
    }
    const source = path.resolve(repoRoot, family.source);
    if (
      !source.startsWith(`${repoRoot}${path.sep}`) ||
      !fs.existsSync(source) ||
      !fs.statSync(source).isFile()
    ) {
      throw new Error(
        `CSS runtime family ${family.pattern}: source does not exist: ${family.source}`,
      );
    }
    const pattern = new RegExp(`^(?:${family.pattern})$`, "u");
    const matches = names.filter((name) => pattern.test(name));
    if (matches.length === 0) {
      throw new Error(
        `CSS runtime family ${family.pattern}: matches no global class; remove the stale family`,
      );
    }
    for (const name of matches) addSourceFact(usage, name, family.source);
  }
  return usage;
}

function resolveSpecifier(fromFile: string, specifier: string): string {
  return path.resolve(path.dirname(fromFile), specifier);
}

export function analyze(
  options: Pick<Options, "cssDir" | "srcDir"> & {
    families?: RuntimeClassFamily[];
  },
): {
  result: AnalysisResult;
  srcContents: Map<string, string>;
} {
  const cssFiles = findFiles(options.cssDir, [".css"]);
  const moduleFiles = cssFiles.filter(isModuleStylesheet);
  const globalCssFiles = cssFiles.filter((file) => !isModuleStylesheet(file));

  const srcFiles = findSourceFiles(options.srcDir, [
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
    ".mjs",
    ".cjs",
  ]);
  const srcContents = new Map<string, string>();
  for (const file of srcFiles) {
    srcContents.set(file, fs.readFileSync(file, "utf-8"));
  }

  // --- Module analysis -----------------------------------------------------
  // Selectors are resolved per module file, so identically named classes in
  // different modules stay distinct.
  const moduleReports = new Map<string, ModuleReport>();
  const moduleContents = new Map<string, string>();
  for (const file of moduleFiles) {
    const content = fs.readFileSync(file, "utf-8");
    moduleContents.set(path.resolve(file), content);
    const { selectors, globalRefs, globalUses } = extractModuleSelectors(
      content,
      file,
    );
    moduleReports.set(path.resolve(file), {
      cssFile: file,
      importers: [],
      productionImporters: [],
      testImporters: [],
      productionReachable: false,
      composers: [],
      selectors,
      unused: [],
      productionUnused: [],
      testOnly: [],
      undeclared: [],
      globalRefs,
      globalUses,
      globalIssues: [],
      unknownReasons: [],
      unknownUsage: [],
    });
  }

  // Names reached from source files, plus names composed from other modules.
  const productionReachedNames = new Map<string, Map<string, Set<string>>>();
  const testReachedNames = new Map<string, Map<string, Set<string>>>();
  const noteReached = (
    index: Map<string, Map<string, Set<string>>>,
    modulePath: string,
    name: string,
    origin: string,
  ): void => {
    let byName = index.get(modulePath);
    if (!byName) {
      byName = new Map();
      index.set(modulePath, byName);
    }
    const origins = byName.get(name) ?? new Set<string>();
    origins.add(origin);
    byName.set(name, origins);
  };
  const undeclared = new Map<
    string,
    Map<string, { productionUsedIn: Set<string>; testUsedIn: Set<string> }>
  >();
  const noteUndeclared = (
    modulePath: string,
    name: string,
    origin: string,
    test: boolean,
  ): void => {
    let byName = undeclared.get(modulePath);
    if (!byName) {
      byName = new Map();
      undeclared.set(modulePath, byName);
    }
    const usage = byName.get(name) ?? {
      productionUsedIn: new Set<string>(),
      testUsedIn: new Set<string>(),
    };
    (test ? usage.testUsedIn : usage.productionUsedIn).add(origin);
    byName.set(name, usage);
  };

  for (const [srcFile, content] of srcContents) {
    for (const { binding, specifier } of extractModuleImports(
      content,
      srcFile,
    )) {
      const resolved = resolveSpecifier(srcFile, specifier);
      const report = moduleReports.get(resolved);
      if (!report) continue;

      report.importers.push(srcFile);
      const test = isTestSourceFile(srcFile);
      (test ? report.testImporters : report.productionImporters).push(srcFile);

      if (!binding) {
        report.unknownReasons.push("side-effect-import");
        report.unknownUsage.push({
          reason: "side-effect-import",
          file: srcFile,
        });
        continue;
      }

      const usage = extractBindingUsage(content, binding, srcFile);
      if (usage.computed) {
        report.unknownReasons.push("computed-access");
        report.unknownUsage.push({ reason: "computed-access", file: srcFile });
      }
      const declared = new Set(
        report.selectors.map((selector) => selector.name),
      );
      for (const access of usage.accesses) {
        const origin = `${srcFile}:${access.line}`;
        if (!declared.has(access.name)) {
          noteUndeclared(resolved, access.name, origin, test);
          continue;
        }
        noteReached(
          test ? testReachedNames : productionReachedNames,
          resolved,
          access.name,
          srcFile,
        );
      }
    }
  }

  const localComposes = new Map<string, string[]>();
  const externalComposes: Array<{
    source: string;
    target: string;
    names: string[];
  }> = [];
  for (const [modulePath, content] of moduleContents) {
    const composes = extractComposes(content);
    localComposes.set(modulePath, composes.local);
    for (const { specifier, names } of composes.external) {
      const resolved = resolveSpecifier(modulePath, specifier);
      const target = moduleReports.get(resolved);
      if (!target) continue;
      target.composers.push(path.relative(process.cwd(), modulePath));
      externalComposes.push({ source: modulePath, target: resolved, names });
    }
  }

  const productionReachable = new Set(
    Array.from(moduleReports.entries())
      .filter(([, report]) => report.productionImporters.length > 0)
      .map(([modulePath]) => modulePath),
  );
  const testReachable = new Set(
    Array.from(moduleReports.entries())
      .filter(([, report]) => report.testImporters.length > 0)
      .map(([modulePath]) => modulePath),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of externalComposes) {
      if (
        productionReachable.has(edge.source) &&
        !productionReachable.has(edge.target)
      ) {
        productionReachable.add(edge.target);
        changed = true;
      }
      if (testReachable.has(edge.source) && !testReachable.has(edge.target)) {
        testReachable.add(edge.target);
        changed = true;
      }
    }
  }

  for (const [modulePath, names] of localComposes) {
    const declared = new Set(
      moduleReports.get(modulePath)?.selectors.map((selector) => selector.name),
    );
    for (const name of names) {
      const origin = `${path.basename(modulePath)} (composes)`;
      if (!declared.has(name)) {
        if (productionReachable.has(modulePath)) {
          noteUndeclared(modulePath, name, origin, false);
        }
        if (testReachable.has(modulePath)) {
          noteUndeclared(modulePath, name, origin, true);
        }
        continue;
      }
      if (productionReachable.has(modulePath)) {
        noteReached(productionReachedNames, modulePath, name, origin);
      }
      if (testReachable.has(modulePath)) {
        noteReached(testReachedNames, modulePath, name, origin);
      }
    }
  }

  for (const edge of externalComposes) {
    const declared = new Set(
      moduleReports
        .get(edge.target)
        ?.selectors.map((selector) => selector.name),
    );
    for (const name of edge.names) {
      const origin = `${path.basename(edge.source)} (composes from)`;
      if (!declared.has(name)) {
        if (productionReachable.has(edge.source)) {
          noteUndeclared(edge.target, name, origin, false);
        }
        if (testReachable.has(edge.source)) {
          noteUndeclared(edge.target, name, origin, true);
        }
        continue;
      }
      if (productionReachable.has(edge.source)) {
        noteReached(productionReachedNames, edge.target, name, origin);
      }
      if (testReachable.has(edge.source)) {
        noteReached(testReachedNames, edge.target, name, origin);
      }
    }
  }

  const moduleUnused: ClassInfo[] = [];
  const moduleProductionUnused: ModuleSelectorInfo[] = [];
  for (const [modulePath, report] of moduleReports) {
    report.productionReachable = productionReachable.has(modulePath);
    report.unknownReasons = Array.from(new Set(report.unknownReasons));
    report.unknownUsage = report.unknownUsage.filter(
      (usage, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.reason === usage.reason && candidate.file === usage.file,
        ) === index,
    );
    const productionByName = productionReachedNames.get(modulePath);
    const testByName = testReachedNames.get(modulePath);
    for (const selector of report.selectors) {
      selector.productionUsedIn = Array.from(
        productionByName?.get(selector.name) ?? [],
      );
      selector.testUsedIn = Array.from(testByName?.get(selector.name) ?? []);
      selector.usedIn = Array.from(
        new Set([...selector.productionUsedIn, ...selector.testUsedIn]),
      );
    }
    report.undeclared = Array.from(
      undeclared.get(modulePath)?.entries() ?? [],
      ([name, usage]) => ({
        name,
        productionUsedIn: Array.from(usage.productionUsedIn),
        testUsedIn: Array.from(usage.testUsedIn),
      }),
    ).sort((a, b) => a.name.localeCompare(b.name));
    if (report.unknownReasons.length > 0) {
      continue;
    }
    report.unused = report.selectors.filter(
      (selector) => selector.usedIn.length === 0,
    );
    report.productionUnused = report.selectors.filter(
      (selector) => selector.productionUsedIn.length === 0,
    );
    report.testOnly = report.productionUnused.filter(
      (selector) => selector.testUsedIn.length > 0,
    );
    moduleUnused.push(...report.unused);
    moduleProductionUnused.push(...report.productionUnused);
  }

  // --- Global analysis -----------------------------------------------------
  // Global stylesheets share one namespace, so classes stay deduplicated by
  // name across files, as before.
  const allGlobalClasses: ClassInfo[] = [];
  for (const cssFile of globalCssFiles) {
    const content = fs.readFileSync(cssFile, "utf-8");
    allGlobalClasses.push(...extractClassSelectors(content, cssFile));
  }

  const uniqueGlobalClasses = new Map<string, ClassInfo>();
  for (const cls of allGlobalClasses) {
    if (!uniqueGlobalClasses.has(cls.name)) {
      uniqueGlobalClasses.set(cls.name, cls);
    }
  }

  for (const report of moduleReports.values()) {
    report.globalIssues = report.globalUses.flatMap((use) => {
      const issues: ModuleGlobalIssue[] = [];
      if (use.localAnchors.length === 0) {
        issues.push({ ...use, issue: "unanchored-global" });
      }
      if (!uniqueGlobalClasses.has(use.name)) {
        issues.push({ ...use, issue: "missing-global" });
      }
      return issues;
    });
  }

  // Only production-reachable module interop is usage of global vocabulary.
  const globalRefsFromModules = new Map<string, string[]>();
  for (const report of moduleReports.values()) {
    if (!report.productionReachable) continue;
    for (const name of report.globalRefs) {
      const files = globalRefsFromModules.get(name) ?? [];
      files.push(report.cssFile);
      globalRefsFromModules.set(name, files);
    }
  }

  const packageScan =
    path.basename(path.resolve(options.srcDir)) === "packages";
  const productionRoot = packageScan
    ? path.resolve(options.srcDir, "client/src")
    : path.resolve(options.srcDir);
  const productionSources = new Map(
    [...srcContents].filter(
      ([file]) =>
        !isTestSourceFile(file) &&
        (!packageScan ||
          path.resolve(file).startsWith(`${productionRoot}${path.sep}`)),
    ),
  );
  const sourceIndex = buildSourceUsageIndex(productionSources);
  const runtimeFamilies: RuntimeClassFamily[] =
    options.families ??
    (path.resolve(options.cssDir) === clientSourceRoot
      ? JSON.parse(
          fs.readFileSync(
            path.join(repoRoot, "scripts/css-runtime-families.json"),
            "utf8",
          ),
        )
      : []);
  const familyUsage = validateRuntimeFamilies(
    runtimeFamilies,
    uniqueGlobalClasses.keys(),
  );
  const globalUsed: ClassInfo[] = [];
  const globalUnused: ClassInfo[] = [];

  for (const cls of uniqueGlobalClasses.values()) {
    cls.usedIn = [
      ...(sourceIndex.exact.get(cls.name) ?? []),
      ...(familyUsage.get(cls.name) ?? []),
      ...(globalRefsFromModules.get(cls.name) ?? []),
    ];
    if (cls.usedIn.length === 0) {
      globalUnused.push(cls);
    } else {
      globalUsed.push(cls);
    }
  }

  return {
    result: {
      globalClasses: Array.from(uniqueGlobalClasses.values()),
      globalUsed,
      globalUnused,
      modules: Array.from(moduleReports.values()).sort((a, b) =>
        a.cssFile.localeCompare(b.cssFile),
      ),
      moduleUnused,
      moduleProductionUnused,
      runtimeFamilies,
      cssFileCount: globalCssFiles.length,
      moduleFileCount: moduleFiles.length,
      srcFileCount: srcFiles.length,
    },
    srcContents,
  };
}

/** Prune only selector-list branches that require an unused global class. */
export function pruneUnusedGlobalRules(
  content: string,
  unusedNames: Set<string>,
): { css: string; removed: number; skippedClasses: string[] } {
  const root = postcss.parse(content);
  let removed = 0;
  const skippedClasses = new Set<string>();
  root.walkRules((rule) => {
    const selectors = selectorParser().astSync(rule.selector);
    const deadBranches = selectors.nodes.filter((branch) => {
      let dead = false;
      branch.walkClasses((node) => {
        if (!unusedNames.has(node.value)) return;
        // Negation/alternation is not evidence the entire branch is dead.
        // Leave such selectors for deliberate review rather than changing logic.
        if (node.parent !== branch) skippedClasses.add(node.value);
        else dead = true;
      });
      return dead;
    });
    if (deadBranches.length === 0) return;
    removed += deadBranches.length;
    if (deadBranches.length === selectors.nodes.length) {
      const parent = rule.parent;
      rule.remove();
      // Remove only containers emptied by this deletion, never unrelated ones.
      let empty = parent;
      while (empty?.type === "atrule" && empty.nodes?.length === 0) {
        const next = empty.parent;
        empty.remove();
        empty = next;
      }
    } else {
      for (const branch of deadBranches) branch.remove();
      rule.selector = selectors.toString().trim();
    }
  });
  return { css: root.toString(), removed, skippedClasses: [...skippedClasses] };
}

interface RemovalResult {
  file: string;
  removed: number;
  skipped: number;
  skippedClasses: string[];
}

/** All occurrences are pruned, including duplicate names in other files. */
function removeUnusedRules(
  cssDir: string,
  unusedNames: Set<string>,
  dryRun: boolean,
): RemovalResult[] {
  return findFiles(cssDir, [".css"])
    .filter((file) => !isModuleStylesheet(file))
    .map((file) => {
      const content = fs.readFileSync(file, "utf8");
      const result = pruneUnusedGlobalRules(content, unusedNames);
      if (!dryRun && result.css !== content) fs.writeFileSync(file, result.css);
      return {
        file,
        removed: result.removed,
        skipped: result.skippedClasses.length,
        skippedClasses: result.skippedClasses,
      };
    });
}

const UNKNOWN_REASON_TEXT: Record<ModuleUnknownReason, string> = {
  "side-effect-import": "imported for side effects without a binding",
  "computed-access": "reached through a computed key",
};

export type ModuleContractIssueKind =
  | "computed-access"
  | "missing-global"
  | "no-production-importer"
  | "production-unused-selector"
  | "side-effect-import"
  | "test-only-selector"
  | "unanchored-global"
  | "undeclared-selector";

export interface ModuleContractIssue {
  kind: ModuleContractIssueKind;
  file: string;
  name?: string;
  line?: number;
  detail: string;
}

export function moduleContractIssues(
  result: AnalysisResult,
): ModuleContractIssue[] {
  const issues: ModuleContractIssue[] = [];
  for (const report of result.modules) {
    if (!report.productionReachable) {
      issues.push({
        kind: "no-production-importer",
        file: report.cssFile,
        detail: "no production source imports or composes this module",
      });
    }
    for (const usage of report.unknownUsage) {
      issues.push({
        kind: usage.reason,
        file: report.cssFile,
        detail: `${UNKNOWN_REASON_TEXT[usage.reason]} in ${usage.file}`,
      });
    }
    for (const access of report.undeclared) {
      const origins = [...access.productionUsedIn, ...access.testUsedIn].join(
        ", ",
      );
      issues.push({
        kind: "undeclared-selector",
        file: report.cssFile,
        name: access.name,
        detail: `styles.${access.name} has no local selector (${origins})`,
      });
    }
    const testOnlyNames = new Set(
      report.testOnly.map((selector) => selector.name),
    );
    for (const selector of report.productionUnused) {
      const testOnly = testOnlyNames.has(selector.name);
      issues.push({
        kind: testOnly ? "test-only-selector" : "production-unused-selector",
        file: report.cssFile,
        name: selector.name,
        line: selector.line,
        detail: testOnly
          ? `.${selector.name} is reached only by tests`
          : `.${selector.name} has no production usage`,
      });
    }
    for (const issue of report.globalIssues) {
      issues.push({
        kind: issue.issue,
        file: report.cssFile,
        name: issue.name,
        line: issue.line,
        detail:
          issue.issue === "missing-global"
            ? `:global(.${issue.name}) does not exist in an authored global stylesheet`
            : `:global(.${issue.name}) has no module-local class anchor`,
      });
    }
  }
  return issues;
}

function describeUnknown(report: ModuleReport): string {
  return Array.from(new Set(report.unknownReasons))
    .map((reason) => UNKNOWN_REASON_TEXT[reason])
    .join("; ");
}

function moduleJson(report: ModuleReport): Record<string, unknown> {
  return {
    file: report.cssFile,
    importers: report.importers,
    productionImporters: report.productionImporters,
    testImporters: report.testImporters,
    productionReachable: report.productionReachable,
    composers: report.composers,
    unknownReasons: report.unknownReasons,
    unknownUsage: report.unknownUsage,
    undeclared: report.undeclared,
    globalRefs: report.globalRefs,
    globalUses: report.globalUses,
    globalIssues: report.globalIssues,
    unused: report.unused.map((selector) => ({
      name: selector.name,
      line: selector.line,
    })),
    productionUnused: report.productionUnused.map((selector) => ({
      name: selector.name,
      line: selector.line,
    })),
    testOnly: report.testOnly.map((selector) => ({
      name: selector.name,
      line: selector.line,
      testUsedIn: selector.testUsedIn,
    })),
    selectors: report.selectors.map((selector) => ({
      name: selector.name,
      line: selector.line,
      productionUsedIn: selector.productionUsedIn,
      testUsedIn: selector.testUsedIn,
    })),
  };
}

function main() {
  const options = parseArgs();

  let analysis: ReturnType<typeof analyze>;
  try {
    analysis = analyze(options);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const { result } = analysis;

  if (result.cssFileCount + result.moduleFileCount === 0) {
    console.error(`No CSS files found in: ${options.cssDir}`);
    process.exit(1);
  }
  if (result.srcFileCount === 0) {
    console.error(`No source files found in: ${options.srcDir}`);
    process.exit(1);
  }

  const unknownModules = result.modules.filter(
    (report) => report.unknownReasons.length > 0,
  );

  if (options.modulesCheck) {
    const issues = moduleContractIssues(result);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            summary: {
              modules: result.moduleFileCount,
              selectors: result.modules.reduce(
                (total, report) => total + report.selectors.length,
                0,
              ),
              globalInterop: result.modules.reduce(
                (total, report) => total + report.globalUses.length,
                0,
              ),
              issues: issues.length,
            },
            issues,
            modules: result.modules.map(moduleJson),
          },
          null,
          2,
        ),
      );
    } else if (issues.length === 0) {
      const selectorCount = result.modules.reduce(
        (total, report) => total + report.selectors.length,
        0,
      );
      const globalInterop = result.modules.reduce(
        (total, report) => total + report.globalUses.length,
        0,
      );
      console.log(
        `CSS Module contracts: ${result.moduleFileCount} modules, ${selectorCount} selectors, ${globalInterop} reviewed global interop references; no issues`,
      );
    } else {
      console.error(`CSS Module contract issues (${issues.length}):`);
      for (const issue of issues) {
        const location = `${issue.file}${issue.line ? `:${issue.line}` : ""}`;
        console.error(`  ${location} [${issue.kind}] ${issue.detail}`);
      }
    }
    process.exitCode = issues.length > 0 ? 1 : 0;
    return;
  }

  if (options.json) {
    const removals =
      options.remove || options.dryRun
        ? removeUnusedRules(
            options.cssDir,
            new Set(result.globalUnused.map((cls) => cls.name)),
            options.dryRun,
          )
        : undefined;
    console.log(
      JSON.stringify(
        {
          removals,
          summary: {
            totalClasses: result.globalClasses.length,
            usedClasses: result.globalUsed.length,
            unusedClasses: result.globalUnused.length,
            runtimeFamilies: result.runtimeFamilies.length,
            cssFiles: result.cssFileCount,
            srcFiles: result.srcFileCount,
            moduleFiles: result.moduleFileCount,
            moduleSelectors: result.modules.reduce(
              (total, report) => total + report.selectors.length,
              0,
            ),
            unusedModuleSelectors: result.moduleUnused.length,
            productionUnusedModuleSelectors:
              result.moduleProductionUnused.length,
            unknownModules: unknownModules.length,
            moduleContractIssues: moduleContractIssues(result).length,
          },
          unused: result.globalUnused.map((c) => ({
            name: c.name,
            file: c.cssFile,
            line: c.line,
          })),
          modules: result.modules.map((report) => ({
            ...moduleJson(report),
            ...(!options.verbose ? { selectors: undefined } : {}),
          })),
          ...(options.verbose
            ? {
                used: result.globalUsed.map((c) => ({
                  name: c.name,
                  file: c.cssFile,
                  line: c.line,
                  usedIn: c.usedIn,
                })),
              }
            : {}),
        },
        null,
        2,
      ),
    );
    process.exitCode = exitCode(
      options.remove && !options.dryRun ? analyze(options).result : result,
      options,
    );
    return;
  }

  console.log(
    `Found ${result.globalClasses.length} unique global class selectors in ${result.cssFileCount} global stylesheets`,
  );
  console.log(
    `Found ${result.modules.reduce((total, r) => total + r.selectors.length, 0)} module selectors in ${result.moduleFileCount} CSS Modules`,
  );
  console.log(`Searching ${result.srcFileCount} source files...`);
  console.log(
    `Reviewed runtime/generated families: ${result.runtimeFamilies.length}`,
  );
  console.log();

  // Group unused global classes by CSS file
  const byFile = new Map<string, ClassInfo[]>();
  for (const cls of result.globalUnused) {
    const existing = byFile.get(cls.cssFile) || [];
    existing.push(cls);
    byFile.set(cls.cssFile, existing);
  }

  if (result.globalUnused.length === 0) {
    console.log("No unused global classes found!");
  } else {
    console.log(`Found ${result.globalUnused.length} unused global classes:\n`);

    for (const [file, classes] of byFile) {
      const relPath = path.relative(process.cwd(), file);
      console.log(`${relPath} (${classes.length} unused):`);
      for (const cls of classes.sort((a, b) => a.line - b.line)) {
        console.log(`  Line ${cls.line}: .${cls.name}`);
      }
      console.log();
    }
  }

  console.log("CSS Modules:");
  if (result.moduleFileCount === 0) {
    console.log("  (none)");
  }
  for (const report of result.modules) {
    const relPath = path.relative(process.cwd(), report.cssFile);
    if (report.unknownReasons.length > 0) {
      console.log(`  ${relPath}: usage unknown — ${describeUnknown(report)}`);
      continue;
    }
    if (report.productionUnused.length === 0) {
      if (options.verbose) {
        console.log(
          `  ${relPath}: all ${report.selectors.length} selectors used by production`,
        );
      }
      continue;
    }
    console.log(
      `  ${relPath} (${report.productionUnused.length} production-unused):`,
    );
    const testOnly = new Set(report.testOnly.map((selector) => selector.name));
    for (const cls of report.productionUnused.sort((a, b) => a.line - b.line)) {
      console.log(
        `    Line ${cls.line}: .${cls.name}${testOnly.has(cls.name) ? " (test only)" : ""}`,
      );
    }
  }
  console.log();

  console.log("---");
  console.log(
    `Summary: ${result.globalUsed.length} used, ${result.globalUnused.length} unused out of ${result.globalClasses.length} global classes`,
  );
  console.log(
    `         ${result.moduleProductionUnused.length} production-unused module selectors; ${unknownModules.length} module${unknownModules.length === 1 ? "" : "s"} with undetermined usage`,
  );

  if (options.verbose && result.globalUsed.length > 0) {
    console.log("\nUsed global classes:");
    for (const cls of result.globalUsed) {
      console.log(
        `  .${cls.name} -> ${cls.usedIn.map((f) => path.relative(process.cwd(), f)).join(", ")}`,
      );
    }
  }

  // Handle removal if requested
  if (
    (options.remove || options.dryRun) &&
    (result.globalUnused.length > 0 || result.moduleProductionUnused.length > 0)
  ) {
    console.log(
      options.dryRun
        ? "\n[DRY RUN] Would remove:"
        : "\nRemoving unused rules...",
    );

    const results = removeUnusedRules(
      options.cssDir,
      new Set(result.globalUnused.map((cls) => cls.name)),
      options.dryRun,
    );

    let totalRemoved = 0;
    let totalSkipped = 0;

    for (const removal of results) {
      const relPath = path.relative(process.cwd(), removal.file);
      if (removal.removed > 0 || removal.skipped > 0) {
        console.log(
          `  ${relPath}: ${removal.removed} removed, ${removal.skipped} skipped`,
        );
        if (removal.skippedClasses.length > 0 && options.verbose) {
          console.log(
            `    Skipped (nested selectors): ${removal.skippedClasses.join(", ")}`,
          );
        }
      }
      totalRemoved += removal.removed;
      totalSkipped += removal.skipped;
    }

    console.log(
      `\n${options.dryRun ? "Would remove" : "Removed"} ${totalRemoved} selector branches, skipped ${totalSkipped} (nested selectors)`,
    );
    if (result.moduleProductionUnused.length > 0) {
      console.log(
        `Left ${result.moduleProductionUnused.length} module selector${result.moduleProductionUnused.length === 1 ? "" : "s"} in place; delete module rules in the owning component.`,
      );
    }
  }

  process.exit(
    exitCode(
      options.remove && !options.dryRun ? analyze(options).result : result,
      options,
    ),
  );
}

function exitCode(result: AnalysisResult, _options: Options): number {
  const globalOutstanding = result.globalUnused.length;
  return globalOutstanding + moduleContractIssues(result).length > 0 ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
