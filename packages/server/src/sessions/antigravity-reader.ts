import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  type NativeSessionId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { Message, SessionSummary } from "../supervisor/types.js";
import {
  AntigravityRuntime,
  type AntigravitySessionSetup,
  antigravityLiveHistory,
  antigravitySessionOwned,
  antigravitySessionsDir,
  findAntigravityRuntime,
  ownAntigravitySession,
} from "../sdk/providers/antigravity-runtime.js";
import { AntigravityTranscript } from "../sdk/providers/antigravity-transcript.js";
import type { ISessionReader, LoadedSession } from "./types.js";

interface NativeListEntry {
  sessionId: string;
  title?: string;
  updatedAt?: string;
}

// At most four native roots / 2,000 metadata rows each. Reads coalesce on demand;
// there is no timer, watcher, transcript scan or subprocess for unrelated projects.
const projectInventories = new Map<
  string,
  {
    expiresAt: number;
    projects: Promise<Set<string>>;
  }
>();

async function nativeProjects(directory: string): Promise<Set<string>> {
  const cached = projectInventories.get(directory);
  if (cached && Date.now() < cached.expiresAt) return cached.projects;
  const projects = (async () => {
    const files = (
      await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })
    ).filter((file) => /^[0-9a-f-]{36}\.meta$/i.test(file));
    if (files.length > 2_000)
      throw new Error(
        "Antigravity native store exceeds the experimental session limit",
      );
    const result = new Set<string>();
    for (let offset = 0; offset < files.length; offset += 8) {
      await Promise.all(
        files.slice(offset, offset + 8).map(async (file) => {
          const path = join(directory, file);
          if ((await stat(path)).size > 16_384) return;
          const meta = JSON.parse(await readFile(path, "utf8")) as {
            cwd?: unknown;
          };
          if (typeof meta.cwd === "string") {
            const physical = await realpath(meta.cwd).catch(() => null);
            if (physical) result.add(physical);
          }
        }),
      );
    }
    return result;
  })();
  projectInventories.delete(directory);
  projectInventories.set(directory, {
    expiresAt: Date.now() + 5_000,
    projects,
  });
  while (projectInventories.size > 4)
    projectInventories.delete(projectInventories.keys().next().value!);
  try {
    return await projects;
  } catch (error) {
    if (projectInventories.get(directory)?.projects === projects)
      projectInventories.delete(directory);
    throw error;
  }
}

/** Read Google's native ACP store through its own replay API, never a YA transcript.
 * No background watcher or polling: bounded reads are owned by explicit interest.
 */
export class AntigravitySessionReader implements ISessionReader {
  private readonly directory: string;
  private readonly projectPath: string;
  // One coalesced list and at most eight active detail reads per cached reader.
  private listing?: Promise<NativeListEntry[]>;
  private listCache?: { at: number; rows: NativeListEntry[] };
  private details = new Map<string, Promise<LoadedSession | null>>();
  private runtimes = new Set<AntigravityRuntime>();
  private closed = false;

  constructor(options: { projectPath: string; sessionsDir?: string }) {
    this.projectPath = options.projectPath;
    this.directory = options.sessionsDir ?? antigravitySessionsDir();
  }

  private async metadata(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) return null;
    const base = join(this.directory, id);
    try {
      const [scope, metaPath, dbPath, info] = await Promise.all([
        realpath(this.directory),
        realpath(`${base}.meta`),
        realpath(`${base}.db`),
        stat(`${base}.db`),
      ]);
      if (
        dirname(metaPath) !== scope ||
        dirname(dbPath) !== scope ||
        !info.isFile()
      )
        return null;
      if ((await stat(metaPath)).size > 16_384) return null;
      const metadata = JSON.parse(await readFile(metaPath, "utf8")) as {
        cwd?: unknown;
      };
      if (
        typeof metadata.cwd !== "string" ||
        (await realpath(metadata.cwd)) !== (await realpath(this.projectPath))
      )
        return null;
      return { scope, cwd: metadata.cwd, path: dbPath, info };
    } catch {
      return null;
    }
  }

  private async withRuntime<T>(
    operation: (runtime: AntigravityRuntime) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error("Antigravity reader is closed");
    const command = await findAntigravityRuntime();
    if (!command) throw new Error("Antigravity ACP runtime is not installed");
    const runtime = new AntigravityRuntime();
    this.runtimes.add(runtime);
    try {
      await runtime.connect(command, this.projectPath);
      return await operation(runtime);
    } finally {
      await runtime.close();
      this.runtimes.delete(runtime);
    }
  }

  private async nativeList(): Promise<NativeListEntry[]> {
    if (this.listCache && Date.now() - this.listCache.at < 5_000)
      return this.listCache.rows;
    if (this.listing) return this.listing;
    this.listing = this.withRuntime(async (runtime) => {
      const result = await runtime.call<{
        sessions?: NativeListEntry[];
        nextCursor?: string;
      }>("session/list", { cwd: this.projectPath });
      if (result.nextCursor || (result.sessions?.length ?? 0) > 2_000)
        throw new Error(
          "Antigravity session list exceeds the experimental limit",
        );
      const rows = result.sessions ?? [];
      this.listCache = { at: Date.now(), rows };
      return rows;
    });
    try {
      return await this.listing;
    } finally {
      this.listing = undefined;
    }
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    // An absent native store is cheap and must not start a process for every project.
    if (
      !(await nativeProjects(this.directory)).has(
        await realpath(this.projectPath),
      )
    )
      return [];
    const rows = await this.nativeList();
    const summaries: SessionSummary[] = [];
    for (const row of rows) {
      const summary = await this.summary(row.sessionId, projectId, row);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  private async summary(
    id: string,
    projectId: UrlProjectId,
    row?: NativeListEntry,
  ): Promise<SessionSummary | null> {
    const metadata = await this.metadata(id);
    if (!metadata) return null;
    return {
      id,
      projectId,
      provider: "antigravity",
      title: row?.title || "Antigravity session",
      fullTitle: row?.title || null,
      createdAt: metadata.info.birthtime.toISOString(),
      updatedAt: metadata.info.mtime.toISOString(),
      messageCount: 0,
      ownership: { owner: "external" },
    };
  }

  async getSessionSummary(
    id: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    if (!(await this.metadata(id))) return null;
    const row = (await this.nativeList()).find(
      (entry) => entry.sessionId === id,
    );
    return this.summary(id, projectId, row);
  }

  async getSession(
    id: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
  ): Promise<LoadedSession | null> {
    const key = `${projectId}:${id}`;
    let pending = this.details.get(key);
    if (!pending) {
      if (this.details.size >= 8)
        throw new Error("Too many Antigravity history reads");
      pending = this.readSession(id, projectId);
      this.details.set(key, pending);
      void pending.finally(() => this.details.delete(key)).catch(() => {});
    }
    const loaded = await pending;
    if (!loaded || !afterMessageId || loaded.data.provider !== "antigravity")
      return loaded;
    const messages = loaded.data.session.messages;
    const index = messages.findIndex(
      (message) => message.uuid === afterMessageId,
    );
    return {
      ...loaded,
      data: {
        provider: "antigravity",
        session: { messages: index < 0 ? messages : messages.slice(index + 1) },
      },
    };
  }

  private async readSession(
    id: string,
    projectId: UrlProjectId,
  ): Promise<LoadedSession | null> {
    const metadata = await this.metadata(id);
    if (!metadata) return null;
    // The live owner already carries replay + new output. Native session/load
    // may update continuation metadata, so never run it beside that owner.
    let entries = antigravityLiveHistory(metadata.scope, id);
    let model = entries
      ?.slice()
      .reverse()
      .find((entry) => entry.type === "assistant" && entry.message?.model)
      ?.message?.model;
    if (!entries) {
      if (antigravitySessionOwned(metadata.scope, id)) return null;
      const owner = ownAntigravitySession(metadata.scope, id);
      const transcript = new AntigravityTranscript(id);
      try {
        await this.withRuntime(async (runtime) => {
          runtime.onUpdate = (update, sessionId) => {
            if (sessionId === id) transcript.accept(update);
          };
          // Never prompt, authenticate, or allocate a replacement when reading history.
          const setup = await runtime.call<AntigravitySessionSetup>(
            "session/load",
            {
              sessionId: id,
              cwd: metadata.cwd,
              mcpServers: [],
            },
          );
          model = setup.models?.currentModelId;
        });
      } finally {
        owner.release();
      }
      entries = transcript.messages;
    }
    const messages: Message[] = entries.map((entry) => ({
      ...entry,
      message: entry.message
        ? {
            ...entry.message,
            content:
              typeof entry.message.content === "string"
                ? entry.message.content
                : entry.message.content.map((block) => ({ ...block })),
          }
        : undefined,
    }));
    const summary = await this.summary(id, projectId);
    if (!summary) return null;
    const first = messages.find(
      (message) =>
        message.type === "user" && typeof message.message?.content === "string",
    );
    const title =
      typeof first?.message?.content === "string"
        ? first.message.content
        : null;
    summary.title = title?.slice(0, 120) ?? null;
    summary.fullTitle = title;
    summary.messageCount = messages.length;
    summary.model = model;
    return {
      summary,
      transcriptSnapshotUpdatedAt: metadata.info.mtime.toISOString(),
      data: { provider: "antigravity", session: { messages } },
    };
  }

  async getSessionSummaryIfChanged(
    id: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ) {
    const metadata = await this.metadata(id);
    if (
      !metadata ||
      (metadata.info.mtimeMs === cachedMtime &&
        metadata.info.size === cachedSize)
    )
      return null;
    const summary = await this.getSessionSummary(id, projectId);
    return summary
      ? { summary, mtime: metadata.info.mtimeMs, size: metadata.info.size }
      : null;
  }
  async getSessionFilePath(id: string): Promise<string | null> {
    return (await this.metadata(id))?.path ?? null;
  }
  async getSessionProjectPath(id: string): Promise<string | null> {
    return (await this.metadata(id))?.cwd ?? null;
  }
  async getNativeSessionRef(id: NativeSessionId) {
    const metadata = await this.metadata(id);
    return metadata
      ? nativeSessionRef(
          "antigravity",
          metadata.scope,
          parseNativeSessionId(id),
        )
      : null;
  }
  async getAgentMappings(): Promise<[]> {
    return [];
  }
  async getAgentSession(): Promise<null> {
    return null;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.runtimes].map((runtime) => runtime.close()));
    this.listCache = undefined;
  }
}
