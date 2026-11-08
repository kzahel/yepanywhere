/**
 * Public identity projection of a whole published catalog, as every list read
 * performs it. The first projection adopts every row (a cold profile); later
 * ones find every row already bound, which is the steady state a running
 * server repeats on each `session-catalog-updated` read.
 *
 * Row counts follow the maintainer's host (about 7,400 Claude and Codex rows
 * across a few dozen projects); the shape is deliberately simple.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { SessionMetadataService } from "../src/metadata/SessionMetadataService.js";
import { projectCatalogIdentities } from "../src/sessions/catalog-identity.js";
import type { SessionCatalogRow } from "../src/sessions/catalog-types.js";
import { DiscoverySqliteService } from "../src/storage/discovery-sqlite.js";

const ROWS = Number(process.env.ROWS ?? 7_400);
const PROJECTS = 47;
const READS = 20;

const root = await realpath(
  await mkdtemp(join(tmpdir(), "ya-identity-bench-")),
);
const dataDir = join(root, "data");
const scopes = { claude: join(root, "claude"), codex: join(root, "codex") };
await Promise.all(
  Object.values(scopes).map((scope) => mkdir(scope, { recursive: true })),
);
const storage = new DiscoverySqliteService({
  dataDir,
  probeNetworkFilesystem: () => undefined,
});
try {
  const metadata = new SessionMetadataService({
    dataDir,
    database: storage.getDatabase(),
  });
  await metadata.initialize();
  const rows: SessionCatalogRow[] = Array.from({ length: ROWS }, (_, i) => {
    const family = i % 2 ? "codex" : "claude";
    const projectPath = join(root, "projects", `p${i % PROJECTS}`);
    return {
      catalogFamily: family,
      storeKey: family,
      sessionId: randomUUID(),
      nativeStorageScope: scopes[family],
      projectId: toUrlProjectId(projectPath),
      projectPath,
      projectIdentityKey: projectPath,
      updatedAt: new Date(0).toISOString(),
      fidelity: "summary",
      sourceVersion: "1",
      location: { kind: "file", path: join(scopes[family], `${i}.jsonl`) },
    } as SessionCatalogRow;
  });
  Object.freeze(rows);

  let started = performance.now();
  const adopted = await projectCatalogIdentities(rows, metadata);
  const cold = performance.now() - started;
  if (adopted.length !== ROWS) throw new Error("cold projection lost rows");

  const samples: number[] = [];
  for (let read = 0; read < READS; read++) {
    started = performance.now();
    const projected = await projectCatalogIdentities(rows, metadata);
    samples.push(performance.now() - started);
    if (projected.length !== ROWS) throw new Error("warm projection lost rows");
  }
  samples.sort((a, b) => a - b);

  // Session-source resolution projects one row; it must not pay for the store.
  const single = [rows[0]!];
  const singleSamples: number[] = [];
  for (let read = 0; read < 200; read++) {
    started = performance.now();
    await projectCatalogIdentities(single, metadata);
    singleSamples.push(performance.now() - started);
  }
  singleSamples.sort((a, b) => a - b);
  const ms = (value: number) => `${value.toFixed(2)} ms`;
  console.log(
    `rows=${ROWS} cold=${ms(cold)} warm median=${ms(
      samples[Math.floor(READS / 2)]!,
    )} p90=${ms(samples[Math.floor(READS * 0.9)]!)} single-row median=${ms(
      singleSamples[100]!,
    )}`,
  );
} finally {
  storage.close();
  await rm(root, { recursive: true, force: true });
}
