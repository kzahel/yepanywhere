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
  resolve(sessionId: string): Promise<Readonly<SessionCatalogRow> | undefined>;
  getProcess(
    sessionId: string,
  ):
    | Pick<
        Process,
        "state" | "subscribe" | "registerViewer" | "getMessageHistory"
      >
    | undefined;
  eventBus?: EventBus;
  watch?(row: Readonly<SessionCatalogRow>, invalidate: () => void): () => void;
  readFile?: typeof readConversationFile;
}

/** One observed source per session, shared by the subscription owner. */
export function createConversationSource(
  deps: ConversationSourceDependencies,
): OpenConversationSource {
  return async (sessionId, invalidate, signal) => {
    let row: Readonly<SessionCatalogRow> | undefined;
    let baseline: ConversationInput | undefined;
    let dirty = true;
    let durableRevision = 0;
    let process: ReturnType<ConversationSourceDependencies["getProcess"]>;
    let releaseProcess: (() => void) | undefined;
    let releaseWatch: (() => void) | undefined;
    let failed = false;
    let liveBytes = 0;
    const live = new Map<string, { message: Message; bytes: number }>();
    const add = (raw: Record<string, unknown>) => {
      if (failed || signal.aborted) return;
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
      if (!id) {
        if (message.type === "system") return;
        failed = true;
        invalidate();
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      const nextBytes = liveBytes - (live.get(id)?.bytes ?? 0) + bytes;
      if (
        nextBytes > MAX_PROJECTION_INPUT_BYTES ||
        (!live.has(id) && live.size >= MAX_PROJECTION_RECORDS)
      ) {
        failed = true;
        invalidate();
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
        if (failed) throw new Error("Unreconciled live conversation");
        if (!row) {
          row = await deps.resolve(sessionId);
          readSignal.throwIfAborted();
          signal.throwIfAborted();
          if (
            !row ||
            row.sessionId !== sessionId ||
            row.location.kind !== "file"
          )
            throw new Error("Conversation source not found");
          releaseWatch = deps.watch?.(row, changed);
        }
        if (
          row.location.kind !== "file" ||
          !["claude", "codex"].includes(row.catalogFamily)
        )
          throw new Error("Unsupported conversation source");
        if (!baseline || (dirty && process?.state.type !== "in-turn")) {
          const liveAtReadStart = new Map(live);
          const observedRevision = durableRevision;
          const result = await (deps.readFile ?? readConversationFile)({
            path: row.location.path,
            provider: row.catalogFamily as "claude" | "codex",
            sessionId,
            signal: readSignal,
          });
          readSignal.throwIfAborted();
          signal.throwIfAborted();
          baseline = result;
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
        }
        // A durable record wins over its replay echo. Unpersisted records retain
        // arrival order and stable IDs; the bounded producer detects collisions.
        const known = new Set(baseline.messages.map(getMessageId));
        const messages = [
          ...baseline.messages.map(
            (message) => live.get(getMessageId(message))?.message ?? message,
          ),
          ...[...live.entries()]
            .filter(([id]) => !known.has(id))
            .map(([, value]) => value.message),
        ];
        const state = process?.state;
        const waiting = state?.type === "waiting-input";
        return {
          ...baseline,
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
            ...baseline.sourceCoverage,
            complete:
              baseline.sourceCoverage.complete && state?.type !== "in-turn",
          },
        };
      },
      close,
    };
  };
}
