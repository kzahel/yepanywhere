import ts from "typescript";
import type { ServerCapabilityDefinition } from "../packages/shared/src/server-capability-definition.js";
import {
  COMPATIBILITY_LIFETIME_DAYS,
  parseAuditDate,
} from "./compatibility-sunsets.js";

const DAY_MS = 86_400_000;
type Definitions = Readonly<Record<string, ServerCapabilityDefinition>>;
export interface CapabilitySource {
  path: string;
  source: string;
}
export interface CapabilityInventoryRow {
  name: string;
  introducedIn: string;
  description: string;
  lifecycleReason: string | null;
  lifecycle: string;
  classification: "fixed" | "optional" | "scoped" | "retired";
  firstRelease: string | null;
  supportedSince: string | null;
  ageDays: number | null;
  expiresOn: string | null;
  expired: boolean;
  locations: string[];
  fallback: string;
}

function versionParts(value: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(value))
    throw new Error(`Invalid stable capability version ${value}.`);
  return value.split(".").map(Number);
}
function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (const i of [0, 1, 2]) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

/** Follow registry lookups and imported constant aliases, excluding comments and unused imports. */
export function findClientCapabilityReferences(
  definitions: Definitions,
  registrySource: string,
  sources: readonly CapabilitySource[],
): Map<string, string[]> {
  const constants = new Map<string, string>();
  const registry = ts.createSourceFile(
    "registry.ts",
    registrySource,
    ts.ScriptTarget.Latest,
    true,
  );
  const registryCapability = (
    node: ts.Node,
    aliases: Set<string>,
  ): string | undefined => {
    if (
      ts.isPropertyAccessExpression(node) &&
      aliases.has(node.expression.getText())
    )
      return definitions[node.name.text]?.name;
    if (
      ts.isElementAccessExpression(node) &&
      aliases.has(node.expression.getText()) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      return definitions[node.argumentExpression.text]?.name;
    }
    return undefined;
  };
  const discoverConstant = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      node.initializer.name.text === "name"
    ) {
      const name = registryCapability(
        node.initializer.expression,
        new Set(["SERVER_CAPABILITIES"]),
      );
      if (name) constants.set(node.name.text, name);
    }
    ts.forEachChild(node, discoverConstant);
  };
  discoverConstant(registry);

  const references = new Map<string, Set<string>>();
  for (const source of sources) {
    const file = ts.createSourceFile(
      source.path,
      source.source,
      ts.ScriptTarget.Latest,
      true,
    );
    const imported = new Map<string, string>();
    const aliases = new Set<string>();
    const namespaces = new Set<string>();
    for (const statement of file.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        statement.importClause?.isTypeOnly
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
        aliases.add(`${bindings.name.text}.SERVER_CAPABILITIES`);
      }
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly) continue;
        const exported = binding.propertyName?.text ?? binding.name.text;
        if (exported === "SERVER_CAPABILITIES") aliases.add(binding.name.text);
        const name = constants.get(exported);
        if (name) imported.set(binding.name.text, name);
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) return;
      const name =
        registryCapability(node, aliases) ??
        (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text)
          ? constants.get(node.name.text)
          : undefined) ??
        (ts.isIdentifier(node) ? imported.get(node.text) : undefined);
      if (name) {
        const line =
          file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        const locations = references.get(name) ?? new Set<string>();
        locations.add(`${source.path}:${line}`);
        references.set(name, locations);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return new Map(
    [...references].map(([name, locations]) => [name, [...locations].sort()]),
  );
}

/** Enumerate every registry entry; the lifecycle label never exempts a fixed feature. */
export function auditCapabilityInventory(
  definitions: Definitions,
  calendar: {
    stableReleases: Record<string, string>;
    sourceIntroductions: Record<string, string>;
  },
  references: ReadonlyMap<string, string[]>,
  asOf: string,
): { rows: CapabilityInventoryRow[]; errors: string[] } {
  const today = parseAuditDate(asOf);
  const releases = Object.entries(calendar.stableReleases)
    .map(([version, date]) => {
      versionParts(version);
      const time = parseAuditDate(date);
      if (time > today)
        throw new Error(`Stable release ${version} has future date ${date}.`);
      return { version, date, time };
    })
    .sort((a, b) => a.time - b.time || compareVersions(a.version, b.version));
  if (releases.length === 0)
    throw new Error("Capability release calendar is empty.");
  const known = new Set(Object.values(definitions).map(({ name }) => name));
  for (const [name, date] of Object.entries(calendar.sourceIntroductions)) {
    if (!known.has(name))
      throw new Error(`Unknown capability source introduction ${name}.`);
    if (parseAuditDate(date) > today)
      throw new Error(`${name} has future source introduction ${date}.`);
  }
  const rows: CapabilityInventoryRow[] = [];
  const errors: string[] = [];
  for (const capability of Object.values(definitions)) {
    const classification = capability.retired
      ? "retired"
      : capability.advertisement.kind === "version-implied"
        ? "fixed"
        : capability.advertisement.kind === "optional-bit"
          ? "optional"
          : "scoped";
    const release = releases.find(
      ({ version }) => compareVersions(version, capability.introducedIn) >= 0,
    );
    const sourceDate = calendar.sourceIntroductions[capability.name];
    const sourceTime = sourceDate ? parseAuditDate(sourceDate) : null;
    const since =
      sourceTime !== null && (!release || sourceTime < release.time)
        ? sourceDate
        : release?.date;
    const time = since ? parseAuditDate(since) : null;
    const expires =
      time === null ? null : time + COMPATIBILITY_LIFETIME_DAYS * DAY_MS;
    const locations = references.get(capability.name) ?? [];
    const expired =
      classification === "fixed" &&
      expires !== null &&
      expires <= today &&
      locations.length > 0;
    const row: CapabilityInventoryRow = {
      name: capability.name,
      introducedIn: capability.introducedIn,
      description: capability.description,
      lifecycleReason:
        capability.lifecycle.kind === "permanent"
          ? capability.lifecycle.reason
          : null,
      lifecycle: capability.kind,
      classification,
      firstRelease: release?.version ?? null,
      supportedSince: since ?? null,
      ageDays: time === null ? null : (today - time) / DAY_MS,
      expiresOn:
        classification === "fixed" && expires !== null
          ? new Date(expires).toISOString().slice(0, 10)
          : null,
      expired,
      locations,
      fallback: capability.clientFallback,
    };
    rows.push(row);
    if (classification === "fixed" && !since) {
      errors.push(
        `${row.name} has no released baseline or source introduction date; add its source date before shipping a compatibility gate.`,
      );
    }
    if (classification === "retired" && locations.length > 0) {
      errors.push(
        `${row.name} is marked retired but still has client references: ${locations.join(", ")}.`,
      );
    }
    if (expired) {
      errors.push(
        `${row.name} EXPIRED ${row.expiresOn} (${row.ageDays} days old, ${row.lifecycle}). Remove the fixed-version client gate and fallback by standing policy; keep its ID and server advertisement. Locations: ${locations.join(", ")}.`,
      );
    }
  }
  rows.sort(
    (a, b) =>
      (b.ageDays ?? -1) - (a.ageDays ?? -1) || a.name.localeCompare(b.name),
  );
  return { rows, errors };
}
