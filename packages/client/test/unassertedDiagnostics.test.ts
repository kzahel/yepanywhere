import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import allowlist from "./unasserted-diagnostics.json";
import { DIAGNOSTIC_KINDS } from "./unassertedDiagnostics";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// The suite judges an entry only while its file runs, so an entry for a
// renamed or deleted file would otherwise stay forever.
describe("unasserted diagnostics allowlist", () => {
  it("names existing test files and known diagnostic kinds", () => {
    for (const [file, entry] of Object.entries(allowlist.files)) {
      expect(existsSync(path.join(repoRoot, file)), file).toBe(true);
      expect(entry.diagnostics.length, file).toBeGreaterThan(0);
      for (const kind of entry.diagnostics) {
        expect(DIAGNOSTIC_KINDS, file).toContain(kind);
      }
      expect(entry.note.trim().length, file).toBeGreaterThanOrEqual(20);
    }
  });
});
