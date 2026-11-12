import { defaultSessionDetailStore as store } from "../../src/lib/sessionDetail/sessionDetailStore";
import { mountTranscript } from "./render";
import { setConversationViewPreference } from "../../src/hooks/useConversationView";
import {
  setSessionActiveWindowTrimPreference,
  setSessionInitialHistoryCompactionsPreference,
} from "../../src/hooks/useSessionPerformanceSettings";
import { history, entryKey, metadata, turn } from "./fixture";
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
const initial = history(count);
// Hold history size fixed to isolate retained-history from mounted-DOM costs.
// Normal sessions retain the existing default active-window trimming behavior.
setSessionInitialHistoryCompactionsPreference(null);
setSessionActiveWindowTrimPreference(false);
setConversationViewPreference(false);
const source = installSource(initial);
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
window.__transcriptFixture = {
  mode,
  count,
  prepare(markers: string[]) {
    return markers.map((marker) => turn(next++, marker));
  },
  append(rows: ReturnType<typeof turn>) {
    const at = performance.now();
    store.dispatch(entryKey, { type: "applyCatchupMessages", messages: rows });
    return { at, count: read().length };
  },
  snapshot() {
    return {
      loadedMessages: read().length,
      entries: store.getStats().entries,
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
      snapshot(): {
        loadedMessages: number;
        entries: unknown;
        unexpected: string[];
        requests: string[];
      };
      dispose(): void;
    };
  }
}
