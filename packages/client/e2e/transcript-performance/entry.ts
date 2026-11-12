import { defaultSessionDetailStore as store } from "../../src/lib/sessionDetail/sessionDetailStore";
import { mountTranscript } from "./render";
import { setConversationViewPreference } from "../../src/hooks/useConversationView";
import {
  setSessionActiveWindowTrimPreference,
  setSessionInitialHistoryCompactionsPreference,
} from "../../src/hooks/useSessionPerformanceSettings";
import { history, entryKey as fixedEntryKey, metadata, turn } from "./fixture";
import { rollingHistory, rollingUpdate } from "./rolling";
import { installSource } from "./source";
import "../../src/styles/purposeGlobals";

const params = new URLSearchParams(location.search);
const count = Number(params.get("turns") ?? 100);
const mode = params.get("view") ?? "transcript";
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 10000 ||
  !["transcript", "page"].includes(mode)
)
  throw new Error("Invalid fixture configuration");
const retention = params.get("retention") ?? "fixed";
if (
  !["fixed", "rolling", "growing"].includes(retention) ||
  (retention !== "fixed" && (mode !== "page" || count < 20))
)
  throw new Error("Invalid retention workload");
const rolling = retention !== "fixed";
const entryKey = rolling
  ? { ...fixedEntryKey, initialHistoryCompactions: 2, tailTurns: 20 }
  : fixedEntryKey;
const initial = rolling ? rollingHistory(count) : history(count);
// Hold history size fixed to isolate retained-history from mounted-DOM costs.
// Normal sessions retain the existing default active-window trimming behavior.
setSessionInitialHistoryCompactionsPreference(rolling ? 2 : null);
setSessionActiveWindowTrimPreference(retention === "rolling");
setConversationViewPreference(false);
const source = installSource(initial, { rolling, totalTurns: count });
const read = () => store.read(entryKey)?.messages ?? initial;
const subscribe = (listener: () => void) =>
  store.subscribe(entryKey, (s) => s?.messages, listener);
const release = store.retain(entryKey);
store.dispatch(entryKey, {
  type: "loadPersistedTranscript",
  messages: initial,
  session: metadata(initial.length),
});

if (mode === "page") {
  void import("../../src/main");
} else {
  mountTranscript(read, subscribe);
}
let next = count;
let updateIndex = 0;
function retained() {
  const messages = read();
  return {
    loadedMessages: messages.length,
    retention,
    trimRevision: store.read(entryKey)?.activeWindowTrimRevision ?? 0,
    firstMessageId: messages[0]?.uuid,
    lastMessageId: messages.at(-1)?.uuid,
  };
}
window.__transcriptFixture = {
  mode,
  count,
  prepare(markers: string[]) {
    return markers.map((marker) => turn(next++, marker));
  },
  append(rows: ReturnType<typeof turn>) {
    const messages = rolling ? rollingUpdate(updateIndex++, rows) : rows;
    const at = performance.now();
    if (rolling) source.publish(messages);
    else store.dispatch(entryKey, { type: "applyCatchupMessages", messages });
    return { at, count: read().length };
  },
  retained: rolling ? retained : undefined,
  snapshot() {
    const entries = store.getStats().entries;
    return {
      ...retained(),
      compactions: read().filter(
        (message) =>
          message.type === "system" && message.subtype === "compact_boundary",
      ).length,
      approxBytes:
        entries.find((entry) => entry.sessionId === entryKey.sessionId)
          ?.approxBytes ?? 0,
      entries,
      unexpected: [...source.unexpected],
      requests: source.requests,
    };
  },
  dispose() {
    release();
    source.dispose();
    store.clear();
  },
};
window.addEventListener(
  "pagehide",
  () => window.__transcriptFixture.dispose(),
  { once: true },
);

declare global {
  interface Window {
    __transcriptFixture: {
      mode: string;
      count: number;
      prepare(markers: string[]): ReturnType<typeof turn>[];
      append(rows: ReturnType<typeof turn>): { at: number; count: number };
      retained?(): {
        loadedMessages: number;
        retention: string;
        trimRevision: number;
        firstMessageId: string | undefined;
        lastMessageId: string | undefined;
      };
      snapshot(): {
        loadedMessages: number;
        retention: string;
        trimRevision: number;
        compactions: number;
        firstMessageId: string | undefined;
        lastMessageId: string | undefined;
        approxBytes: number;
        entries: unknown;
        unexpected: string[];
        requests: string[];
      };
      dispose(): void;
    };
  }
}
