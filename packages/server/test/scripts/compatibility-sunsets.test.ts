import { describe, expect, it } from "vitest";
import {
  auditCompatibilitySunsets,
  parseAuditDate,
} from "../../../../scripts/compatibility-sunsets.js";
import type { ServerCapabilityDefinition } from "../../../shared/src/server-capability-definition.js";

const fallback = {
  name: "old-parser",
  capabilities: ["parser-v2"],
  supportedSince: "2026-08-10",
  evidence: "v2 released 2026-08-10",
  removal: "Remove parseV1 and show update guidance.",
  locations: [{ path: "src/parser.ts", marker: "function parseV1(" }],
};
const capability: ServerCapabilityDefinition = {
  name: "parser-v2",
  kind: "transitional",
  area: "sessions",
  introducedIn: "0.8.0",
  advertisement: { kind: "version-implied" },
  description: "New parser",
  clientFallback: "Old parser",
  lifecycle: { kind: "transitional" },
};
const readSource = async () => "function parseV1() {}";

describe("compatibility retirement policy", () => {
  it("fails on day 90 at UTC midnight, including leap-year boundaries", async () => {
    const before = await auditCompatibilitySunsets(
      [fallback],
      [capability],
      readSource,
      "2026-11-07",
    );
    expect(before.errors).toEqual([]);
    expect(before.deadlines[0]).toMatchObject({
      expiresOn: "2026-11-08",
      daysRemaining: 1,
    });
    const expired = await auditCompatibilitySunsets(
      [fallback],
      [capability],
      readSource,
      "2026-11-08",
    );
    expect(expired.errors).toEqual([
      expect.stringContaining("EXPIRED 2026-11-08"),
    ]);
    expect(expired.errors[0]).toContain("src/parser.ts");
    expect(expired.errors[0]).toContain("no new approval needed");
    const leap = await auditCompatibilitySunsets(
      [{ ...fallback, supportedSince: "2028-01-01" }],
      [capability],
      readSource,
      "2028-03-31",
    );
    expect(leap.errors).toEqual([
      expect.stringContaining("EXPIRED 2028-03-31"),
    ]);
  });

  it("does not let permanent reclassification exempt tracked code", async () => {
    const permanent: ServerCapabilityDefinition = {
      ...capability,
      kind: "permanent",
      lifecycle: { kind: "permanent", reason: "Hide feature" },
    };
    const result = await auditCompatibilitySunsets(
      [fallback],
      [permanent],
      readSource,
      "2026-11-08",
    );
    expect(result.errors).toEqual([expect.stringContaining("EXPIRED")]);
    expect(
      (
        await auditCompatibilitySunsets(
          [],
          [capability],
          readSource,
          "2026-10-27",
        )
      ).errors,
    ).toEqual([expect.stringContaining("without a 90-day sunset")]);
  });

  it("covers protocol code with no capability and keeps partially removed paths due", async () => {
    const entry = {
      ...fallback,
      capabilities: [],
      locations: [
        ...fallback.locations,
        { path: "src/old.ts", marker: "oldEncoder" },
      ],
    };
    const partialRead = async (file: string) => {
      if (file === "src/old.ts")
        throw Object.assign(new Error("removed"), { code: "ENOENT" });
      return readSource();
    };
    expect(
      (await auditCompatibilitySunsets([entry], [], partialRead, "2026-11-08"))
        .errors,
    ).toEqual([expect.stringContaining("EXPIRED")]);
    const gone = await auditCompatibilitySunsets(
      [entry],
      [],
      async () => "",
      "2026-11-08",
    );
    expect(gone.errors).toEqual([expect.stringContaining("stale inventory")]);
  });

  it("rejects invalid dates, future anchors and deadline overrides", async () => {
    for (const date of ["2026-02-30", "2026-2-03", "garbage"]) {
      expect(() => parseAuditDate(date)).toThrow("Invalid audit date");
      const result = await auditCompatibilitySunsets(
        [{ ...fallback, supportedSince: date }],
        [capability],
        readSource,
        "2026-10-27",
      );
      expect(result.errors[0]).toContain("Invalid audit date");
    }
    const future = await auditCompatibilitySunsets(
      [fallback],
      [capability],
      readSource,
      "2026-08-09",
    );
    expect(future.errors[0]).toContain("future supportedSince");
    const override = await auditCompatibilitySunsets(
      [{ ...fallback, expiresOn: "2099-01-01" }],
      [],
      readSource,
      "2026-10-27",
    );
    expect(override.errors[0]).toContain("Invalid compatibility sunset entry");
  });

  it("fails bad inventory, unknown capabilities, duplicate names and unreadable sources", async () => {
    const result = await auditCompatibilitySunsets(
      [fallback, fallback],
      [],
      async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      "2026-10-27",
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unknown capability"),
        expect.stringContaining("Duplicate compatibility sunset"),
        expect.stringContaining("cannot read src/parser.ts"),
      ]),
    );
    expect(
      (await auditCompatibilitySunsets({}, [], readSource, "2026-10-27"))
        .errors,
    ).toEqual(["Compatibility sunset inventory must be an array."]);
  });
});
