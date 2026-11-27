import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InstallService } from "../../packages/server/src/services/InstallService.ts";
import {
  claudeSession,
  codexRollout,
  codexSession,
} from "./scenario-transcripts.mjs";

// Native thread and spawn indexes used by YA, with cwd, the first prompt and
// the exact rollout path populated. All DB writes belong to the fixture.
export function mixedFixture({ population, projects, indexed }) {
  let paths, threads, upsert;
  const active = [];
  let archive;
  function make(number, project, at, writes) {
    const codex = number % 2 === 1;
    const { id, relativePath } = codexRollout(number + 1, at);
    const file = codex
      ? join(paths.codexSessionsDir, relativePath)
      : join(
          paths.claudeSessionsDir,
          hostname(),
          project.replace(/[^a-zA-Z0-9]/g, "-"),
          id + ".jsonl",
        );
    const generator = (codex ? codexSession : claudeSession)({
      sessionId: id,
      projectPath: project,
      resultLines: 8,
      answerBytes: 60,
    });
    const session = {
      id,
      file,
      project,
      provider: codex ? "codex" : "claude",
      marker: "",
      generator,
    };
    const rows = codex ? [generator.head(at)] : [];
    for (let i = 0; i < writes; i++) rows.push(...next(session, at + i));
    if (codex && indexed) {
      // Codex seeds its thread title from the first user message.
      const user = rows
        .slice(1, 5)
        .map((line) => JSON.parse(line))
        .find(
          (row) => row.type === "response_item" && row.payload.role === "user",
        );
      session.title = user.payload.content[0].text;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rows.join("\n") + "\n");
    const updated = at + writes;
    utimesSync(file, updated / 1000, updated / 1000);
    index(session, updated);
    return session;
  }
  function next(session, at) {
    const { rows, marker } = session.generator.next(at);
    if (!marker) return rows;
    session.marker = marker + "s" + session.id.slice(-12);
    return rows.map((row) => row.replaceAll(marker, session.marker));
  }
  function index(s, at) {
    if (s.provider === "codex")
      upsert?.run(s.id, s.file, Math.floor(at / 1000), at, s.project, s.title);
  }
  return {
    active,
    get archive() {
      return archive;
    },
    get paths() {
      return paths;
    },
    make,
    append(session) {
      const at = Date.now();
      appendFileSync(session.file, next(session, at).join("\n") + "\n");
      index(session, at);
    },
    async setup(p) {
      paths = { ...p, project: join(p.tempDir, "active") };
      mkdirSync(paths.project);
      if (indexed) {
        threads = new DatabaseSync(
          join(dirname(p.codexSessionsDir), "state_5.sqlite"),
        );
        threads.exec(`PRAGMA journal_mode=WAL;
          CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL,updated_at INTEGER NOT NULL,updated_at_ms INTEGER,cwd TEXT NOT NULL,title TEXT NOT NULL);
          CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC,id DESC);
          CREATE TABLE thread_spawn_edges(parent_thread_id TEXT NOT NULL,child_thread_id TEXT PRIMARY KEY,status TEXT NOT NULL);
          CREATE INDEX idx_thread_spawn_edges_parent_status ON thread_spawn_edges(parent_thread_id,status);
          BEGIN;`);
        upsert = threads.prepare(`INSERT INTO threads VALUES(?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,updated_at_ms=excluded.updated_at_ms`);
      }
      const install = new InstallService({ dataDir: p.dataDir });
      await install.initialize();
      await install.recordSuccessfulProviders(["claude", "codex"]);
      const epoch = Date.now() - 30000;
      for (let i = 0; i < population; i++) {
        const project = join(
          p.tempDir,
          "archive-" + (Math.floor(i / 2) % projects),
        );
        mkdirSync(project, { recursive: true });
        archive = make(i, project, epoch - 86400000, 1);
      }
      for (let i = 0; i < 10; i++)
        active.push(
          make(100000 + i, paths.project, epoch + i * 200, i >= 8 ? 160 : 4),
        );
      threads?.exec("COMMIT");
    },
    close() {
      threads?.close();
    },
  };
}
