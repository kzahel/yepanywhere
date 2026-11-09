import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  toUrlProjectId,
  type SessionContentSearchBatch,
} from "@yep-anywhere/shared";
import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { createGlobalSessionsRoutes } from "../../src/routes/global-sessions.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";

let directory: string;
let collections: RetainedSessionCollections;
afterEach(async () => {
  await collections?.dispose();
  closeTestDiscoveryDatabases();
  if (directory) await rm(directory, { recursive: true });
});

it("answers availability from the resolved reader, not the advertised provider list", async () => {
  directory = await mkdtemp(join(tmpdir(), "session-content-reader-"));
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const projectsDir = join(directory, "projects");
  const sessionDir = join(projectsDir, hostname(), cwd.replace(/[/\\]/g, "-"));
  await mkdir(sessionDir, { recursive: true });
  const sessionId = "reader-capability";
  const timestamp = "2026-09-14T12:00:00.000Z";
  const file = join(sessionDir, `${sessionId}.jsonl`);
  await writeFile(
    file,
    `${JSON.stringify({
      type: "user",
      uuid: "turn-0",
      cwd,
      sessionId,
      timestamp,
      message: { role: "user", content: "Find the needle here" },
    })}\n`,
  );
  const row: SessionCatalogRow = {
    catalogFamily: "claude",
    storeKey: projectsDir,
    sessionId,
    projectId: toUrlProjectId(cwd),
    projectPath: cwd,
    projectIdentityKey: cwd,
    updatedAt: timestamp,
    createdAt: timestamp,
    title: "Opening title",
    // Not on the advertised bounded-turn-search list, yet this fixture resolves
    // a reader that can read bounded turns.
    provider: "opencode",
    fidelity: "head",
    sourceVersion: "fixture-1",
    location: { kind: "file", path: file },
  };
  collections = new RetainedSessionCollections({
    dataDir: join(directory, "data"),
    database: openTestDiscoveryDatabase(join(directory, "data")),
    adapters: async () => [
      {
        catalogFamily: "claude",
        storeKey: projectsDir,
        scan: async () => ({ sourceVersion: "fixture-1", rows: [row] }),
      },
    ],
  });
  await collections.refresh();
  const app = new Hono().route(
    "/api/sessions",
    createGlobalSessionsRoutes({
      retainedCollections: collections,
      scanner: new ProjectScanner({
        projectsDir,
        enableCodex: false,
        enableGemini: false,
      }),
      readerFactory: () => new ClaudeSessionReader({ sessionDir }),
    }),
  );
  const response = await app.request("/api/sessions/content-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, query: "needle", roles: ["user"] }),
  });
  expect(response.status).toBe(200);
  const batch = (await response.json()) as SessionContentSearchBatch;
  expect(batch.unavailable).toBeUndefined();
  expect(batch.matches.map((match) => match.id)).toEqual(["turn-0"]);
});

it("searches cold turns in bounded batches through the mounted route, with role/time filtering and sealed continuations", async () => {
  directory = await mkdtemp(join(tmpdir(), "session-content-search-"));
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const projectsDir = join(directory, "projects");
  const sessionDir = join(projectsDir, hostname(), cwd.replace(/[/\\]/g, "-"));
  await mkdir(sessionDir, { recursive: true });
  const sessionId = "bounded-search";
  const timestamp = "2026-09-14T12:00:00.000Z";
  const entries = Array.from({ length: 260 }, (_, index) => ({
    type: index % 2 ? "assistant" : "user",
    uuid: `turn-${index}`,
    cwd,
    sessionId,
    timestamp,
    message: {
      role: index % 2 ? "assistant" : "user",
      content: `Find the needle ${index} escaped\\nline ${"x".repeat(1000)}`,
    },
  }));
  const file = join(sessionDir, `${sessionId}.jsonl`);
  await writeFile(
    file,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const row: SessionCatalogRow = {
    catalogFamily: "claude",
    storeKey: projectsDir,
    sessionId,
    projectId: toUrlProjectId(cwd),
    projectPath: cwd,
    projectIdentityKey: cwd,
    updatedAt: timestamp,
    createdAt: timestamp,
    title: "Opening title",
    provider: "claude",
    fidelity: "head",
    sourceVersion: "fixture-1",
    location: { kind: "file", path: file },
  };
  collections = new RetainedSessionCollections({
    dataDir: join(directory, "data"),
    database: openTestDiscoveryDatabase(join(directory, "data")),
    adapters: async () => [
      {
        catalogFamily: "claude",
        storeKey: projectsDir,
        scan: async () => ({ sourceVersion: "fixture-1", rows: [row] }),
      },
    ],
  });
  await collections.refresh();
  const app = new Hono().route(
    "/api/sessions",
    createGlobalSessionsRoutes({
      retainedCollections: collections,
      scanner: new ProjectScanner({
        projectsDir,
        enableCodex: false,
        enableGemini: false,
      }),
      readerFactory: () => new ClaudeSessionReader({ sessionDir }),
    }),
  );
  const request = {
    sessionId,
    query: "needle",
    roles: ["assistant"],
    after: Date.parse(timestamp),
    before: Date.parse(timestamp),
  };
  const post = (body: unknown) =>
    app.request("/api/sessions/content-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const firstResponse = await post(request);
  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as SessionContentSearchBatch;
  expect(first.done).toBe(false);
  expect(first.matches).toHaveLength(64);
  expect(first.matches.every((m) => m.role === "assistant")).toBe(true);
  expect(first.matches.every((m) => m.preview.length < 180)).toBe(true);
  const fullRequest = {
    ...request,
    includeSearchText: true,
    allowRestart: true,
  };
  const fullFirst = (await (
    await post(fullRequest)
  ).json()) as SessionContentSearchBatch;
  expect(fullFirst.includesSearchText).toBe(true);
  expect(fullFirst.matches[0]?.searchText).toBe(entries[1]?.message.content);
  const escapedLine = (await (
    await post({ ...request, query: "escaped line" })
  ).json()) as SessionContentSearchBatch;
  expect(escapedLine.matches).toHaveLength(64);
  expect(escapedLine.matches.every((m) => m.preview.length < 180)).toBe(true);
  expect(first.bytesRead).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(
    (await post({ ...request, query: "different", cursor: first.cursor }))
      .status,
  ).toBe(400);
  expect(
    (await post({ ...request, cursor: `${first.cursor}bad` })).status,
  ).toBe(400);
  let batch = first;
  const matches = [...first.matches];
  while (!batch.done) {
    const response = await post({ ...request, cursor: batch.cursor });
    expect(response.status).toBe(200);
    batch = (await response.json()) as SessionContentSearchBatch;
    matches.push(...batch.matches);
  }
  expect(matches).toHaveLength(130);
  expect(matches.at(-1)?.id).toBe("turn-259");
  expect(new Set(matches.map((m) => m.id)).size).toBe(130);
  const excluded = (await (
    await post({
      ...request,
      after: Date.parse(timestamp) + 1,
      before: undefined,
    })
  ).json()) as SessionContentSearchBatch;
  expect(excluded.matches).toEqual([]);
  expect((await post({ ...request, sessionId: "missing" })).status).toBe(404);
  expect((await post({ ...request, after: 2, before: 1 })).status).toBe(400);
  const users = (await (
    await post({ ...request, roles: ["user"] })
  ).json()) as SessionContentSearchBatch;
  expect(users.matches).toHaveLength(64);
  expect(users.matches[0]?.id).toBe("turn-0");
  row.sourceVersion = "fixture-2";
  await collections.refresh();
  expect((await post({ ...request, cursor: first.cursor })).status).toBe(409);
  const changedContinuation = await post({
    ...fullRequest,
    cursor: fullFirst.cursor,
  });
  expect(changedContinuation.status).toBe(200);
  expect(
    ((await changedContinuation.json()) as SessionContentSearchBatch).reset,
  ).toBeUndefined();
  expect(batch.resumeCursor).toEqual(expect.any(String));
  await appendFile(
    file,
    `${JSON.stringify({ ...entries[1], uuid: "appended", message: { role: "assistant", content: "new needle" } })}\n`,
  );
  row.sourceVersion = "fixture-3";
  await collections.refresh();
  const appendedResponse = await post({
    ...request,
    cursor: batch.resumeCursor,
  });
  expect(appendedResponse.status).toBe(200);
  const appended = (await appendedResponse.json()) as SessionContentSearchBatch;
  expect(appended.matches.map((match) => match.id)).toEqual(["appended"]);
  expect(appended.bytesRead).toBeLessThan(2000);
  expect(appended.done).toBe(true);
  await writeFile(file, `${JSON.stringify(entries[0])}\n`);
  row.sourceVersion = "fixture-4";
  await collections.refresh();
  expect(
    (await post({ ...request, cursor: appended.resumeCursor })).status,
  ).toBe(409);
  const resetResponse = await post({
    ...fullRequest,
    cursor: fullFirst.cursor,
  });
  expect(resetResponse.status).toBe(200);
  const reset = (await resetResponse.json()) as SessionContentSearchBatch;
  expect(reset.reset).toBe(true);
  expect(reset.partial).toBe(false);
  expect(reset.resumeCursor).toEqual(expect.any(String));
});
