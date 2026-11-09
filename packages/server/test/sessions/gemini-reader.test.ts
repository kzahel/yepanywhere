import { readFile } from "node:fs/promises";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseNativeSessionId, toUrlProjectId } from "@yep-anywhere/shared";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { collectionCatalogAdapters } from "../../src/sessions/catalog-adapters/collection-catalog-adapters.js";
import { GeminiSessionReader } from "../../src/sessions/gemini-reader.js";
import { hashProjectPath } from "../../src/projects/gemini-project-map.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

const roots: string[] = [];
afterEach(async () => {
  closeTestDiscoveryDatabases();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gemini-native-reader-")),
  );
  roots.push(root);
  const project = join(root, "project"),
    otherProject = join(root, "other-project"),
    sessionsDir = join(root, "native"),
    chatsDir = join(sessionsDir, "native-slug", "chats");
  await mkdir(chatsDir, { recursive: true });
  const write = async (
    id: string,
    projectHash = hashProjectPath(project),
    filename = id,
  ) => {
    const file = join(chatsDir, `session-${filename}.json`);
    await writeFile(
      file,
      JSON.stringify({
        sessionId: id,
        projectHash,
        startTime: "2026-11-01T00:00:00Z",
        lastUpdated: "2026-11-01T00:00:01Z",
        messages: [
          {
            id: "u1",
            type: "user",
            timestamp: "2026-11-01T00:00:01Z",
            content: `history ${id}`,
          },
        ],
      }),
    );
    return file;
  };
  return {
    project,
    otherProject,
    sessionsDir,
    chatsDir,
    write,
    projectId: toUrlProjectId(project),
  };
}

it("uses header hash membership for point, root and chat enumeration and revalidates warmed source replacement", async () => {
  const f = await fixture();
  await f.write("owned");
  await f.write("foreign", hashProjectPath(f.otherProject));
  const reader = new GeminiSessionReader({
    sessionsDir: f.sessionsDir,
    projectPath: f.project,
  });
  try {
    expect((await reader.getSession("owned", f.projectId))?.summary.title).toBe(
      "history owned",
    );
    expect(await reader.getSession("foreign", f.projectId)).toBeNull();
    expect(await reader.getSessionSummary("foreign", f.projectId)).toBeNull();
    expect(await reader.getSessionFilePath("foreign")).toBeNull();
    expect(
      await reader.getNativeSessionRef(parseNativeSessionId("foreign")),
    ).toBeNull();
    for (const directory of [f.sessionsDir, f.chatsDir])
      expect(
        (await reader.listSessionFiles(directory)).map((x) => x.sessionId),
      ).toEqual(["owned"]);
    expect((await reader.listSessions(f.projectId)).map((x) => x.id)).toEqual([
      "owned",
    ]);
    await f.write("owned", hashProjectPath(f.otherProject));
    for (let n = 0; n < 2; n++) {
      expect(await reader.getSession("owned", f.projectId)).toBeNull();
      expect(await reader.getSessionFilePath("owned")).toBeNull();
      expect(
        await reader.getNativeSessionRef(parseNativeSessionId("owned")),
      ).toBeNull();
    }
  } finally {
    reader.close();
  }
});

it("rejects a changed canonical header id even when its filename retains the requested id", async () => {
  const f = await fixture();
  await f.write("owned");
  const reader = new GeminiSessionReader({
    sessionsDir: f.sessionsDir,
    projectPath: f.project,
  });
  try {
    expect(await reader.getSession("owned", f.projectId)).not.toBeNull();
    await f.write("replacement", hashProjectPath(f.project), "owned");
    for (let n = 0; n < 2; n++) {
      expect(await reader.getSession("owned", f.projectId)).toBeNull();
      expect(await reader.getSessionFilePath("owned")).toBeNull();
    }
    expect(
      (await reader.getSession("replacement", f.projectId))?.summary.id,
    ).toBe("replacement");
  } finally {
    reader.close();
  }
});

it("retains unknown-project hash coordinates without treating unrelated hashes as members", async () => {
  const f = await fixture(),
    hash = hashProjectPath(f.project),
    unknown = `gemini:${hash.slice(0, 8)}`;
  await f.write("owned");
  await f.write("foreign", hashProjectPath(f.otherProject));
  const reader = new GeminiSessionReader({
    sessionsDir: f.sessionsDir,
    projectPath: unknown,
  });
  try {
    expect(
      (await reader.listSessions(toUrlProjectId(unknown))).map((x) => x.id),
    ).toEqual(["owned"]);
    expect(await reader.getSessionFilePath("foreign")).toBeNull();
    expect(
      await reader.getNativeSessionRef(parseNativeSessionId("owned")),
    ).toMatchObject({ storageScope: f.sessionsDir, id: "owned" });
  } finally {
    reader.close();
  }
});

it.each(["history", "summary", "conditional", "file", "native"] as const)(
  "discards a pending real %s result on retirement",
  async (method) => {
    const f = await fixture();
    await f.write("owned");
    const reader = new GeminiSessionReader({
      sessionsDir: f.sessionsDir,
      projectPath: f.project,
    });
    try {
      expect(await reader.getSession("owned", f.projectId)).not.toBeNull();
      const hooks = reader as unknown as {
        readStoredSession(entry: unknown): Promise<unknown>;
      };
      const read = hooks.readStoredSession.bind(reader);
      hooks.readStoredSession = (entry) => {
        const result = read(entry);
        void result.then(() => reader.close());
        return result;
      };
      const result = await (method === "history"
        ? reader.getSession("owned", f.projectId)
        : method === "summary"
          ? reader.getSessionSummary("owned", f.projectId)
          : method === "conditional"
            ? reader.getSessionSummaryIfChanged("owned", f.projectId, 0, 0)
            : method === "file"
              ? reader.getSessionFilePath("owned")
              : reader.getNativeSessionRef(parseNativeSessionId("owned")));
      expect(result).toBeNull();
      expect(await reader.listSessionFiles(f.sessionsDir)).toEqual([]);
      expect(await reader.listSessions(f.projectId)).toEqual([]);
    } finally {
      reader.close();
    }
  },
);

it("discards a partial list when retirement follows its second real stored read", async () => {
  const f = await fixture();
  await f.write("first");
  await f.write("second");
  const reader = new GeminiSessionReader({
    sessionsDir: f.sessionsDir,
    projectPath: f.project,
  });
  const hooks = reader as unknown as {
    readStoredSession(entry: unknown): Promise<unknown>;
  };
  const read = hooks.readStoredSession.bind(reader);
  let count = 0;
  hooks.readStoredSession = async (entry) => {
    const result = await read(entry);
    if (++count === 2) reader.close();
    return result;
  };
  try {
    expect(await reader.listSessions(f.projectId)).toEqual([]);
    expect(count).toBe(2);
  } finally {
    reader.close();
  }
});

it("omits a catalogue candidate whose native identity changes after enumeration", async () => {
  const f = await fixture();
  await f.write("owned");
  const reader = new GeminiSessionReader({
    sessionsDir: f.sessionsDir,
    projectPath: f.project,
  });
  const proof = reader.getNativeSessionRef.bind(reader);
  reader.getNativeSessionRef = async (id) => {
    await f.write("replacement", hashProjectPath(f.project), "owned");
    return proof(id);
  };
  const project = {
    id: f.projectId,
    path: f.project,
    name: "fixture",
    provider: "gemini" as const,
    sessionDir: f.sessionsDir,
  };
  const scanner = {
    listFileCatalogProjects: async () => [project],
  } as unknown as ProjectScanner;
  try {
    const adapters = await collectionCatalogAdapters(
      {
        scanner,
        getCatalogFamilies: () => ["gemini"],
        readerFactory: () => reader,
        geminiReaderFactory: () => reader,
        geminiSessionsDir: f.sessionsDir,
      },
      [],
      new AbortController().signal,
    );
    const rows = [];
    for (const adapter of adapters) {
      const scan = await adapter.scan({
        catalogEpoch: "test",
        targetGeneration: 1,
        mode: { kind: "complete" },
        signal: new AbortController().signal,
      });
      for await (const row of scan.rows) rows.push(row);
    }
    expect(rows).toEqual([]);
  } finally {
    reader.close();
  }
});

it("refreshes a warm native index on edits and creates before its validation interval", async () => {
  const f = await fixture(),
    file = await f.write("owned"),
    eventBus = new EventBus();
  const reader = new GeminiSessionReader({
    sessionsDir: f.sessionsDir,
    projectPath: f.project,
  });
  const index = new SessionIndexService({
    database: openTestDiscoveryDatabase(join(f.sessionsDir, "..")),
    dataDir: join(f.sessionsDir, "..", "index"),
    eventBus,
    fullValidationIntervalMs: 60000,
  });
  const changed = (path: string, changeType: "modify" | "create") =>
    eventBus.emit({
      type: "file-change",
      provider: "gemini",
      path,
      relativePath: path.slice(f.sessionsDir.length + 1),
      fileType: "session",
      changeType,
      timestamp: new Date().toISOString(),
    });
  try {
    await index.initialize();
    expect(
      (
        await index.getSessionsWithCache(f.sessionsDir, f.projectId, reader)
      ).map((row) => row.title),
    ).toEqual(["history owned"]);
    const data = JSON.parse(await readFile(file, "utf8"));
    data.messages[0].content = "edited native title before validation";
    await writeFile(file, JSON.stringify(data));
    changed(file, "modify");
    expect(
      (
        await index.getSessionsWithCache(f.sessionsDir, f.projectId, reader)
      ).map((row) => row.title),
    ).toEqual(["edited native title before validation"]);
    const created = await f.write("new-session");
    changed(created, "create");
    expect(
      (await index.getSessionsWithCache(f.sessionsDir, f.projectId, reader))
        .map((row) => row.id)
        .sort(),
    ).toEqual(["new-session", "owned"]);
  } finally {
    reader.close();
    index.dispose();
  }
});
