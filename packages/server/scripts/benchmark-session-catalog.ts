/**
 * Session catalog in SQLite (plan 189 step 3): what a publication writes and
 * how long reads take, on a synthetic catalog shaped like the maintainer's
 * (7,470 rows, about 1.9 KB of row JSON each, a fifth with titles longer than
 * the stored prefix).
 *
 *   pnpm --filter @yep-anywhere/server benchmark:session-catalog
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { SessionCatalogService } from "../src/services/SessionCatalogService.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogRow,
} from "../src/sessions/catalog-types.js";
import { openDiscoveryDatabase } from "../src/storage/discovery-sqlite.js";

const PROJECTS = 1_494;
const SESSIONS_PER_PROJECT = 5;
const READERS = 20;
const SAMPLES = 7;
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

function corpus(rowFormat?: number, changed?: string): SessionCatalogRow[] {
  const rows: SessionCatalogRow[] = [];
  for (let project = 0; project < PROJECTS; project += 1) {
    const projectPath = `/projects/p${project}`;
    for (let index = 0; index < SESSIONS_PER_PROJECT; index += 1) {
      const sessionId = `p${project}-s${index}`;
      const bumped = sessionId === changed;
      const titleLength = index === 0 ? 4_000 : 900;
      rows.push({
        catalogFamily: "codex",
        storeKey: "default",
        sessionId,
        projectId: `id-p${project}` as UrlProjectId,
        projectPath,
        projectIdentityKey: projectPath,
        updatedAt: new Date(
          BASE_MS + project * 1_000 + index + (bumped ? 900_000 : 0),
        ).toISOString(),
        title: `Session ${sessionId} `.padEnd(titleLength, "lorem ipsum "),
        fidelity: "head",
        sourceVersion: `${sessionId}@${bumped ? 2 : 1}`,
        ...(rowFormat === undefined ? {} : { rowFormat }),
        location: { kind: "file", path: `/store/p${project}/s${index}.jsonl` },
      });
    }
  }
  return rows;
}

function adapter(
  rows: readonly SessionCatalogRow[],
): NativeSessionCatalogAdapter {
  return {
    catalogFamily: "codex",
    storeKey: "default",
    scan: async () => ({
      sourceVersion: "v",
      rows: rows.map((row) => ({ ...row })),
    }),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Database pages that differ between two copies of the file. */
function changedPages(before: Buffer, after: Buffer, pageSize: number): number {
  let pages = 0;
  const length = Math.max(before.length, after.length);
  for (let offset = 0; offset < length; offset += pageSize) {
    if (
      !before
        .subarray(offset, offset + pageSize)
        .equals(after.subarray(offset, offset + pageSize))
    )
      pages += 1;
  }
  return pages;
}

const ms = (value: number) => Number(value.toFixed(2));
const dataDir = await mkdtemp(join(tmpdir(), `catalog-bench-${randomUUID()}-`));
try {
  const rows = corpus();
  const rowJsonBytes = rows.reduce(
    (total, row) => total + Buffer.byteLength(JSON.stringify(row)) + 1,
    0,
  );

  // The one-time import of an earlier version's files.
  const catalogDir = join(dataDir, "session-catalog");
  const generation = "gen-870603-00000000-0000-4000-8000-000000000000";
  await mkdir(join(catalogDir, "generations", generation), { recursive: true });
  await writeFile(
    join(catalogDir, "generations", generation, "bucket-000.jsonl"),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  await writeFile(
    join(catalogDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      catalogEpoch: "bench",
      catalogGeneration: 870_603,
      completedAt: new Date().toISOString(),
      generationDirectory: generation,
      rowCount: rows.length,
      shards: [{ file: "bucket-000.jsonl" }],
      providerSources: [{ catalogFamily: "codex", storeKey: "default" }],
    }),
  );
  const database = openDiscoveryDatabase({ dataDir });
  const pageSize =
    database.prepare("PRAGMA page_size").get<{ page_size: number }>()
      ?.page_size ?? 4096;
  const imported = new SessionCatalogService({
    database,
    legacyCatalogDir: catalogDir,
  });
  await imported.initialize();
  const importMetrics = imported.getMetrics().legacyImport;
  imported.stop();

  // Restart: every row loaded from the tables.
  const loads: number[] = [];
  let service!: SessionCatalogService;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    service = new SessionCatalogService({ database });
    const startedAt = performance.now();
    await service.initialize();
    loads.push(performance.now() - startedAt);
  }

  const unchanged = await service.reconcile([adapter(rows)]);

  // One changed session, sampled: the transaction and the pages it wrote.
  const oneRow: number[] = [];
  const oneRowPages: number[] = [];
  const dbPath = join(dataDir, "discovery.sqlite");
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const before = await readFile(dbPath);
    const result = await service.reconcile([
      adapter(corpus(undefined, `p${sample * 7}-s1`)),
    ]);
    oneRow.push(result.metrics.writeMs);
    oneRowPages.push(changedPages(before, await readFile(dbPath), pageSize));
    await service.reconcile([adapter(rows)]);
  }

  // A full rediscovery that changes every row (a rowFormat bump).
  const everyRow: number[] = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const result = await service.reconcile([adapter(corpus(sample + 2))]);
    everyRow.push(result.metrics.writeMs);
  }

  const fullReads: number[] = [];
  const projectReads: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    let startedAt = performance.now();
    await Promise.all(
      Array.from({ length: READERS }, () => service.readRows()),
    );
    fullReads.push((performance.now() - startedAt) / READERS);
    startedAt = performance.now();
    await Promise.all(
      Array.from({ length: READERS }, (_, reader) =>
        service.readProjectRows(`/projects/p${reader * 13 + sample}`),
      ),
    );
    projectReads.push((performance.now() - startedAt) / READERS);
  }

  console.log(
    JSON.stringify(
      {
        rows: rows.length,
        rowJsonBytes,
        legacyImport: importMetrics && {
          ...importMetrics,
          durationMs: ms(importMetrics.durationMs),
        },
        restartLoadMs: ms(median(loads)),
        unchangedScan: unchanged.metrics,
        oneChangedRow: {
          writeMsMedian: ms(median(oneRow)),
          databasePagesMedian: median(oneRowPages),
          databaseBytesMedian: median(oneRowPages) * pageSize,
          note: "the rollback journal writes the same pages' old content once more",
        },
        everyRowChangedWriteMs: everyRow.map(ms),
        fullReadMsMedian: ms(median(fullReads)),
        projectReadMsMedian: ms(median(projectReads)),
        databaseBytes: (await readFile(dbPath)).length,
      },
      null,
      2,
    ),
  );
  service.stop();
  database.close();
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
