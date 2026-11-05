import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  detectScopedNestedHarnessLaunch,
  nativeSessionFamily,
  isYaSessionId,
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  type NativeSessionRef,
  type ProviderName,
} from "@yep-anywhere/shared";
import { runOutsideRequestContext } from "../lib/outsideRequestContext.js";
import { claudeCwdProjectDirectory } from "../projects/claude-project-directory.js";
import type { SDKMessage } from "../sdk/types.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import type { FileChangeEvent } from "../watcher/EventBus.js";
import type { SessionIdentityStore } from "./SessionIdentityStore.js";
import { relationshipResourceKey } from "./SessionRelationshipStore.js";
import type { SessionRelationshipWriter } from "./SessionRelationshipWriter.js";

export interface HarnessProcessContext {
  id: string;
  sessionId: string;
  projectPath: string;
  provider: ProviderName;
  confined: boolean;
}
export interface HarnessRelationshipObserver {
  registerProcess(context: HarnessProcessContext): void;
  observeMessage(context: HarnessProcessContext, message: SDKMessage): void;
  forgetProcess(
    context: HarnessProcessContext,
    reason?: "ended" | "reload",
  ): void;
}
interface Hint {
  id: string;
  targetId: string;
  observedAt: string;
  ready: boolean;
  attempts?: number;
}
interface Pending {
  v: 1;
  native: NativeSessionRef;
  directory: string;
  hints: Hint[];
}
type Event =
  | { kind: "observe"; hint: Hint; directory: string }
  | { kind: "finish"; id: string; success: boolean }
  | { kind: "probe" }
  | { kind: "end" };
interface Work {
  context: HarnessProcessContext;
  pending?: Pending;
  events: Event[];
  running: boolean;
  generation: number;
  known: Set<string>; // MAX_PENDING plus one bounded in-flight event batch
  failed?: boolean;
  detached?: boolean;
}
const PENDING = "nested-harness-pending-v1";
const COMPLETE = "nested-harness-complete-v1";
const PRODUCER = "nested-harness-command-v1";
const MAX_SOURCES = 128,
  MAX_PENDING = 32,
  MAX_EVENTS = 66,
  CONCURRENCY = 2,
  MAX_PROBES = 3,
  MAX_AGE_MS = 24 * 60 * 60 * 1000;
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const sameNative = (a: NativeSessionRef, b: NativeSessionRef) =>
  a.family === b.family && a.storageScope === b.storageScope && a.id === b.id;
const callKey = (sessionId: string, id: string) =>
  JSON.stringify([sessionId, id]);

/**
 * Live qualified command evidence, not a creator/permission authority. The
 * existing profile index owns pending extraction and accepted historical facts.
 * Two finite workers, 128 sources, 32 pending launches each; no timers, watchers,
 * parent-body reads or provider effects. Cursor recovery never reruns a command.
 */
export class NestedHarnessRelationshipService
  implements HarnessRelationshipObserver
{
  private readonly sources = new Map<string, Work>(); // MAX_SOURCES, LRU/lifecycle release
  private readonly active = new Set<Promise<void>>(); // CONCURRENCY
  private wake?: NodeJS.Immediate;
  private retired = false;
  private readonly recovery: Promise<void>;
  private recoveryWake?: () => void; // One finite startup scan, not one waiter per source.
  constructor(
    private readonly database: SqliteDatabase,
    private readonly writer: SessionRelationshipWriter,
    private readonly identities: SessionIdentityStore | undefined,
    private readonly onCommitted: (sessionId: string) => void,
    private readonly onError: (error: unknown) => void,
  ) {
    writer.assertProfileConnection(database);
    this.recovery = runOutsideRequestContext(async () => {
      try {
        if (identities) await this.recover();
      } catch (error) {
        if (!this.retired) this.onError(error);
      }
    });
  }

  private async recover(): Promise<void> {
    let after = "";
    while (!this.retired) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.retired) return;
      const keys = this.writer.index.partialSources(PENDING, after, 25);
      if (!keys.length) return;
      for (const key of keys) {
        if (this.retired) return;
        after = key;
        if (this.sources.has(key) || !isYaSessionId(key)) continue;
        try {
          const pending = this.readPending(key),
            identity = this.identities?.resolveYa(parseYaSessionId(key));
          if (
            !pending ||
            !identity?.native ||
            !sameNative(identity.native, pending.native)
          )
            continue;
          const context = {
            id: `recovery:${key}`,
            sessionId: key,
            provider: identity.provider,
            projectPath: pending.directory,
            confined: false,
          };
          while (!this.retired && !this.sources.has(key)) {
            const result = this.registerProcess(context),
              work = this.sources.get(key);
            if (work) {
              work.detached = true;
              break;
            }
            if (result !== "capacity") break;
            await new Promise<void>((resolve) => {
              this.recoveryWake = resolve;
            });
          }
        } catch (error) {
          if (!this.retired) this.onError(error);
        }
      }
    }
  }
  private eligible(context: HarnessProcessContext): boolean {
    return (
      !this.retired &&
      !!this.identities &&
      !context.confined &&
      nativeSessionFamily(context.provider) === "claude" &&
      isYaSessionId(context.sessionId)
    );
  }
  private readPending(sessionId: string): Pending | undefined {
    const raw = this.writer.index.checkpoint(PENDING, sessionId)?.cursor;
    if (!raw) return;
    if (raw.length > 65536) throw Error("Invalid pending harness evidence");
    const p = JSON.parse(raw) as Pending;
    if (
      p.v !== 1 ||
      !isAbsolute(p.directory) ||
      p.directory.length > 4096 ||
      !Array.isArray(p.hints) ||
      p.hints.length > MAX_PENDING
    )
      throw Error("Invalid pending harness evidence");
    p.native = nativeSessionRef(
      p.native.family,
      p.native.storageScope,
      parseNativeSessionId(p.native.id),
    );
    for (const h of p.hints)
      if (
        !validId(h.id) ||
        !/^[a-f0-9-]{36}$/i.test(h.targetId) ||
        !Number.isFinite(Date.parse(h.observedAt)) ||
        typeof h.ready !== "boolean" ||
        (h.attempts !== undefined &&
          (!Number.isInteger(h.attempts) ||
            h.attempts < 0 ||
            h.attempts > MAX_PROBES))
      )
        throw Error("Invalid pending harness evidence");
    return p;
  }
  registerProcess(
    context: HarnessProcessContext,
  ): "registered" | "ineligible" | "capacity" {
    if (!this.eligible(context)) return "ineligible";
    const existing = this.sources.get(context.sessionId);
    if (existing?.context.id === context.id) return "registered";
    if (existing) existing.generation++;
    if (!existing && this.sources.size >= MAX_SOURCES) {
      const evict = [...this.sources].find(
        ([, w]) => !w.running && !w.events.length,
      );
      if (!evict) return "capacity";
      evict[1].generation++;
      this.sources.delete(evict[0]);
    }
    try {
      const pending = this.readPending(context.sessionId);
      const work: Work = {
        context,
        pending,
        events: [],
        running: false,
        generation: 0,
        known: new Set(pending?.hints.map((h) => h.id)),
      };
      this.sources.delete(context.sessionId);
      this.sources.set(context.sessionId, work);
      if (pending?.hints.length) this.enqueue(work, { kind: "probe" });
    } catch (error) {
      this.sources.set(context.sessionId, {
        context,
        events: [],
        running: false,
        generation: 0,
        known: new Set(),
        failed: true,
      });
      this.onError(error);
    }
    return "registered";
  }
  forgetProcess(
    context: HarnessProcessContext,
    reason: "ended" | "reload" = "ended",
  ): void {
    const work = this.sources.get(context.sessionId);
    if (work?.context.id !== context.id) return;
    work.detached = true;
    if (reason === "reload") return;
    // A real process end is terminal. Reload completion above is local to the
    // outgoing API generation and must preserve in-flight tool correlation.
    this.enqueue(work, { kind: "end" });
  }
  observeMessage(context: HarnessProcessContext, message: SDKMessage): void {
    try {
      this.observe(context, message);
    } catch (error) {
      if (!this.retired) this.onError(error);
    }
  }
  private observe(context: HarnessProcessContext, message: SDKMessage): void {
    if (
      !this.eligible(context) ||
      message.parent_tool_use_id ||
      message.isSynthetic ||
      message.isReplay ||
      message.session_id !== context.sessionId ||
      !Array.isArray(message.message?.content)
    )
      return;
    if (message.type !== "assistant" && message.type !== "user") return;
    for (const block of message.message.content) {
      if (
        message.type === "assistant" &&
        block.type === "tool_use" &&
        block.name === "Bash" &&
        validId(block.id)
      ) {
        const input = block.input;
        if (
          !input ||
          typeof input !== "object" ||
          !("command" in input) ||
          typeof input.command !== "string" ||
          ("run_in_background" in input && input.run_in_background === true)
        )
          continue;
        const launch = detectScopedNestedHarnessLaunch(input.command);
        if (
          !launch?.sessionId ||
          !launch.workingDirectory ||
          !isAbsolute(launch.workingDirectory) ||
          launch.workingDirectory.length > 4096
        )
          continue;
        this.registerProcess(context);
        const work = this.sources.get(context.sessionId);
        if (
          !work ||
          work.failed ||
          work.detached ||
          work.context.id !== context.id ||
          work.known.has(block.id) ||
          work.known.size >= MAX_PENDING
        )
          continue;
        if (
          this.writer.index.checkpoint(
            COMPLETE,
            callKey(context.sessionId, block.id),
          )
        )
          continue;
        const observedAt =
          typeof message.timestamp === "string" &&
          Number.isFinite(Date.parse(message.timestamp))
            ? new Date(
                Math.min(Date.parse(message.timestamp), Date.now()),
              ).toISOString()
            : new Date().toISOString();
        work.known.add(block.id);
        this.enqueue(work, {
          kind: "observe",
          directory: launch.workingDirectory,
          hint: {
            id: block.id,
            targetId: launch.sessionId,
            observedAt,
            ready: false,
          },
        });
      } else if (
        message.type === "user" &&
        block.type === "tool_result" &&
        validId(block.tool_use_id)
      ) {
        this.registerProcess(context);
        const work = this.sources.get(context.sessionId);
        if (
          !work ||
          work.failed ||
          work.detached ||
          work.context.id !== context.id ||
          !work.known.has(block.tool_use_id)
        )
          continue;
        this.enqueue(work, {
          kind: "finish",
          id: block.tool_use_id,
          success: block.is_error !== true,
        });
      }
    }
  }
  notifyFileChange(event: FileChangeEvent): void {
    if (this.retired || event.provider !== "claude") return;
    for (const work of this.sources.values())
      if (
        work.pending?.hints.some(
          (h) =>
            h.ready &&
            event.path ===
              join(work.pending!.native.storageScope, h.targetId + ".jsonl"),
        )
      )
        this.enqueue(work, { kind: "probe" });
  }
  observationReady(family: string): void {
    if (this.retired || family !== "claude") return;
    for (const work of this.sources.values())
      if (work.pending?.hints.length) this.enqueue(work, { kind: "probe" });
  }
  private enqueue(work: Work, event: Event): void {
    if (
      (event.kind === "probe" || event.kind === "end") &&
      work.events.some((e) => e.kind === event.kind)
    )
      return;
    if (
      event.kind === "finish" &&
      work.events.some((e) => e.kind === "finish" && e.id === event.id)
    )
      return;
    if (work.events.length >= MAX_EVENTS) return;
    work.events.push(event);
    this.schedule();
  }
  private current(work: Work, generation: number) {
    return (
      !this.retired &&
      work.generation === generation &&
      this.sources.get(work.context.sessionId) === work
    );
  }
  private schedule(): void {
    if (this.retired || this.wake || this.active.size >= CONCURRENCY) return;
    this.wake = runOutsideRequestContext(() =>
      setImmediate(() => {
        this.wake = undefined;
        for (const work of this.sources.values()) {
          if (this.active.size >= CONCURRENCY) break;
          if (work.running || !work.events.length) continue;
          work.running = true;
          this.sources.delete(work.context.sessionId);
          this.sources.set(work.context.sessionId, work);
          const generation = work.generation;
          const job = this.run(work, generation)
            .catch((error) => {
              if (!this.retired) this.onError(error);
            })
            .finally(() => {
              work.running = false;
              this.active.delete(job);
              if (
                work.detached &&
                !work.events.length &&
                !work.pending?.hints.length &&
                this.sources.get(work.context.sessionId) === work
              )
                this.sources.delete(work.context.sessionId);
              this.recoveryWake?.();
              this.recoveryWake = undefined;
              if ([...this.sources.values()].some((w) => w.events.length))
                this.schedule();
            });
          this.active.add(job);
        }
      }),
    );
  }
  private source(work: Work): NativeSessionRef | undefined {
    return (
      this.identities?.resolveYa(parseYaSessionId(work.context.sessionId))
        ?.native ?? undefined
    );
  }
  private save(
    work: Work,
    change: (pending: Pending) => void,
    seed?: Pending,
    completed?: { hint: Hint; observed: boolean },
  ): boolean {
    let committed: Pending | undefined;
    const saved = this.database.transaction(() => {
      const source = this.source(work);
      const previous = this.writer.index.checkpoint(
        PENDING,
        work.context.sessionId,
      );
      const pending = this.readPending(work.context.sessionId) ?? seed;
      if (!source || !pending || !sameNative(source, pending.native))
        return false;
      if (seed && pending.directory !== seed.directory) {
        if (pending.hints.length) return false;
        pending.directory = seed.directory;
      }
      if (
        completed &&
        !pending.hints.some(
          (h) =>
            h.id === completed.hint.id &&
            h.targetId === completed.hint.targetId &&
            h.observedAt === completed.hint.observedAt,
        )
      )
        return false;
      change(pending);
      const published = this.writer.index.publishWithinTransaction({
        observation: {
          producer: PENDING,
          sourceKey: work.context.sessionId,
          sourceVersion: "1",
          extractorVersion: 1,
          observedAt: new Date().toISOString(),
        },
        expectedRevision: previous?.revision ?? null,
        facts: [],
        progress: {
          state: pending.hints.length ? "partial" : "complete",
          cursor: JSON.stringify(pending),
        },
      });
      if (!published) return false;
      if (completed) {
        const key = callKey(work.context.sessionId, completed.hint.id);
        const done = this.writer.index.checkpoint(COMPLETE, key);
        if (!done && completed.observed) {
          const from = {
            kind: "native" as const,
            serverId: this.writer.serverId,
            native: source,
          };
          const target = nativeSessionRef(
            "claude",
            source.storageScope,
            parseNativeSessionId(completed.hint.targetId),
          );
          this.writer.index.recordWithinTransaction(
            {
              producer: PRODUCER,
              sourceKey: work.context.sessionId,
              sourceVersion: createHash("sha256")
                .update(relationshipResourceKey(from))
                .digest("hex"),
              extractorVersion: 1,
              observedAt: completed.hint.observedAt,
            },
            [
              {
                type: "launched_harness",
                source: from,
                target: {
                  kind: "native",
                  serverId: this.writer.serverId,
                  native: target,
                },
                recordKey: completed.hint.id,
                trust: "command-observed",
                metadata: { toolUseId: completed.hint.id },
              },
            ],
          );
        }
        if (!done)
          this.writer.index.publishWithinTransaction({
            observation: {
              producer: COMPLETE,
              sourceKey: key,
              sourceVersion: "1",
              extractorVersion: 1,
              observedAt: new Date().toISOString(),
            },
            expectedRevision: null,
            facts: [],
            progress: {
              state: "complete",
              cursor: JSON.stringify({ observed: completed.observed }),
            },
          });
      }
      committed = pending;
      return true;
    });
    if (saved) work.pending = committed;
    return saved;
  }
  private async run(work: Work, generation: number): Promise<void> {
    // Finite turn; another source gets a worker before the next event batch.
    const events = work.events.splice(0, MAX_EVENTS);
    for (const event of events) {
      if (!this.current(work, generation)) return;
      try {
        if (event.kind === "observe") {
          const source = this.source(work);
          if (
            source?.family !== "claude" ||
            source.id === event.hint.targetId
          ) {
            work.known.delete(event.hint.id);
            continue;
          }
          const directory = await realpath(event.directory);
          if (
            directory !== (await realpath(work.context.projectPath)) ||
            basename(source.storageScope) !==
              claudeCwdProjectDirectory(directory) ||
            (await realpath(source.storageScope)) !== source.storageScope ||
            !this.current(work, generation)
          ) {
            work.known.delete(event.hint.id);
            continue;
          }
          const saved = this.save(
            work,
            (p) => {
              if (
                !p.hints.some((h) => h.id === event.hint.id) &&
                p.hints.length < MAX_PENDING
              )
                p.hints.push(event.hint);
            },
            { v: 1, native: source, directory, hints: [] },
          );
          if (!saved) work.known.delete(event.hint.id);
        } else if (event.kind === "end") {
          for (const hint of work.pending?.hints ?? [])
            if (!hint.ready) this.abandon(work, hint);
        } else if (event.kind === "finish") {
          const hint = work.pending?.hints.find((h) => h.id === event.id);
          if (!hint) continue;
          const saved = this.save(
            work,
            (p) => {
              if (event.success) {
                const h = p.hints.find((h) => h.id === event.id);
                if (h) h.ready = true;
              } else p.hints = p.hints.filter((h) => h.id !== event.id);
            },
            undefined,
            event.success ? undefined : { hint, observed: false },
          );
          if (saved && !event.success) work.known.delete(event.id);
        }
      } catch (error) {
        // One inaccessible candidate must not discard other already-observed events.
        if (event.kind === "observe") work.known.delete(event.hint.id);
        if (!this.retired) this.onError(error);
      }
    }
    await this.probe(work, generation);
  }
  /** Unknown terminal outcome, never a statement that no launch occurred. */
  private abandon(work: Work, hint: Hint): void {
    if (
      this.save(
        work,
        (p) => {
          p.hints = p.hints.filter((h) => h.id !== hint.id);
        },
        undefined,
        { hint, observed: false },
      )
    )
      work.known.delete(hint.id);
  }
  private async probe(work: Work, generation: number): Promise<void> {
    const pending = work.pending;
    const source = this.source(work);
    if (
      !pending ||
      !source ||
      source.family !== "claude" ||
      !sameNative(source, pending.native)
    )
      return;
    for (const hint of pending.hints) {
      if (!this.current(work, generation)) return;
      if (Date.now() - Date.parse(hint.observedAt) >= MAX_AGE_MS) {
        this.abandon(work, hint);
        continue;
      }
      if (!hint.ready) continue;
      let proven = false;
      try {
        proven = await this.targetExists(pending, hint);
      } catch (error) {
        if (!this.retired) this.onError(error);
      }
      if (!this.current(work, generation)) return;
      if (!proven) {
        const attempts = (hint.attempts ?? 0) + 1;
        if (attempts >= MAX_PROBES) this.abandon(work, hint);
        else
          this.save(work, (p) => {
            const h = p.hints.find((h) => h.id === hint.id);
            if (h) h.attempts = attempts;
          });
        continue;
      }
      const saved = this.save(
        work,
        (p) => {
          p.hints = p.hints.filter((h) => h.id !== hint.id);
        },
        undefined,
        { hint, observed: true },
      );
      if (saved) {
        work.known.delete(hint.id);
        this.onCommitted(work.context.sessionId);
      }
    }
  }
  private async targetExists(pending: Pending, hint: Hint): Promise<boolean> {
    const path = join(pending.native.storageScope, hint.targetId + ".jsonl");
    try {
      if (
        (await realpath(pending.native.storageScope)) !==
          pending.native.storageScope ||
        (await realpath(path)) !== path
      )
        return false;
      const before = await lstat(path);
      if (!before.isFile()) return false;
      const file = await open(
        path,
        constants.O_RDONLY |
          (process.platform === "win32"
            ? 0
            : constants.O_NOFOLLOW | constants.O_NONBLOCK),
      );
      try {
        const opened = await file.stat();
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino
        )
          return false;
        const buffer = Buffer.alloc(Math.min(opened.size, 65536));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const last = buffer.lastIndexOf(10, bytesRead - 1);
        if (last < 0) return false;
        let own = false;
        for (const line of buffer
          .subarray(0, last + 1)
          .toString("utf8")
          .replace(/^\uFEFF/, "")
          .split("\n")) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            if (
              row.sessionId === hint.targetId &&
              row.isSidechain !== true &&
              typeof row.cwd === "string" &&
              isAbsolute(row.cwd) &&
              resolve(row.cwd) === pending.directory
            )
              own = true;
          } catch {
            /* A malformed native header cannot prove an endpoint. */
          }
        }
        const after = await lstat(path),
          held = await file.stat();
        return (
          own &&
          after.isFile() &&
          held.dev === before.dev &&
          held.ino === before.ino &&
          after.dev === held.dev &&
          after.ino === held.ino &&
          after.size >= opened.size &&
          (await realpath(path)) === path
        );
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async close(): Promise<void> {
    this.retired = true;
    if (this.wake) clearImmediate(this.wake);
    this.wake = undefined;
    this.recoveryWake?.();
    this.recoveryWake = undefined;
    for (const work of this.sources.values()) work.generation++;
    await this.recovery;
    await Promise.allSettled([...this.active]);
    this.sources.clear();
  }
}
