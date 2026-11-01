import { markSubagent } from "../augments/message-utils.js";
import {
  getMessageId,
  type Message,
} from "@yep-anywhere/shared/transcript/message";
import type { SessionCatalogRow } from "../sessions/catalog-types.js";
import type { Process } from "../supervisor/Process.js";
import type { ProcessEvent } from "../supervisor/types.js";
import type { EventBus } from "../watcher/EventBus.js";
import { normalizeStreamMessage } from "../subscriptions.js";
import { readConversationFile } from "./conversation-reader.js";
import {
  MAX_PROJECTION_INPUT_BYTES,
  MAX_PROJECTION_RECORDS,
  type ConversationInput,
} from "./conversation-projection.js";
import type { OpenConversationSource } from "./conversation-subscriptions.js";

export interface ConversationSourceDependencies {
  resolve(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<
    (Readonly<SessionCatalogRow> & { nativeSessionId?: string }) | undefined
  >;
  getProcess(
    sessionId: string,
  ):
    | (Pick<
        Process,
        "state" | "subscribe" | "registerViewer" | "getMessageHistory"
      > & { provider?: string; sessionId?: string })
    | undefined;
  eventBus?: EventBus;
  watch?(row: Readonly<SessionCatalogRow>, invalidate: () => void): () => void;
  readFile?: typeof readConversationFile;
  resolveRolloutPath?: (
    row: Readonly<SessionCatalogRow>,
    id: string,
  ) => Promise<string | null>;
}

/** One observed source per session, shared by the subscription owner. */
export function createConversationSource(
  deps: ConversationSourceDependencies,
): OpenConversationSource {
  return async (sessionId, invalidate, signal) => {
    let row:
      | (Readonly<SessionCatalogRow> & { nativeSessionId?: string })
      | undefined;
    let baseline: ConversationInput | undefined;
    let dirty = true;
    let durableRevision = 0;
    let process: ReturnType<ConversationSourceDependencies["getProcess"]>;
    let releaseProcess: (() => void) | undefined;
    let releaseWatch: (() => void) | undefined;
    let failed = false;
    // The durable revision at which memory last dropped a record. Only a read
    // that starts after it, with the turn settled, can cover that record.
    let failedAtRevision = 0;
    let liveBytes = 0;
    const live = new Map<string, { message: Message; bytes: number }>();
    const drop = () => {
      failed = true;
      dirty = true;
      failedAtRevision = ++durableRevision;
      invalidate();
    };
    const add = (raw: Record<string, unknown>) => {
      if (signal.aborted) return;
      // Finalized provider records and YA's identity-preserving user echoes are
      // usable now. Raw token frames need a separate block assembler.
      if (raw.type === "stream_event" || raw._isStreaming === true) return;
      if (!["assistant", "user", "error", "system"].includes(String(raw.type)))
        return;
      const message = markSubagent(
        normalizeStreamMessage({ ...raw }) as Message &
          Parameters<typeof markSubagent>[0],
      );
      const id = getMessageId(message);
      if (!id && message.type === "system") return;
      if (!id || failed) {
        drop();
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      const nextBytes = liveBytes - (live.get(id)?.bytes ?? 0) + bytes;
      if (
        nextBytes > MAX_PROJECTION_INPUT_BYTES ||
        (!live.has(id) && live.size >= MAX_PROJECTION_RECORDS)
      ) {
        drop();
        return;
      }
      liveBytes = nextBytes;
      live.set(id, { message: structuredClone(message), bytes });
      invalidate();
    };
    const attachProcess = () => {
      const next = deps.getProcess(sessionId);
      if (next === process) return;
      releaseProcess?.();
      releaseProcess = undefined;
      process = next;
      dirty = true;
      durableRevision++;
      if (!next) return;
      const releaseViewer = next.registerViewer();
      const unsubscribe = next.subscribe((event: ProcessEvent) => {
        if (signal.aborted) return;
        if (event.type === "message")
          add(event.message as Record<string, unknown>);
        else if (
          ["state-change", "complete", "terminated"].includes(event.type)
        ) {
          dirty = true;
          durableRevision++;
          invalidate();
        }
      });
      releaseProcess = () => {
        try {
          unsubscribe();
        } finally {
          releaseViewer();
        }
      };
      for (const message of next.getMessageHistory())
        add(message as Record<string, unknown>);
    };
    const changed = () => {
      dirty = true;
      durableRevision++;
      attachProcess();
      // Provider tokens do not initiate disk acquisition. During a managed turn,
      // finalized messages update memory; durable reconciliation waits for idle.
      if (process?.state.type !== "in-turn") invalidate();
    };
    const unsubscribe = deps.eventBus?.subscribe((event) => {
      if (signal.aborted) return;
      if (
        event.type === "file-change" &&
        event.path ===
          (row?.location.kind === "file" ? row.location.path : undefined)
      )
        changed();
      else if ("sessionId" in event && event.sessionId === sessionId) changed();
      else if (event.type === "session-catalog-updated" && !row) invalidate();
    });
    attachProcess();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const release of [unsubscribe, releaseProcess, releaseWatch]) {
        try {
          release?.();
        } catch {
          // One observer failure must not pin the other observer lifetimes.
        }
      }
      signal.removeEventListener("abort", close);
      live.clear();
      baseline = undefined;
    };
    signal.addEventListener("abort", close, { once: true });
    if (signal.aborted) close();
    return {
      async read(readSignal) {
        if (closed) throw new Error("Conversation source is closed");
        readSignal.throwIfAborted();
        signal.throwIfAborted();
        attachProcess();
        // A live record YA could not keep is recoverable, not terminal: once the
        // turn ends the provider file holds it, so force reconciliation and only
        // refuse when the durable read still leaves memory unusable.
        if (failed) {
          if (process?.state.type === "in-turn")
            throw new Error("Unreconciled live conversation");
          dirty = true;
        }
        if (!row) {
          row = await deps.resolve(sessionId, signal);
          readSignal.throwIfAborted();
          signal.throwIfAborted();
          if (!row) {
            if (
              !process ||
              process.sessionId !== sessionId ||
              !["claude", "codex"].includes(process.provider ?? "")
            )
              throw new Error("Conversation source not found");
          } else {
            if (row.sessionId !== sessionId || row.location.kind !== "file")
              throw new Error("Conversation source not found");
            releaseWatch = deps.watch?.(row, changed);
          }
        }
        if (
          row &&
          (row.location.kind !== "file" ||
            !["claude", "codex"].includes(row.catalogFamily))
        )
          throw new Error("Unsupported conversation source");
        if (
          row &&
          row.location.kind === "file" &&
          (!baseline || (dirty && process?.state.type !== "in-turn"))
        ) {
          const liveAtReadStart = new Map(live);
          const observedRevision = durableRevision;
          const settledAtReadStart =
            !process ||
            process.state.type === "idle" ||
            process.state.type === "terminated";
          const result = await (deps.readFile ?? readConversationFile)({
            path: row.location.path,
            provider: row.catalogFamily as "claude" | "codex",
            sessionId: row.nativeSessionId ?? row.sessionId,
            signal: readSignal,
            resolveRolloutPath: deps.resolveRolloutPath
              ? (id) => deps.resolveRolloutPath!(row!, id)
              : undefined,
          });
          readSignal.throwIfAborted();
          signal.throwIfAborted();
          baseline = { ...result, sessionId };
          dirty = observedRevision !== durableRevision;
          for (const message of result.messages) {
            const id = getMessageId(message);
            const previous = live.get(id);
            if (
              previous &&
              previous === liveAtReadStart.get(id) &&
              process?.state.type !== "in-turn"
            ) {
              liveBytes -= previous.bytes;
              live.delete(id);
            }
          }
          if (
            failed &&
            settledAtReadStart &&
            observedRevision >= failedAtRevision
          ) {
            // Dropped records left no byte accounting behind; re-derive it from
            // what memory still holds before deciding the source is usable.
            liveBytes = [...live.values()].reduce(
              (total, entry) => total + entry.bytes,
              0,
            );
            failed =
              liveBytes > MAX_PROJECTION_INPUT_BYTES ||
              live.size >= MAX_PROJECTION_RECORDS;
          }
        }
        if (failed) throw new Error("Unreconciled live conversation");
        // A durable record wins over its replay echo. Unpersisted records retain
        // arrival order and stable IDs; the bounded producer detects collisions.
        // The incumbent owner's bounded replay can precede catalog/file
        // materialization. It is useful partial evidence, never complete history.
        const durable = baseline ?? {
          sessionId,
          messages: [],
          activity: "unknown" as const,
          pendingRequests: [],
          sourceCoverage: {
            complete: false,
            earlierOutsideScope: "unknown" as const,
          },
        };
        const known = new Set(durable.messages.map(getMessageId));
        const messages = [
          ...durable.messages.map(
            (message) => live.get(getMessageId(message))?.message ?? message,
          ),
          ...[...live.entries()]
            .filter(([id]) => !known.has(id))
            .map(([, value]) => value.message),
        ];
        const state = process?.state;
        const waiting = state?.type === "waiting-input";
        return {
          ...durable,
          messages,
          activity:
            state?.type === "in-turn"
              ? "working"
              : waiting
                ? "waiting"
                : state?.type === "idle"
                  ? "idle"
                  : "unknown",
          // Preserve the existence of an unsupported approval as an opaque row;
          // never copy provider arguments or imply this preview can answer it.
          pendingRequests: waiting
            ? [
                {
                  kind: "unknown",
                  originalKind: "approval",
                  raw: {
                    kind: "approval",
                    label: "Open the full session to respond",
                    canAnswer: false,
                  },
                },
              ]
            : [],
          sourceCoverage: {
            ...durable.sourceCoverage,
            complete:
              durable.sourceCoverage.complete && state?.type !== "in-turn",
          },
        };
      },
      close,
    };
  };
}
