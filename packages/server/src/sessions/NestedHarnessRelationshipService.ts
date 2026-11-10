import {
  currentClaudeHistoryRows,
  type ClaudeHistoryRows,
} from "./claude-history-rows.js";
import {
  matchesClaudeCopyBoundary,
  type ClaudeCopyBoundary,
} from "./claude-copy-boundary.js";
import {
  collectHarnessHistory,
  emptyHarnessHistory,
  encodeHarnessHistory,
  restoreHarnessHistory,
  isOlderHarnessHistory,
  type HarnessHistoryState,
  type HarnessHistoryVersion,
} from "./claude-harness-history.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  detectScopedNestedHarnessLaunch,
  detectExplicitScopedNestedHarnessLaunch,
  getCodexToolCorrelation,
  unwrapCodexCommandExecutionShell,
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
  sourceTimestamp?: string;
  target?: NativeSessionRef;
}
interface Pending {
  v: 1 | 2;
  native: NativeSessionRef;
  directory: string;
  hints: Hint[];
}
type Event =
  | {
      kind: "observe";
      hint: Hint;
      directory: string;
      projectPath?: string;
      configDirectory?: string;
    }
  | { kind: "finish"; id: string; success: boolean }
  | { kind: "probe" }
  | { kind: "end" };
interface HistoryView {
  rows: WeakRef<ClaudeHistoryRows>;
  projectPath: string;
  committed: number;
  version?: HarnessHistoryVersion;
  state?: HarnessHistoryState;
  revision?: number | null;
}
interface Work {
  context: HarnessProcessContext;
  initialized?: boolean;
  history?: HistoryView;
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
const HISTORY_SCAN = "nested-harness-history-scan-v1";
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
    private readonly admission?: (sessionId: string) =>
      | {
          createdAt: string;
          deleted: boolean;
          copy?: boolean;
          copyBoundary?: ClaudeCopyBoundary;
          confined?: boolean;
        }
      | undefined,
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
      (nativeSessionFamily(context.provider) === "claude" ||
        (context.provider === "codex" &&
          ["darwin", "linux"].includes(process.platform))) &&
      isYaSessionId(context.sessionId)
    );
  }
  private readPending(sessionId: string): Pending | undefined {
    const raw = this.writer.index.checkpoint(PENDING, sessionId)?.cursor;
    if (!raw) return;
    if (raw.length > 65536) throw Error("Invalid pending harness evidence");
    const p = JSON.parse(raw) as Pending;
    if (
      (p.v !== 1 && p.v !== 2) ||
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
    for (const h of p.hints) {
      if (
        !validId(h.id) ||
        !/^[a-f0-9-]{36}$/i.test(h.targetId) ||
        !Number.isFinite(Date.parse(h.observedAt)) ||
        typeof h.ready !== "boolean" ||
        (h.sourceTimestamp !== undefined &&
          (typeof h.sourceTimestamp !== "string" ||
            h.sourceTimestamp.length > 32 ||
            !Number.isFinite(Date.parse(h.sourceTimestamp)))) ||
        (h.attempts !== undefined &&
          (!Number.isInteger(h.attempts) ||
            h.attempts < 0 ||
            h.attempts > MAX_PROBES))
      )
        throw Error("Invalid pending harness evidence");
      if (p.v === 1) {
        if (p.native.family !== "claude")
          throw Error("Invalid inherited harness namespace");
        h.target = nativeSessionRef(
          "claude",
          p.native.storageScope,
          parseNativeSessionId(h.targetId),
        );
      } else {
        if (
          h.target?.family !== "claude" ||
          h.target.id !== h.targetId ||
          !isAbsolute(h.target.storageScope) ||
          h.target.storageScope.length > 4096
        )
          throw Error("Invalid destination harness namespace");
        h.target = nativeSessionRef(
          "claude",
          h.target.storageScope,
          parseNativeSessionId(h.targetId),
        );
      }
    }
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
        initialized: true,
        history: existing?.history,
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
  /** Read-only historical evidence from rows the authorized route already acquired. */
  observeTranscript(
    context: Omit<HarnessProcessContext, "id" | "confined">,
    rows: ClaudeHistoryRows,
    committed = Math.max(0, rows.length - 1),
    version?: HarnessHistoryVersion,
  ): void {
    const historyContext = {
      sessionId: context.sessionId,
      provider: context.provider,
      projectPath: context.projectPath,
      id: `history:${context.sessionId}`,
      confined: false,
    };
    if (!this.admission || !rows.length || !this.eligible(historyContext))
      return;
    let work = this.sources.get(context.sessionId);
    if (!work) {
      if (this.sources.size >= MAX_SOURCES) return; // No new native resources under pressure.
      work = {
        context: historyContext,
        events: [],
        running: false,
        generation: 0,
        known: new Set(),
        detached: true,
      };
      this.sources.set(context.sessionId, work);
    }
    work.history = {
      rows: new WeakRef(rows),
      version: version && {
        id: version.id,
        size: version.size,
        mtime: version.mtime,
        ctime: version.ctime,
      },
      projectPath: context.projectPath,
      committed:
        Number.isSafeInteger(committed) &&
        committed >= 0 &&
        committed <= rows.length
          ? committed
          : 0,
    };
    this.schedule();
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
      (context.provider === "codex" && message._codexOwnedCommand !== true) ||
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
        let command = input.command;
        const codex = context.provider === "codex";
        if (codex) {
          // Pinned native commandExecution is a redacted shlex argv presentation.
          // Decode only unchanged, provider-tagged literal shell argv; the
          // explicit inner env binding, result and target header supply evidence.
          if (
            getCodexToolCorrelation(message)?.origin !== "command_execution" ||
            command.includes("[REDACTED_SECRET]")
          )
            continue;
          const decoded = unwrapCodexCommandExecutionShell(command);
          if (decoded === null) continue;
          command = decoded;
        }
        const explicit = ["darwin", "linux"].includes(process.platform)
          ? detectExplicitScopedNestedHarnessLaunch(command)
          : undefined;
        const launch =
          explicit ??
          (!codex ? detectScopedNestedHarnessLaunch(command) : undefined);
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
          ...(explicit ? { configDirectory: explicit.configDirectory } : {}),
          hint: {
            id: block.id,
            targetId: launch.sessionId,
            observedAt,
            ready: false,
          },
        });
      } else if (
        message.type === "user" &&
        message._isStreaming !== true &&
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
          success:
            block.is_error !== true &&
            (context.provider !== "codex" ||
              (getCodexToolCorrelation(message)?.origin ===
                "command_execution" &&
                getCodexToolCorrelation(message)?.itemId ===
                  block.tool_use_id &&
                !!message.toolUseResult &&
                typeof message.toolUseResult === "object" &&
                "exitCode" in message.toolUseResult &&
                message.toolUseResult.exitCode === 0 &&
                !(
                  "interrupted" in message.toolUseResult &&
                  message.toolUseResult.interrupted === true
                ))),
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
            event.path === join(h.target!.storageScope, h.targetId + ".jsonl"),
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
          if (work.running || (!work.events.length && !work.history)) continue;
          work.running = true;
          this.sources.delete(work.context.sessionId);
          this.sources.set(work.context.sessionId, work);
          const generation = work.generation;
          const job = this.run(work, generation)
            .catch((error) => {
              work.history = undefined;
              if (!work.initialized) work.failed = true;
              if (!this.retired) this.onError(error);
            })
            .finally(() => {
              work.running = false;
              this.active.delete(job);
              if (
                work.detached &&
                !work.events.length &&
                !work.pending?.hints.length &&
                !work.history &&
                this.sources.get(work.context.sessionId) === work
              )
                this.sources.delete(work.context.sessionId);
              this.recoveryWake?.();
              this.recoveryWake = undefined;
              if (
                [...this.sources.values()].some(
                  (w) => w.events.length || w.history,
                )
              )
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
      // Keep inherited-only Claude records compact and readable on rollback.
      // Explicit destinations require v2 so an old reader cannot reinterpret them.
      const inherited =
        source.family === "claude" &&
        pending.hints.every(
          (h) =>
            h.target?.family === "claude" &&
            h.target.storageScope === source.storageScope &&
            h.target.id === h.targetId,
        );
      pending.v = inherited ? 1 : 2;
      const cursor = JSON.stringify(
        inherited
          ? {
              ...pending,
              hints: pending.hints.map(({ target: _target, ...hint }) => hint),
            }
          : pending,
      );
      if (cursor.length > 65536) return false;
      const published = this.writer.index.publishWithinTransaction({
        observation: {
          producer: PENDING,
          sourceKey: work.context.sessionId,
          sourceVersion: "2",
          extractorVersion: 2,
          observedAt: new Date().toISOString(),
        },
        expectedRevision: previous?.revision ?? null,
        facts: [],
        progress: {
          state: pending.hints.length ? "partial" : "complete",
          cursor,
        },
      });
      if (!published) return false;
      if (completed) {
        const key = this.completionKey(work, completed.hint);
        const done = this.writer.index.checkpoint(COMPLETE, key);
        const previouslyObserved =
          done && JSON.parse(done.cursor).observed === true;
        const upgrade = completed.observed && !previouslyObserved;
        if (upgrade) {
          const from = {
            kind: "native" as const,
            serverId: this.writer.serverId,
            native: source,
          };
          const target = completed.hint.target;
          if (!target) throw Error("Missing destination harness namespace");
          this.writer.index.recordWithinTransaction(
            {
              producer: completed.hint.sourceTimestamp
                ? "nested-harness-history-v1"
                : PRODUCER,
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
                metadata: {
                  toolUseId: completed.hint.id,
                  ...(completed.hint.sourceTimestamp
                    ? { sourceTimestamp: completed.hint.sourceTimestamp }
                    : {}),
                },
              },
            ],
          );
        }
        if (!done || upgrade)
          this.writer.index.publishWithinTransaction({
            observation: {
              producer: COMPLETE,
              sourceKey: key,
              sourceVersion: "1",
              extractorVersion: 1,
              observedAt: new Date().toISOString(),
            },
            expectedRevision: done?.revision ?? null,
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
  private completionKey(work: Work, hint: Hint): string {
    return hint.sourceTimestamp
      ? JSON.stringify([work.context.sessionId, hint.id, "history"])
      : callKey(work.context.sessionId, hint.id);
  }
  private stageHistory(work: Work):
    | {
        view: HistoryView;
        state: HarnessHistoryState;
        hints: ReturnType<typeof collectHarnessHistory>["hints"];
      }
    | undefined {
    const view = work.history;
    if (!view) return;
    const rows = view.rows.deref(),
      admission = this.admission?.(work.context.sessionId),
      source = this.source(work);
    if (
      !rows ||
      !currentClaudeHistoryRows(rows) ||
      !admission ||
      admission.deleted ||
      (admission.copy &&
        !matchesClaudeCopyBoundary(
          admission.copyBoundary,
          rows,
          view.committed,
        )) ||
      admission.confined !== false ||
      !Number.isFinite(Date.parse(admission.createdAt)) ||
      source?.family !== "claude"
    ) {
      work.history = undefined;
      return;
    }
    if (!view.state) {
      const checkpoint = this.writer.index.checkpoint(
        HISTORY_SCAN,
        work.context.sessionId,
      );
      if (
        isOlderHarnessHistory(checkpoint?.cursor, rows, source, view.version)
      ) {
        work.history = undefined;
        return;
      }
      view.state = restoreHarnessHistory(
        checkpoint?.cursor,
        rows,
        source,
        view.committed,
        view.version,
      );
      view.revision = checkpoint?.revision ?? null;
    }
    if (
      admission.copy &&
      admission.copyBoundary &&
      view.state.entry < admission.copyBoundary.entries
    ) {
      // This floor is revalidated against the immutable native copy witness on
      // every view, including after cursor reset/replacement. Never pair across it.
      view.state = {
        ...emptyHarnessHistory(),
        entry: admission.copyBoundary.entries,
        needsCommit: true,
      };
    }
    if (
      view.state.retryAfter &&
      view.state.retryAfter > Date.now() &&
      view.state.retryAfter <= Date.now() + 1000
    ) {
      work.history = undefined;
      return;
    }
    if (MAX_PENDING - work.known.size <= 0) {
      work.history = undefined;
      return;
    }
    const deferred = new Set(
      work.pending?.hints.filter((h) => !h.sourceTimestamp).map((h) => h.id),
    );
    if (
      view.state.entry >= view.committed &&
      !view.state.needsCommit &&
      ![...view.state.pending.values()].some(
        (h) => h.ready && !deferred.has(h.id),
      )
    ) {
      work.history = undefined;
      return;
    }
    const result = collectHarnessHistory(
      rows,
      view.state,
      source.id,
      admission.createdAt,
      MAX_PENDING - work.known.size,
      view.committed,
      deferred,
    );
    for (const h of result.hints) {
      const hint: Hint = {
        id: h.id,
        targetId: h.targetId,
        sourceTimestamp: h.sourceTimestamp,
        observedAt: new Date().toISOString(),
        ready: true,
      };
      const live = this.writer.index.checkpoint(
        COMPLETE,
        callKey(work.context.sessionId, h.id),
      );
      if (live && JSON.parse(live.cursor).observed === true) {
        result.state.pending.delete(h.id);
        continue;
      }
      const done = this.writer.index.checkpoint(
        COMPLETE,
        this.completionKey(work, hint),
      );
      if (done && JSON.parse(done.cursor).observed === true) {
        result.state.pending.delete(h.id);
        continue;
      }
      // A still-owned live observation keeps its timestamp, key and proof budget.
      if (work.pending?.hints.some((p) => p.id === h.id && !p.sourceTimestamp))
        continue;
      if (!work.known.has(h.id) && work.known.size >= MAX_PENDING) continue;
      work.known.add(h.id);
      work.events.push({
        kind: "observe",
        hint,
        directory: h.directory,
        projectPath: view.projectPath,
      });
    }
    return { view, state: result.state, hints: result.hints };
  }
  private async run(work: Work, generation: number): Promise<void> {
    if (!work.initialized) {
      work.pending = this.readPending(work.context.sessionId);
      work.known = new Set(work.pending?.hints.map((h) => h.id));
      work.initialized = true;
    }
    // Existing live events retain priority over another historical CPU batch.
    const historyTurn = work.events.length === 0 && !!work.history;
    const history = historyTurn ? this.stageHistory(work) : undefined;
    // Finite turn; another source gets a worker before the next event batch.
    const events = work.events.splice(0, MAX_EVENTS);
    const handed = new Set<string>(),
      terminal = new Set<string>();
    for (const event of events) {
      if (!this.current(work, generation)) return;
      try {
        if (event.kind === "observe") {
          const source = this.source(work);
          if (
            !source ||
            (!event.configDirectory && source.family !== "claude")
          ) {
            work.known.delete(event.hint.id);
            if (event.hint.sourceTimestamp) terminal.add(event.hint.id);
            continue;
          }
          const directory = await realpath(event.directory);
          if (
            directory !==
              (await realpath(event.projectPath ?? work.context.projectPath)) ||
            (!event.configDirectory &&
              (basename(source.storageScope) !==
                claudeCwdProjectDirectory(directory) ||
                (await realpath(source.storageScope)) !==
                  source.storageScope)) ||
            !this.current(work, generation)
          ) {
            work.known.delete(event.hint.id);
            if (event.hint.sourceTimestamp) terminal.add(event.hint.id);
            continue;
          }
          const targetScope = event.configDirectory
            ? resolve(
                event.configDirectory,
                "projects",
                claudeCwdProjectDirectory(directory),
              )
            : source.storageScope;
          if (targetScope.length > 4096) {
            work.known.delete(event.hint.id);
            if (event.hint.sourceTimestamp) terminal.add(event.hint.id);
            continue;
          }
          event.hint.target = nativeSessionRef(
            "claude",
            targetScope,
            parseNativeSessionId(event.hint.targetId),
          );
          if (sameNative(source, event.hint.target)) {
            work.known.delete(event.hint.id);
            if (event.hint.sourceTimestamp) terminal.add(event.hint.id);
            continue;
          }
          const saved = this.save(
            work,
            (p) => {
              const old = p.hints.find((h) => h.id === event.hint.id);
              if (
                old &&
                event.hint.sourceTimestamp &&
                old.targetId === event.hint.targetId &&
                old.sourceTimestamp
              )
                Object.assign(old, event.hint);
              else if (!old && p.hints.length < MAX_PENDING)
                p.hints.push(event.hint);
            },
            { v: 2, native: source, directory, hints: [] },
          );
          if (
            saved &&
            event.hint.sourceTimestamp &&
            work.pending?.hints.some(
              (h) =>
                h.id === event.hint.id &&
                h.targetId === event.hint.targetId &&
                h.sourceTimestamp,
            )
          )
            handed.add(event.hint.id);
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
        if (history && event.kind === "observe" && event.hint.sourceTimestamp)
          history.state.retryAfter = Date.now() + 1000;
        if (!this.retired) this.onError(error);
      }
    }
    if (await this.probe(work, generation, historyTurn))
      this.onCommitted(work.context.sessionId);
    if (history && this.current(work, generation)) {
      const rows = history.view.rows.deref(),
        native = this.source(work);
      if (!rows || !currentClaudeHistoryRows(rows) || !native) {
        if (work.history === history.view) work.history = undefined;
        return;
      }
      for (const hint of history.hints) {
        const queued = work.pending?.hints.find(
          (h) =>
            h.id === hint.id &&
            h.targetId === hint.targetId &&
            h.sourceTimestamp,
        );

        const live = this.writer.index.checkpoint(
          COMPLETE,
          callKey(work.context.sessionId, hint.id),
        );
        const old = this.writer.index.checkpoint(
          COMPLETE,
          JSON.stringify([work.context.sessionId, hint.id, "history"]),
        );
        if (
          queued ||
          handed.has(hint.id) ||
          terminal.has(hint.id) ||
          (old && JSON.parse(old.cursor).observed === true) ||
          (live && JSON.parse(live.cursor).observed === true)
        )
          history.state.pending.delete(hint.id);
        if (
          (terminal.has(hint.id) || (handed.has(hint.id) && !queued)) &&
          (!live || JSON.parse(live.cursor).observed !== true) &&
          (!old || JSON.parse(old.cursor).observed !== true)
        )
          history.state.partial = true;
      }
      const waitingForHandoff = [...history.state.pending.values()].some(
        (h) =>
          h.ready &&
          !work.pending?.hints.some(
            (live) => live.id === h.id && !live.sourceTimestamp,
          ),
      );
      if (waitingForHandoff) history.state.retryAfter = Date.now() + 1000;
      const saved = this.database.transaction(() =>
        this.writer.index.publishWithinTransaction({
          observation: {
            producer: HISTORY_SCAN,
            sourceKey: work.context.sessionId,
            sourceVersion: createHash("sha256")
              .update(
                relationshipResourceKey({
                  kind: "native",
                  serverId: this.writer.serverId,
                  native,
                }),
              )
              .digest("hex"),
            extractorVersion: 1,
            observedAt: new Date().toISOString(),
          },
          expectedRevision: history.view.revision ?? null,
          facts: [],
          progress: {
            state:
              history.state.partial ||
              history.state.pending.size ||
              history.state.entry < history.view.committed
                ? "partial"
                : "complete",
            cursor: encodeHarnessHistory(
              history.state,
              rows,
              native,
              history.view.version,
            ),
          },
        }),
      );
      if (saved) {
        history.state.needsCommit = false;
        history.view.state = history.state;
        history.view.revision = (history.view.revision ?? 0) + 1;
      }
      if (
        work.history === history.view &&
        (!saved ||
          history.state.entry >= history.view.committed ||
          waitingForHandoff)
      )
        work.history = undefined;
    }
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
  private async probe(
    work: Work,
    generation: number,
    historicalOnly = false,
  ): Promise<boolean> {
    let committed = false;
    const pending = work.pending;
    const source = this.source(work);
    if (!pending || !source || !sameNative(source, pending.native))
      return committed;
    for (const hint of pending.hints) {
      if (historicalOnly && !hint.sourceTimestamp) continue;
      if (!this.current(work, generation)) return committed;
      if (Date.now() - Date.parse(hint.observedAt) >= MAX_AGE_MS) {
        this.abandon(work, hint);
        continue;
      }
      if (!hint.ready) continue;
      let proven = false,
        transient = false;
      try {
        proven = await this.targetExists(pending, hint);
      } catch (error) {
        transient = true;
        if (!this.retired) this.onError(error);
      }
      if (!this.current(work, generation)) return committed;
      if (!proven) {
        const attempts = (hint.attempts ?? 0) + 1;
        if ((hint.sourceTimestamp && !transient) || attempts >= MAX_PROBES)
          this.abandon(work, hint);
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
        committed = true;
      }
    }
    return committed;
  }
  private async targetExists(pending: Pending, hint: Hint): Promise<boolean> {
    const target = hint.target;
    if (
      target?.family !== "claude" ||
      target.id !== hint.targetId ||
      basename(target.storageScope) !==
        claudeCwdProjectDirectory(pending.directory)
    )
      return false;
    const path = join(target.storageScope, hint.targetId + ".jsonl");
    try {
      if (
        (await realpath(target.storageScope)) !== target.storageScope ||
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
