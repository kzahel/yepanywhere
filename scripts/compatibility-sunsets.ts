import path from "node:path";
import type { ServerCapabilityDefinition } from "../packages/shared/src/server-capability-definition.js";

export const COMPATIBILITY_LIFETIME_DAYS = 90;
const DAY_MS = 86_400_000;

interface CompatibilitySunset {
  name: string;
  capabilities: string[];
  supportedSince: string;
  evidence: string;
  removal: string;
  locations: { path: string; marker: string }[];
}

export interface CompatibilityDeadline {
  name: string;
  expiresOn: string;
  daysRemaining: number;
  removal: string;
  locations: string[];
}

export function parseAuditDate(value: string): number {
  const time = Date.parse(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(
      `Invalid audit date ${JSON.stringify(value)}; use YYYY-MM-DD.`,
    );
  }
  return time;
}

function isSunset(value: unknown): value is CompatibilitySunset {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const fields = [
    "name",
    "capabilities",
    "supportedSince",
    "evidence",
    "removal",
    "locations",
  ];
  return (
    Object.keys(entry).every((key) => fields.includes(key)) &&
    ["name", "supportedSince", "evidence", "removal"].every(
      (key) => typeof entry[key] === "string" && entry[key].trim().length > 0,
    ) &&
    Array.isArray(entry.capabilities) &&
    entry.capabilities.every((name) => typeof name === "string") &&
    Array.isArray(entry.locations) &&
    entry.locations.length > 0 &&
    entry.locations.every(
      (location) =>
        location &&
        typeof location.path === "string" &&
        location.path.length > 0 &&
        !path.isAbsolute(location.path) &&
        !location.path.includes("\\") &&
        !location.path.split("/").some((part: string) => part === "..") &&
        typeof location.marker === "string" &&
        location.marker.trim().length > 0,
    )
  );
}

/** Inventory is independent of lifecycle labels, so reclassification cannot hide debt. */
export async function auditCompatibilitySunsets(
  inventory: unknown,
  capabilities: readonly ServerCapabilityDefinition[],
  readSource: (file: string) => Promise<string>,
  asOf: string,
): Promise<{ errors: string[]; deadlines: CompatibilityDeadline[] }> {
  const today = parseAuditDate(asOf);
  const errors: string[] = [];
  const deadlines: CompatibilityDeadline[] = [];
  if (!Array.isArray(inventory)) {
    return {
      errors: ["Compatibility sunset inventory must be an array."],
      deadlines,
    };
  }
  const names = new Set<string>();
  const coveredCapabilities = new Set<string>();
  const knownCapabilities = new Set(capabilities.map(({ name }) => name));

  for (const value of inventory) {
    if (!isSunset(value)) {
      errors.push(
        `Invalid compatibility sunset entry: ${JSON.stringify(value)}.`,
      );
      continue;
    }
    const entry = value;
    if (names.has(entry.name))
      errors.push(`Duplicate compatibility sunset ${entry.name}.`);
    names.add(entry.name);
    for (const name of entry.capabilities) {
      if (!knownCapabilities.has(name)) {
        errors.push(`${entry.name} names unknown capability ${name}.`);
      }
      coveredCapabilities.add(name);
    }

    let since: number;
    try {
      since = parseAuditDate(entry.supportedSince);
    } catch (error) {
      errors.push(`${entry.name}: ${String(error)}`);
      continue;
    }
    if (since > today) {
      errors.push(
        `${entry.name} has a future supportedSince ${entry.supportedSince}.`,
      );
      continue;
    }

    const locations: string[] = [];
    for (const location of entry.locations) {
      try {
        const source = await readSource(location.path);
        if (source.includes(location.marker)) locations.push(location.path);
      } catch (error) {
        // Removing a whole fallback file counts as removing its marker.
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
          errors.push(
            `${entry.name}: cannot read ${location.path}: ${String(error)}`,
          );
        }
      }
    }
    if (locations.length === 0) {
      errors.push(
        `${entry.name} has no remaining code markers; remove its stale inventory entry ` +
          "after removing alternate paths. Remaining fixed-version gates are audited separately.",
      );
      continue;
    }

    const expires = since + COMPATIBILITY_LIFETIME_DAYS * DAY_MS;
    const deadline = {
      name: entry.name,
      expiresOn: new Date(expires).toISOString().slice(0, 10),
      daysRemaining: (expires - today) / DAY_MS,
      removal: entry.removal,
      locations: [...new Set(locations)],
    };
    deadlines.push(deadline);
    if (expires <= today) {
      errors.push(
        `${entry.name} EXPIRED ${deadline.expiresOn} (${COMPATIBILITY_LIFETIME_DAYS} days ` +
          `after ${entry.evidence}). Remove by standing policy; no new approval needed. ` +
          `${entry.removal} Locations: ${deadline.locations.join(", ")}.`,
      );
    }
  }

  for (const capability of capabilities) {
    if (capability.kind !== capability.lifecycle.kind) {
      errors.push(`${capability.name} has inconsistent lifecycle kinds.`);
    }
    if (
      (capability.kind === "transitional" ||
        capability.lifecycle.kind === "transitional") &&
      !coveredCapabilities.has(capability.name)
    ) {
      errors.push(
        `${capability.name} is transitional without a 90-day sunset inventory entry.`,
      );
    }
  }
  deadlines.sort(
    (a, b) =>
      a.expiresOn.localeCompare(b.expiresOn) || a.name.localeCompare(b.name),
  );
  return { errors, deadlines };
}
