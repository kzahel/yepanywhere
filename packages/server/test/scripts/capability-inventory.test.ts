import { describe, expect, it } from "vitest";
import {
  auditCapabilityInventory,
  findClientCapabilityReferences,
} from "../../../../scripts/capability-inventory.js";
import type { ServerCapabilityDefinition } from "../../../shared/src/server-capability-definition.js";

const capability: ServerCapabilityDefinition = {
  name: "fixed-feature",
  kind: "permanent",
  area: "settings",
  introducedIn: "0.6.3",
  advertisement: { kind: "version-implied" },
  description: "Fixed feature",
  clientFallback: "Hide the control.",
  lifecycle: { kind: "permanent", reason: "Cheap hide-only gate" },
};
const calendar = {
  stableReleases: {
    "0.8.0": "2026-08-31",
    "0.6.0": "2026-07-06",
    "0.7.0": "2026-07-25",
  },
  sourceIntroductions: {},
};
const references = new Map([[capability.name, ["client.tsx:3"]]]);

describe("complete capability inventory", () => {
  it("automatically expires a permanent hide-only gate on day 90 using the first actual stable release", () => {
    const before = auditCapabilityInventory(
      { feature: capability },
      calendar,
      references,
      "2026-10-22",
    );
    expect(before.errors).toEqual([]);
    expect(before.rows[0]).toMatchObject({
      firstRelease: "0.7.0",
      ageDays: 89,
      expiresOn: "2026-10-23",
      expired: false,
    });
    const expired = auditCapabilityInventory(
      { feature: capability },
      calendar,
      references,
      "2026-10-23",
    );
    expect(expired.errors).toEqual([
      expect.stringContaining("fixed-feature EXPIRED 2026-10-23"),
    ]);
    expect(expired.errors[0]).toContain("client.tsx:3");
    expect(expired.rows[0]?.fallback).toBe("Hide the control.");
    const backport = auditCapabilityInventory(
      { feature: capability },
      {
        ...calendar,
        stableReleases: { ...calendar.stableReleases, "0.6.3": "2026-09-22" },
      },
      references,
      "2026-10-23",
    );
    expect(backport.rows[0]?.expiresOn).toBe("2026-10-23");
  });

  it("lists optional, scoped, retired and unused entries without treating their IDs as live fixed gates", () => {
    const definitions = {
      optional: {
        ...capability,
        name: "optional",
        advertisement: { kind: "optional-bit", index: 4 },
      },
      scoped: {
        ...capability,
        name: "scoped",
        advertisement: { kind: "scoped" },
      },
      retired: { ...capability, name: "retired", retired: true },
      unused: { ...capability, name: "unused" },
    } satisfies Record<string, ServerCapabilityDefinition>;
    const result = auditCapabilityInventory(
      definitions,
      calendar,
      new Map(),
      "2026-10-27",
    );
    expect(result.errors).toEqual([]);
    expect(
      result.rows.map(({ classification }) => classification).sort(),
    ).toEqual(["fixed", "optional", "retired", "scoped"]);
    const retiredConsumer = auditCapabilityInventory(
      definitions,
      calendar,
      new Map([["retired", ["forgotten.ts:5"]]]),
      "2026-10-27",
    );
    expect(retiredConsumer.errors).toEqual([
      expect.stringContaining("marked retired but still has client references"),
    ]);
  });

  it("requires an unreleased fixed feature's source date and does not reset it when a stable release arrives", () => {
    const future = { ...capability, introducedIn: "0.9.0" };
    const missing = auditCapabilityInventory(
      { feature: future },
      calendar,
      references,
      "2026-10-27",
    );
    expect(missing.errors).toEqual([
      expect.stringContaining(
        "no released baseline or source introduction date",
      ),
    ]);
    const sourceCalendar = {
      ...calendar,
      sourceIntroductions: { "fixed-feature": "2026-08-01" },
    };
    const source = auditCapabilityInventory(
      { feature: future },
      sourceCalendar,
      references,
      "2026-10-27",
    );
    const released = auditCapabilityInventory(
      { feature: future },
      {
        ...sourceCalendar,
        stableReleases: { ...calendar.stableReleases, "0.9.0": "2026-09-22" },
      },
      references,
      "2026-10-27",
    );
    expect(source.rows[0]?.expiresOn).toBe("2026-10-30");
    expect(released.rows[0]?.expiresOn).toBe(source.rows[0]?.expiresOn);
  });

  it("rejects malformed or future calendar facts rather than silently exempting gates", () => {
    const invalidCalendars: Record<string, string>[] = [
      { "0.6.3": "2026-02-30" },
      { "0.6.3": "2027-01-01" },
      { bad: "2026-01-01" },
      {},
    ];
    for (const stableReleases of invalidCalendars) {
      expect(() =>
        auditCapabilityInventory(
          { feature: capability },
          { stableReleases, sourceIntroductions: {} },
          references,
          "2026-10-27",
        ),
      ).toThrow();
    }
    expect(() =>
      auditCapabilityInventory(
        {},
        { ...calendar, sourceIntroductions: { unknown: "2026-01-01" } },
        new Map(),
        "2026-10-27",
      ),
    ).toThrow("Unknown capability");
  });

  it("finds constant import aliases, domain-helper uses and direct registry aliases but ignores comments and unused imports", () => {
    const definitions = { feature: capability };
    const registry =
      "export const FEATURE_CAPABILITY = SERVER_CAPABILITIES.feature.name;";
    const found = findClientCapabilityReferences(definitions, registry, [
      {
        path: "aliased.ts",
        source:
          'import { FEATURE_CAPABILITY as feature } from "shared";\nuseCapability(feature);',
      },
      {
        path: "direct.ts",
        source:
          'import { SERVER_CAPABILITIES as caps } from "shared";\nserverHasCapability(v, caps.feature);',
      },
      {
        path: "unused.ts",
        source:
          'import { FEATURE_CAPABILITY } from "shared";\n// FEATURE_CAPABILITY\nconst text = "FEATURE_CAPABILITY";',
      },
      {
        path: "type.ts",
        source:
          'import type { FEATURE_CAPABILITY } from "shared";\ntype T = typeof FEATURE_CAPABILITY;',
      },
      {
        path: "namespace.ts",
        source:
          'import * as shared from "shared";\ncheck(shared.FEATURE_CAPABILITY);\ncheck(shared.SERVER_CAPABILITIES["feature"]);',
      },
    ]);
    expect(found.get("fixed-feature")).toEqual([
      "aliased.ts:2",
      "direct.ts:2",
      "namespace.ts:2",
      "namespace.ts:3",
    ]);
  });
});
