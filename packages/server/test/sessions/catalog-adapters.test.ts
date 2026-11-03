import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionCatalogService } from "../../src/services/SessionCatalogService.js";
import { GrokSessionCatalogAdapter } from "../../src/sessions/catalog-adapters/grok-catalog-adapter.js";
import { OpenCodeSessionCatalogAdapter } from "../../src/sessions/catalog-adapters/opencode-catalog-adapter.js";
import { AntigravitySessionCatalogAdapter } from "../../src/sessions/catalog-adapters/antigravity-catalog-adapter.js";
import { PiSessionCatalogAdapter } from "../../src/sessions/catalog-adapters/pi-catalog-adapter.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogRow,
  SessionCatalogScanContext,
  SessionCatalogScanMode,
} from "../../src/sessions/catalog-types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ya-catalog-adapter-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(
  mode: SessionCatalogScanMode = { kind: "complete" },
): SessionCatalogScanContext {
  return {
    catalogEpoch: "epoch-1",
    targetGeneration: 1,
    mode,
    signal: new AbortController().signal,
  };
}

async function collect(
  adapter: NativeSessionCatalogAdapter,
  mode?: SessionCatalogScanMode,
): Promise<{ rows: SessionCatalogRow[]; metrics: Record<string, number> }> {
  const scan = await adapter.scan(context(mode));
  const rows: SessionCatalogRow[] = [];
  for await (const row of scan.rows as AsyncIterable<SessionCatalogRow>) {
    rows.push(row);
  }
  rows.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  return { rows, metrics: { ...scan.metrics } };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf-8");
}

describe("GrokSessionCatalogAdapter", () => {
  async function seedGrok(): Promise<string> {
    const sessionsDir = join(root, "grok", "sessions");
    await writeJson(
      join(
        sessionsDir,
        encodeURIComponent("/work/alpha"),
        "s-alpha",
        "summary.json",
      ),
      {
        info: { id: "s-alpha", cwd: "/work/alpha" },
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-02T00:00:00.000Z",
        generated_title: "Alpha work",
      },
    );
    await writeJson(
      join(
        sessionsDir,
        encodeURIComponent("/work/beta"),
        "s-beta",
        "summary.json",
      ),
      {
        info: { id: "s-beta", cwd: "/work/beta" },
        updated_at: "2026-07-01T00:00:00.000Z",
        session_summary: "Beta work",
      },
    );
    return sessionsDir;
  }

  it("enumerates every project's sessions in one walk", async () => {
    const sessionsDir = await seedGrok();
    const { rows, metrics } = await collect(
      new GrokSessionCatalogAdapter({ sessionsDir }),
    );

    expect(rows.map((row) => row.sessionId)).toEqual(["s-alpha", "s-beta"]);
    expect(rows[0]).toMatchObject({
      catalogFamily: "grok",
      projectPath: "/work/alpha",
      projectIdentityKey: "/work/alpha",
      title: "Alpha work",
      fidelity: "head",
      updatedAt: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    // One walk covered both projects; a per-project reader repeats it per project.
    expect(metrics.cwdDirsVisited).toBe(2);
  });

  it("hides Grok subagent session dirs from the catalog", async () => {
    const sessionsDir = await seedGrok();
    const parentDir = join(
      sessionsDir,
      encodeURIComponent("/work/alpha"),
      "s-alpha",
    );
    await writeJson(join(parentDir, "subagents", "s-child", "meta.json"), {
      subagent_id: "s-child",
      parent_session_id: "s-alpha",
      child_session_id: "s-child",
    });
    await writeJson(
      join(
        sessionsDir,
        encodeURIComponent("/work/alpha"),
        "s-child",
        "summary.json",
      ),
      {
        info: { id: "s-child", cwd: "/work/alpha" },
        updated_at: "2026-08-02T00:05:00.000Z",
        generated_title: "Child explore",
      },
    );

    const { rows } = await collect(
      new GrokSessionCatalogAdapter({ sessionsDir }),
    );
    expect(rows.map((row) => row.sessionId)).toEqual(["s-alpha", "s-beta"]);
  });

  it("keeps a row identity that changes when its summary is rewritten", async () => {
    const sessionsDir = await seedGrok();
    const adapter = new GrokSessionCatalogAdapter({ sessionsDir });
    const before = (await collect(adapter)).rows[0]?.sourceVersion;

    const path = join(
      sessionsDir,
      encodeURIComponent("/work/alpha"),
      "s-alpha",
      "summary.json",
    );
    await writeJson(path, {
      info: { id: "s-alpha", cwd: "/work/alpha" },
      updated_at: "2026-08-03T00:00:00.000Z",
      generated_title: "Alpha work, continued",
    });
    const after = (await collect(adapter)).rows[0]?.sourceVersion;

    expect(before).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("drops sessions outside a recent window without reading them", async () => {
    const sessionsDir = await seedGrok();
    const stale = join(
      sessionsDir,
      encodeURIComponent("/work/beta"),
      "s-beta",
      "summary.json",
    );
    const staleMs = Date.parse("2026-07-01T00:00:00.000Z");
    await utimes(stale, staleMs / 1000, staleMs / 1000);

    const { rows, metrics } = await collect(
      new GrokSessionCatalogAdapter({ sessionsDir }),
      { kind: "recent", activeAfterMs: Date.parse("2026-07-15T00:00:00.000Z") },
    );

    expect(rows.map((row) => row.sessionId)).toEqual(["s-alpha"]);
    expect(metrics.skippedByMode).toBe(1);
    expect(metrics.summariesRead).toBe(1);
  });

  it("reports no rows for a store that was never created", async () => {
    const { rows } = await collect(
      new GrokSessionCatalogAdapter({ sessionsDir: join(root, "absent") }),
    );
    expect(rows).toEqual([]);
  });
});

describe("PiSessionCatalogAdapter", () => {
  async function seedPi(): Promise<string> {
    const sessionsDir = join(root, "pi", "sessions");
    const alphaDir = join(sessionsDir, "--work-alpha--");
    await mkdir(alphaDir, { recursive: true });
    await writeFile(
      join(alphaDir, "2026-06-22T00-00-00-000Z_s-alpha.jsonl"),
      `${JSON.stringify({ type: "session", cwd: "/work/alpha" })}\n`,
      "utf-8",
    );
    const betaDir = join(sessionsDir, "--work-beta--");
    await mkdir(betaDir, { recursive: true });
    await writeFile(
      join(betaDir, "2026-06-23T01-02-03-456Z_s-beta.jsonl"),
      `${JSON.stringify({ type: "session", cwd: "/work/beta" })}\n`,
      "utf-8",
    );
    return sessionsDir;
  }

  it("takes project membership from the transcript header, not the directory", async () => {
    const sessionsDir = await seedPi();
    const { rows, metrics } = await collect(
      new PiSessionCatalogAdapter({ sessionsDir }),
    );

    expect(rows.map((row) => row.sessionId)).toEqual(["s-alpha", "s-beta"]);
    // The flattened directory name is lossy; only the header names the path.
    expect(rows[0]?.projectPath).toBe("/work/alpha");
    expect(rows[1]?.projectPath).toBe("/work/beta");
    expect(metrics.headersRead).toBe(2);
  });

  it("recovers the creation time pi encodes in each filename", async () => {
    const sessionsDir = await seedPi();
    const { rows } = await collect(
      new PiSessionCatalogAdapter({ sessionsDir }),
    );

    expect(rows[1]?.createdAt).toBe("2026-06-23T01:02:03.456Z");
  });

  it("stays at identity fidelity, since pi has no native summary", async () => {
    const sessionsDir = await seedPi();
    const { rows } = await collect(
      new PiSessionCatalogAdapter({ sessionsDir }),
    );

    expect(rows.every((row) => row.fidelity === "identity")).toBe(true);
    expect(rows.every((row) => row.title === undefined)).toBe(true);
  });

  it("skips a stale transcript's header read in recent mode", async () => {
    const sessionsDir = await seedPi();
    const stale = join(
      sessionsDir,
      "--work-beta--",
      "2026-06-23T01-02-03-456Z_s-beta.jsonl",
    );
    const staleMs = Date.parse("2026-06-23T01:02:03.456Z");
    await utimes(stale, staleMs / 1000, staleMs / 1000);

    const { rows, metrics } = await collect(
      new PiSessionCatalogAdapter({ sessionsDir }),
      { kind: "recent", activeAfterMs: Date.parse("2026-07-01T00:00:00.000Z") },
    );

    expect(rows.map((row) => row.sessionId)).toEqual(["s-alpha"]);
    expect(metrics.transcriptsSeen).toBe(2);
    expect(metrics.headersRead).toBe(1);
  });
});

describe("catalog coordinator integration", () => {
  it("groups one pass over three provider stores by project", async () => {
    const grokDir = join(root, "grok", "sessions");
    await writeJson(
      join(grokDir, encodeURIComponent("/work/shared"), "g-1", "summary.json"),
      {
        info: { id: "g-1", cwd: "/work/shared" },
        updated_at: "2026-08-02T00:00:00.000Z",
        generated_title: "Grok on shared",
      },
    );

    const piDir = join(root, "pi", "sessions");
    await mkdir(join(piDir, "--work-shared--"), { recursive: true });
    await writeFile(
      join(piDir, "--work-shared--", "2026-06-22T00-00-00-000Z_p-1.jsonl"),
      `${JSON.stringify({ type: "session", cwd: "/work/shared" })}\n`,
      "utf-8",
    );

    const openCodeDir = join(root, "opencode", "storage");
    await writeJson(join(openCodeDir, "project", "prj.json"), {
      id: "prj",
      worktree: "/work/other",
    });
    await writeJson(join(openCodeDir, "session", "prj", "o-1.json"), {
      id: "o-1",
      title: "OpenCode elsewhere",
      time: { updated: Date.parse("2026-08-03T00:00:00.000Z") },
    });

    const catalog = new SessionCatalogService({
      dataDir: join(root, "data"),
    });
    await catalog.initialize();
    const result = await catalog.reconcile([
      new GrokSessionCatalogAdapter({ sessionsDir: grokDir }),
      new PiSessionCatalogAdapter({ sessionsDir: piDir }),
      new OpenCodeSessionCatalogAdapter({
        storageDir: openCodeDir,
        databasePath: join(root, "absent.db"),
      }),
    ]);

    expect(result.status).toBe("computed");
    expect(result.snapshot.rowCount).toBe(3);

    // Two families landed in one project; the third project stays separate.
    const shared = await catalog.readProjectRows("/work/shared");
    expect(shared.rows.map((row) => row.catalogFamily).sort()).toEqual([
      "grok",
      "pi",
    ]);
    const other = await catalog.readProjectRows("/work/other");
    expect(other.rows.map((row) => row.sessionId)).toEqual(["o-1"]);

    catalog.stop();
  });
});

describe("OpenCodeSessionCatalogAdapter", () => {
  async function seedOpenCode(): Promise<string> {
    const storageDir = join(root, "opencode", "storage");
    await writeJson(join(storageDir, "project", "prj-alpha.json"), {
      id: "prj-alpha",
      worktree: "/work/alpha",
    });
    await writeJson(join(storageDir, "project", "global.json"), {
      id: "global",
      worktree: "/",
    });
    await writeJson(
      join(storageDir, "session", "prj-alpha", "ses-legacy.json"),
      {
        id: "ses-legacy",
        title: "Legacy file session",
        time: {
          created: Date.parse("2026-05-01T00:00:00.000Z"),
          updated: Date.parse("2026-05-02T00:00:00.000Z"),
        },
      },
    );
    return storageDir;
  }

  it("resolves the opaque project id to a worktree once for the install", async () => {
    const storageDir = await seedOpenCode();
    const { rows, metrics } = await collect(
      new OpenCodeSessionCatalogAdapter({
        storageDir,
        databasePath: join(root, "absent.db"),
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      catalogFamily: "opencode",
      sessionId: "ses-legacy",
      projectPath: "/work/alpha",
      title: "Legacy file session",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });
    // global.json is OpenCode's own scratch project, not a worktree.
    expect(metrics.projectsRead).toBe(1);
  });

  it("reports no rows when neither store exists", async () => {
    const { rows } = await collect(
      new OpenCodeSessionCatalogAdapter({
        storageDir: join(root, "absent"),
        databasePath: join(root, "absent.db"),
      }),
    );
    expect(rows).toEqual([]);
  });

  it("keeps legacy file sessions outside a recent window out of the pass", async () => {
    const storageDir = await seedOpenCode();
    const { rows, metrics } = await collect(
      new OpenCodeSessionCatalogAdapter({
        storageDir,
        databasePath: join(root, "absent.db"),
      }),
      { kind: "recent", activeAfterMs: Date.parse("2026-06-01T00:00:00.000Z") },
    );

    expect(rows).toEqual([]);
    expect(metrics.skippedByMode).toBe(1);
  });

  it("omits file-tree sessions that name a parentID", async () => {
    const storageDir = await seedOpenCode();
    await writeJson(
      join(storageDir, "session", "prj-alpha", "ses-child.json"),
      {
        id: "ses-child",
        parentID: "ses-legacy",
        title: "Explore (@explore subagent)",
        time: {
          created: Date.parse("2026-05-03T00:00:00.000Z"),
          updated: Date.parse("2026-05-04T00:00:00.000Z"),
        },
      },
    );
    const { rows } = await collect(
      new OpenCodeSessionCatalogAdapter({
        storageDir,
        databasePath: join(root, "absent.db"),
      }),
    );
    expect(rows.map((row) => row.sessionId)).toEqual(["ses-legacy"]);
  });
});

describe("AntigravitySessionCatalogAdapter", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  async function seed(directory = join(root, "agy")) {
    await mkdir(directory, { recursive: true });
    await writeJson(join(directory, `${id}.meta`), { cwd: "/work/agy-only" });
    // Deliberately not a SQLite database: discovery must never open history.
    await writeFile(join(directory, `${id}.db`), "opaque native bytes");
    return directory;
  }

  it("discovers native identity without a runtime and versions WAL writes", async () => {
    const directory = await seed();
    const adapter = new AntigravitySessionCatalogAdapter({
      sessionsDir: directory,
    });
    const first = await collect(adapter);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({
      sessionId: id,
      projectPath: "/work/agy-only",
      fidelity: "identity",
      nativeStorageScope: await realpath(directory),
    });
    expect(first.rows[0]?.title).toBeUndefined();
    await writeFile(join(directory, `${id}.db-wal`), "new native activity");
    const next = await collect(adapter);
    expect(next.rows[0]?.sourceVersion).not.toBe(first.rows[0]?.sourceVersion);
  });

  it("keeps accepted rows on malformed acquisition and rejects out-of-store aliases", async () => {
    const directory = await seed();
    const adapter = new AntigravitySessionCatalogAdapter({
      sessionsDir: directory,
    });
    const catalog = new SessionCatalogService({
      dataDir: join(root, "catalog"),
    });
    await catalog.initialize();
    await catalog.reconcile([adapter]);
    const before = await catalog.readRows();
    await writeFile(join(directory, `${id}.meta`), "{");
    await expect(catalog.reconcile([adapter])).rejects.toThrow();
    expect((await catalog.readRows()).rows).toEqual(before.rows);
    await writeJson(join(directory, `${id}.meta`), { cwd: "/work/agy-only" });
    await rm(join(directory, `${id}.db`));
    const outside = join(root, "outside.db");
    await writeFile(outside, "opaque");
    await symlink(outside, join(directory, `${id}.db`));
    await expect(collect(adapter)).rejects.toThrow("escapes");
    await catalog.stop();
  });

  it("treats a missing store as empty, but not a root that is a file", async () => {
    const directory = join(root, "not-a-directory");
    const adapter = new AntigravitySessionCatalogAdapter({
      sessionsDir: directory,
    });
    expect((await collect(adapter)).rows).toEqual([]);
    await writeFile(directory, "wrong type");
    await expect(collect(adapter)).rejects.toThrow();
  });
});
