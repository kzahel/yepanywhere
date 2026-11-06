import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_ID_ALLOCATIONS,
  CAPABILITY_ID_ENCODING_INTRODUCED_IN,
} from "../packages/shared/src/capability-ids.js";
import { SERVER_CAPABILITIES } from "../packages/shared/src/server-capabilities.js";
import type { ServerCapabilityDefinition } from "../packages/shared/src/server-capability-definition.js";
import { OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS } from "../packages/shared/src/server-capability-optional-bits.js";
import {
  auditCompatibilitySunsets,
  parseAuditDate,
} from "./compatibility-sunsets.js";
import {
  auditCapabilityInventory,
  type CapabilitySource,
  findClientCapabilityReferences,
} from "./capability-inventory.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const RUNTIME_SOURCE_ROOTS = [
  "packages/client/src",
  "packages/server/src",
] as const;
const ROUTE_DECLARATION =
  /\broutes\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;

interface AuditFinding {
  kind: "error" | "warning";
  message: string;
}

interface RouteSignature {
  method: string;
  path: string;
}

const capabilities = Object.values(
  SERVER_CAPABILITIES,
) as ServerCapabilityDefinition[];
const findings: AuditFinding[] = [];
const clientSources: CapabilitySource[] = [];
const args = process.argv.slice(2);
let asOf = new Date().toISOString().slice(0, 10);
let json = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--json") json = true;
  else if (args[index] === "--as-of" && args[index + 1])
    asOf = args[++index] ?? asOf;
  else
    throw new Error(
      "Usage: pnpm capabilities:audit [--as-of YYYY-MM-DD] [--json]",
    );
}
parseAuditDate(asOf);

await auditOwnedRouteModules();
await auditRawCapabilityChecks();
auditCapabilityAdvertisements();
const references = findClientCapabilityReferences(
  SERVER_CAPABILITIES,
  await readFile(
    path.join(REPO_ROOT, "packages/shared/src/server-capabilities.ts"),
    "utf8",
  ),
  clientSources,
);
const inventory = auditCapabilityInventory(
  SERVER_CAPABILITIES,
  JSON.parse(
    await readFile(
      path.join(REPO_ROOT, "scripts/capability-releases.json"),
      "utf8",
    ),
  ),
  references,
  asOf,
);
findings.push(
  ...inventory.errors.map((message) => ({ kind: "error" as const, message })),
);
const sunsets = await auditCompatibilitySunsets(
  JSON.parse(
    await readFile(
      path.join(REPO_ROOT, "scripts/compatibility-sunsets.json"),
      "utf8",
    ),
  ),
  capabilities,
  (file) => readFile(path.join(REPO_ROOT, file), "utf8"),
  asOf,
);
findings.push(
  ...sunsets.errors.map((message) => ({ kind: "error" as const, message })),
);

const errors = findings.filter((finding) => finding.kind === "error");
const warnings = findings.filter((finding) => finding.kind === "warning");
if (json) {
  console.log(
    JSON.stringify(
      { asOf, inventory: inventory.rows, sunsets: sunsets.deadlines, findings },
      null,
      2,
    ),
  );
} else {
  for (const row of inventory.rows) {
    console.log(
      `${row.expired ? "EXPIRED" : row.classification === "fixed" && row.locations.length === 0 ? "NO-CLIENT-GATE" : "CAPABILITY"} ${row.name} | ${row.lifecycle} | ${row.classification} | ` +
        `${row.firstRelease ? `v${row.firstRelease}` : "unreleased"} | ` +
        `${row.ageDays === null ? "age unknown" : `${row.ageDays} days old`} | ` +
        `${row.expiresOn ? `retire ${row.expiresOn}` : "no fixed-version expiry"} | ` +
        `${row.locations.length} client reference(s)`,
    );
  }
  for (const deadline of sunsets.deadlines) {
    console.log(
      `RETIRE ${deadline.expiresOn}: ${deadline.name} ` +
        `(${deadline.daysRemaining > 0 ? `${deadline.daysRemaining} days left` : "expired"})`,
    );
  }
  for (const finding of findings) {
    console.log(
      `${finding.kind === "error" ? "ERROR" : "WARN"}: ${finding.message}`,
    );
  }
  const counts = inventory.rows.reduce<Record<string, number>>(
    (result, row) => {
      result[row.classification] = (result[row.classification] ?? 0) + 1;
      return result;
    },
    {},
  );
  console.log(
    `Capability audit (${asOf}): ${capabilities.length} registered ` +
      `(${counts.fixed ?? 0} fixed, ${counts.optional ?? 0} optional, ` +
      `${counts.scoped ?? 0} scoped, ${counts.retired ?? 0} retired), ` +
      `${inventory.rows.filter((row) => row.expired).length} expired fixed-version gates, ` +
      `${sunsets.deadlines.length} compatibility sunsets, ` +
      `${errors.length} error(s), ${warnings.length} warning(s).`,
  );
}

if (errors.length > 0) {
  process.exitCode = 1;
}

async function auditOwnedRouteModules(): Promise<void> {
  for (const capability of capabilities) {
    const routeModules = capability.serverContract?.routeModules ?? [];
    if (routeModules.length === 0) continue;

    const advertised = (capability.serverContract?.routes ?? []).map(
      parseAdvertisedRoute,
    );
    const declared: RouteSignature[] = [];

    for (const modulePath of routeModules) {
      const absolutePath = path.join(REPO_ROOT, modulePath);
      let source: string;
      try {
        source = await readFile(absolutePath, "utf8");
      } catch (error) {
        findings.push({
          kind: "error",
          message:
            `${capability.name} route module is unreadable: ${modulePath} ` +
            `(${String(error)})`,
        });
        continue;
      }

      for (const match of source.matchAll(ROUTE_DECLARATION)) {
        declared.push({
          method: match[1]?.toUpperCase() ?? "",
          path: match[2] ?? "",
        });
      }
    }

    for (const route of declared) {
      if (!advertised.some((entry) => routeMatches(entry, route))) {
        findings.push({
          kind: "error",
          message:
            `${capability.name} owns ${route.method} ${route.path} but ` +
            "serverContract.routes does not advertise it.",
        });
      }
    }

    for (const route of advertised) {
      if (!declared.some((entry) => routeMatches(route, entry))) {
        findings.push({
          kind: "error",
          message:
            `${capability.name} advertises ${route.method} ${route.path}, ` +
            "but no owned route module declares it.",
        });
      }
    }
  }
}

async function auditRawCapabilityChecks(): Promise<void> {
  const capabilityNames = capabilities.map((capability) => capability.name);
  for (const root of RUNTIME_SOURCE_ROOTS) {
    const files = await collectRuntimeFiles(path.join(REPO_ROOT, root));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (root === "packages/client/src") {
        clientSources.push({
          path: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
          source,
        });
      }
      for (const name of capabilityNames) {
        const quoted = `["'\`]${escapeRegExp(name)}["'\`]`;
        const rawCheck = new RegExp(
          String.raw`(?:\.includes\s*\(\s*${quoted}|serverHasCapability\s*\([^)]*${quoted}|capabilities\.push\s*\(\s*${quoted})`,
          "s",
        );
        if (rawCheck.test(source)) {
          findings.push({
            kind: "error",
            message:
              `${path.relative(REPO_ROOT, file)} checks raw capability ` +
              `"${name}"; import its registry constant/helper instead.`,
          });
        }
      }
    }
  }
}

function auditCapabilityAdvertisements(): void {
  const idAllocations = Object.values(CAPABILITY_ID_ALLOCATIONS);
  const idAllocationsByName = new Map<string, (typeof idAllocations)[number]>(
    idAllocations.map((allocation) => [allocation.name, allocation]),
  );
  const allocatedIds = new Map<number, string>();
  for (const allocation of idAllocations) {
    if (!Number.isInteger(allocation.id) || allocation.id < 0) {
      findings.push({
        kind: "error",
        message: `${allocation.name} has invalid capability ID ${allocation.id}.`,
      });
      continue;
    }
    const existing = allocatedIds.get(allocation.id);
    if (existing) {
      findings.push({
        kind: "error",
        message:
          `${allocation.name} reuses capability ID ${allocation.id} ` +
          `already allocated to ${existing}.`,
      });
    } else {
      allocatedIds.set(allocation.id, allocation.name);
    }
  }
  const highestAllocatedId = Math.max(-1, ...allocatedIds.keys());
  for (let id = 0; id <= highestAllocatedId; id += 1) {
    if (!allocatedIds.has(id)) {
      findings.push({
        kind: "error",
        message:
          `Capability ID ${id} is missing from the permanent ledger; ` +
          "retired IDs must remain reserved.",
      });
    }
  }

  const allocations = Object.values(OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS);
  const allocationsByName = new Map<string, (typeof allocations)[number]>(
    allocations.map((allocation) => [allocation.name, allocation]),
  );
  const capabilitiesByName = new Map(
    capabilities.map((capability) => [capability.name, capability]),
  );
  const allocatedIndices = new Map<number, string>();

  for (const capability of capabilities) {
    const allocation = idAllocationsByName.get(capability.name);
    const requiresId =
      capability.advertisement.kind !== "scoped" &&
      versionAtLeast(
        capability.introducedIn,
        CAPABILITY_ID_ENCODING_INTRODUCED_IN,
      );
    if (requiresId && capability.id === undefined) {
      findings.push({
        kind: "error",
        message:
          `${capability.name} was introduced in ${capability.introducedIn} ` +
          "but has no durable capability ID.",
      });
    }
    if (capability.id === undefined) continue;
    if (allocation?.direction !== "server") {
      findings.push({
        kind: "error",
        message: `${capability.name} has ID ${capability.id} without a server allocation.`,
      });
      continue;
    }
    if (allocation.id !== capability.id) {
      findings.push({
        kind: "error",
        message:
          `${capability.name} uses ID ${capability.id}, ` +
          `not allocated ID ${allocation.id}.`,
      });
    }
    if (allocation.introducedIn !== capability.introducedIn) {
      findings.push({
        kind: "error",
        message:
          `${capability.name} ID allocation records ${allocation.introducedIn}, ` +
          `not introducedIn ${capability.introducedIn}.`,
      });
    }
  }

  for (const allocation of idAllocations) {
    if (allocation.direction !== "server") continue;
    if (!capabilitiesByName.has(allocation.name)) {
      findings.push({
        kind: "error",
        message: `${allocation.name} retains server capability ID ${allocation.id} without a registry entry.`,
      });
    }
  }

  for (const allocation of allocations) {
    if (!Number.isInteger(allocation.index) || allocation.index < 0) {
      findings.push({
        kind: "error",
        message: `${allocation.name} has invalid optional bit index ${allocation.index}.`,
      });
      continue;
    }
    const existing = allocatedIndices.get(allocation.index);
    if (existing) {
      findings.push({
        kind: "error",
        message:
          `${allocation.name} reuses optional bit ${allocation.index} ` +
          `already allocated to ${existing}.`,
      });
    } else {
      allocatedIndices.set(allocation.index, allocation.name);
    }

    const capability = capabilitiesByName.get(allocation.name);
    if (capability && capability.advertisement.kind !== "optional-bit") {
      findings.push({
        kind: "error",
        message:
          `${allocation.name} retains optional bit ${allocation.index} but ` +
          `is advertised as ${capability.advertisement.kind}.`,
      });
    }
  }

  for (const capability of capabilities) {
    if (capability.advertisement.kind !== "optional-bit") continue;
    const allocation = allocationsByName.get(capability.name);
    if (!allocation) {
      findings.push({
        kind: "error",
        message: `${capability.name} has no durable optional-bit allocation.`,
      });
      continue;
    }
    if (allocation.index !== capability.advertisement.index) {
      findings.push({
        kind: "error",
        message:
          `${capability.name} uses optional bit ` +
          `${capability.advertisement.index}, not allocated bit ${allocation.index}.`,
      });
    }
    if (allocation.introducedIn !== capability.introducedIn) {
      findings.push({
        kind: "error",
        message:
          `${capability.name} allocation records ${allocation.introducedIn}, ` +
          `not introducedIn ${capability.introducedIn}.`,
      });
    }
  }
}

function versionAtLeast(candidate: string, baseline: string): boolean {
  const parse = (value: string): readonly [number, number, number] | null => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match?.[1] || !match[2] || !match[3]) return null;
    return [
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10),
      Number.parseInt(match[3], 10),
    ];
  };
  const left = parse(candidate);
  const right = parse(baseline);
  if (!left || !right) return false;
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function parseAdvertisedRoute(value: string): RouteSignature {
  const separator = value.indexOf(" ");
  if (separator < 1) {
    return { method: "", path: value };
  }
  return {
    method: value.slice(0, separator).toUpperCase(),
    path: value.slice(separator + 1),
  };
}

function routeMatches(
  advertised: RouteSignature,
  declared: RouteSignature,
): boolean {
  return (
    advertised.method === declared.method &&
    advertised.path.endsWith(declared.path)
  );
}

async function collectRuntimeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__mocks__") continue;
      files.push(...(await collectRuntimeFiles(entryPath)));
      continue;
    }
    if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.test\.(?:ts|tsx)$/.test(entry.name)
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
