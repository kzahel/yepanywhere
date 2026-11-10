import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionMetadataRows } from "../../src/metadata/session-metadata-rows.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
  openTestDiscoveryDatabase,
  writeStoredMetadata,
} from "../utils/session-metadata-database.js";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-metadata-working-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  closeTestDiscoveryDatabases();
  await rm(directory, { recursive: true, force: true });
});
const seed = (values: Record<string, unknown>) => {
  const database = openTestDiscoveryDatabase(directory);
  database.transaction(() => writeStoredMetadata(database, values));
  return database;
};
it("restarts without loading cold metadata and bounds clean objects, payloads and misses", async () => {
  await createTestSessionMetadataService(directory).initialize();
  const prompt = "x".repeat(160_000);
  seed(
    Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `cold-${i}`,
        { initialPrompt: prompt, customTitle: `Cold ${i}` },
      ]),
    ),
  );
  const all = vi
    .spyOn(SessionMetadataRows.prototype, "all")
    .mockImplementation(() => {
      throw new Error("cold corpus decoded");
    });
  const service = createTestSessionMetadataService(directory);
  await service.initialize();
  expect(all).not.toHaveBeenCalled();
  expect(service.getWorkingSetMetrics().entries).toBe(0);
  const points = vi.spyOn(SessionMetadataRows.prototype, "read");
  const snapshot = service.getMetadataBatch(
    Array.from({ length: 40 }, (_, i) => `cold-${i}`),
  );
  expect(snapshot.size).toBe(40);
  expect(snapshot.get("cold-0")?.initialPrompt).toBe(prompt);
  expect(points).not.toHaveBeenCalled();
  points.mockRestore();
  for (let i = 0; i < 40; i++)
    expect(service.getMetadata(`cold-${i}`)?.initialPrompt).toBe(prompt);
  let metrics = service.getWorkingSetMetrics();
  expect(metrics.entries).toBeLessThan(40);
  expect(metrics.estimatedPayloadBytes).toBeLessThanOrEqual(
    metrics.payloadByteBudget,
  );
  for (let i = 0; i < 800; i++)
    expect(service.getMetadata(`missing-${i}`)).toBeUndefined();
  metrics = service.getWorkingSetMetrics();
  expect(metrics.entries).toBeLessThanOrEqual(metrics.entryBudget);
  expect(service.getMetadata("cold-0")?.customTitle).toBe("Cold 0");
  expect(service.getMetadata("cold-0")).toBe(service.getMetadata("cold-0"));
});
it("pins failed updates and deletion tombstones through cache pressure until retry commits", async () => {
  const service = createTestSessionMetadataService(directory);
  await service.initialize();
  await service.updateMetadata("update", {
    title: "Before",
  });
  await service.updateMetadata("delete", {
    title: "Before",
  });
  await service.setProvider("update", "claude");
  await service.setProvider("delete", "codex");
  const db = openTestDiscoveryDatabase(directory);
  db.exec(
    "CREATE TRIGGER refuse_update BEFORE UPDATE ON session_metadata BEGIN SELECT RAISE(ABORT,'blocked'); END; CREATE TRIGGER refuse_delete BEFORE DELETE ON session_metadata BEGIN SELECT RAISE(ABORT,'blocked'); END;",
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(service.setTitle("update", "Pending")).rejects.toThrow(
    "blocked",
  );
  await expect(service.clearSession("delete")).rejects.toThrow("blocked");
  const pending = service.getMetadata("update");
  const batch = service.getMetadataBatch(["update", "delete", "missing"]);
  expect(batch.get("update")).toBe(pending);
  expect(batch.get("delete")).toBeUndefined();
  expect(batch.get("missing")).toBeUndefined();
  for (let i = 0; i < 800; i++) service.getMetadata(`missing-${i}`);
  expect(service.getMetadata("update")).toBe(pending);
  expect(service.getMetadata("update")?.customTitle).toBe("Pending");
  expect(service.getMetadata("delete")).toBeUndefined();
  expect(service.getRecordedProviders()).toEqual(["claude"]);
  expect(service.getWorkingSetMetrics().pinnedEntries).toBe(2);
  db.exec("DROP TRIGGER refuse_update; DROP TRIGGER refuse_delete");
  await service.flushPendingWrites();
  expect(service.getWorkingSetMetrics().pinnedEntries).toBe(0);
  const reopened = createTestSessionMetadataService(directory);
  await reopened.initialize();
  expect(reopened.getMetadata("update")?.customTitle).toBe("Pending");
  expect(reopened.getMetadata("delete")).toBeUndefined();
  expect(error).toHaveBeenCalled();
});
it("recovers only interrupted display owners and reads feature views through SQL", async () => {
  await createTestSessionMetadataService(directory).initialize();
  const db = seed({
    ...Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `cold-${i}`,
        { initialPrompt: "cold payload", provider: "claude" },
      ]),
    ),
    running: {
      transcriptDisplayObjects: [
        { id: "running", kind: "bang-command", status: "running" },
      ],
      clearloop: { state: "running" },
    },
    generating: {
      transcriptDisplayObjects: [
        { id: "gen", kind: "fork-summary", status: "generating" },
      ],
    },
    complete: {
      transcriptDisplayObjects: [
        { id: "done", kind: "fork-summary", status: "complete" },
      ],
    },
    billing: {
      cacheMissBillingEvents: [
        {
          id: "bill",
          timestamp: "2026-11-10T12:00:00Z",
          expectedInputCost: { freshEnough: true },
        },
      ],
    },
  });
  vi.spyOn(SessionMetadataRows.prototype, "all").mockImplementation(() => {
    throw new Error("cold corpus decoded");
  });
  const service = createTestSessionMetadataService(directory);
  await service.initialize();
  expect(service.getWorkingSetMetrics().entries).toBe(2);
  expect(service.getTranscriptDisplayObjects("running")[0]?.status).toBe(
    "killed",
  );
  expect(service.getTranscriptDisplayObjects("generating")[0]?.status).toBe(
    "error",
  );
  expect(service.listSessionIdsWithRunningClearloop()).toEqual(["running"]);
  expect(service.listTranscriptDisplayObjectSessions()).toHaveLength(3);
  expect(service.getCacheMissBillingEvents().map((event) => event.id)).toEqual([
    "bill",
  ]);
  const plan = db.prepare(
    "EXPLAIN QUERY PLAN SELECT session_id FROM session_metadata WHERE CASE WHEN json_valid(extra) THEN json_extract(extra,'$.clearloop.state') END='running'",
  );
  expect(JSON.stringify(plan.all())).toContain(
    "session_metadata_clearloop_running",
  );
  plan.finalize();
});
