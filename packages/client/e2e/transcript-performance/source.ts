import { FakeSourceTransport } from "../../src/lib/transport/FakeSourceTransport";
import { getSourceRuntimeRegistry } from "../../src/lib/sourceRuntime";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY } from "../../src/lib/clientSummaryStore";
import type { Message } from "../../src/types";
import { project, projectId, sessionId, metadata } from "./fixture";

export function installSource(messages: Message[]) {
  const requests: string[] = [];
  const unexpected = new Set<string>();
  const session = metadata(messages.length);
  const sessions = [
    session,
    ...Array.from({ length: 200 }, (_, i) => ({
      ...session,
      id: `idle-${i}`,
      title: `Idle session ${i}`,
      fullTitle: `Idle session ${i}`,
    })),
  ];
  const catalog = {
    catalogEpoch: "frontend-fixture",
    catalogGeneration: 1,
    complete: true,
    refreshing: false,
  };
  function answer(path: string, init?: RequestInit): unknown {
    requests.push(`${init?.method ?? "GET"} ${path}`);
    const url = new URL(path, "http://fixture");
    const p = url.pathname;
    if (p === "/auth/status")
      return {
        enabled: false,
        authenticated: true,
        setupRequired: false,
        localhostOpen: true,
      };
    if (p === "/version")
      return {
        current: "0.12.0",
        latest: "0.12.0",
        updateAvailable: false,
        serverRuntime: { kind: "node", version: "25.8.2" },
        voiceBackends: [],
      };
    if (p === "/settings") return { settings: {}, displayDefaults: {} };
    if (p === "/onboarding") return { complete: true };
    if (p === "/host-identity") return { icon: null, name: "Synthetic source" };
    if (p === "/providers")
      return {
        providers: [
          {
            name: "claude",
            displayName: "Claude",
            installed: true,
            authenticated: true,
            available: true,
            supportsPermissionMode: true,
            models: [
              {
                id: "claude-sonnet-4-5",
                name: "Sonnet",
                supportsThinking: false,
              },
            ],
          },
        ],
      };
    if (p === "/projects") return { projects: [project], catalog };
    if (p === `/projects/${projectId}`) return { project };
    if (p === "/sessions" || p === `/projects/${projectId}/sessions`) {
      const selected =
        url.searchParams.has("starred") || url.searchParams.has("categorized")
          ? []
          : sessions;
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const end = offset + limit;
      return {
        sessions: selected.slice(offset, end),
        hasMore: end < selected.length,
        nextCursor: end < selected.length ? String(end) : undefined,
        projects: [project],
        catalog,
      };
    }
    if (p === "/inbox")
      return {
        needsAttention: [],
        active: [],
        recentActivity: [],
        unread8h: [],
        unread24h: [],
        catalog,
      };
    if (
      p === `/projects/${projectId}/sessions/${sessionId}` ||
      p === `/projects/${projectId}/sessions/${sessionId}/metadata`
    )
      return {
        session,
        messages,
        ownership: session.ownership,
        processState: "idle",
        deferredMessages: [],
        pagination: {
          hasOlderMessages: false,
          totalMessageCount: messages.length,
          returnedMessageCount: messages.length,
          totalCompactions: 0,
        },
      };
    if (p === `/projects/${projectId}/git`)
      return { isGitRepo: false, branch: null, files: [] };
    if (p === `/sessions/${sessionId}/mark-seen`)
      return { ok: true, timestamp: new Date().toISOString() };
    if (p === `/projects/${projectId}/sessions/${sessionId}/refresh-preview`)
      return { lastAgentText: null };
    if (p === "/recents/visit") return { ok: true };
    if (p === `/projects/${projectId}/app`)
      return {
        projectId,
        declaration: null,
        state: "none",
        latestArtifact: null,
        canExecute: false,
      };
    if (p === "/project-queue") return { items: [], paused: false };
    if (p === "/public-shares/status")
      return { enabled: false, configured: false };
    if (p === "/processes") return { processes: [] };
    if (p === "/dev/status") return { enabled: false };
    if (p === "/drafts/index")
      return { sessionIds: [], drafts: [], sequence: 0 };
    if (p === "/drafts/changes")
      return { changes: [], sequence: 0, hasMore: false };
    if (p === "/drafts/read") return { drafts: [], sequence: 0 };
    if (p === "/drafts/write") return { sequence: 0, drafts: [] };
    if (/\/queue$/.test(p)) return { items: [], paused: false };
    if (/\/child-sessions$/.test(p)) return { sessions: [] };
    unexpected.add(`${init?.method ?? "GET"} ${p}`);
    throw new Error(`Unconfigured frontend fixture request: ${p}`);
  }
  const fake = new FakeSourceTransport({
    capabilities: { sameOriginUrls: true },
    fetch: async <T>(path: string, init?: RequestInit) =>
      answer(path, init) as T,
    fetchResponse: async (path, init) =>
      new Response(JSON.stringify(answer(path, init)), {
        headers: { "Content-Type": "application/json" },
      }),
  });
  const opened = new Set<string>();
  // Open subscriptions on creation; no harness polling during measurements.
  const transport = new Proxy(fake, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        if (String(key).startsWith("subscribe"))
          queueMicrotask(() => {
            for (const sub of fake.getSubscriptions()) {
              if (sub.closed || opened.has(sub.id)) continue;
              opened.add(sub.id);
              fake.openSubscription(sub.id);
              if (sub.kind === "activity")
                fake.emitSubscriptionEvent(sub.id, "connected", {});
            }
          });
        return result;
      };
    },
  });
  getSourceRuntimeRegistry().registerSourceTransport(
    LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
    {
      kind: "custom",
      createTransport: () => transport,
    },
  );
  return {
    transport,
    requests,
    unexpected,
    dispose() {
      transport.dispose();
    },
  };
}
