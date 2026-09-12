import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import { UI_KEYS } from "../storageKeys";
import type { Message, SessionMetadata } from "../../types";
import type { SessionDetailRuntimeSnapshot } from "./selectors";

type MessageSource = "sdk" | "jsonl" | undefined;

interface CompactMessage {
  id: string;
  type?: string;
  role?: string;
  source?: MessageSource;
  parent?: string | null;
  streaming?: true;
}

interface CompactAgent {
  status: string;
  count: number;
  first?: CompactMessage;
  last?: CompactMessage;
}

interface CompactPagination {
  hasOlderMessages?: boolean;
  truncatedBeforeMessageId?: string;
  totalMessageCount?: number;
  returnedMessageCount?: number;
  totalCompactions?: number;
}

interface CompactSessionDetail {
  sessionId?: string;
  provider?: string;
  messageCount: number;
  messageHash: string;
  firstMessages: CompactMessage[];
  lastMessages: CompactMessage[];
  pagination?: CompactPagination;
  agentKeys: string[];
  agents: Record<string, CompactAgent>;
  toolUseToAgentEntries: Array<[string, string]>;
}

export interface SessionDetailRuntimeStateInput {
  messages: SessionDetailRuntimeSnapshot["messages"];
  session: SessionMetadata | null;
  pagination?: SessionDetailRuntimeSnapshot["pagination"];
  agentContent: SessionDetailRuntimeSnapshot["agentContent"];
  toolUseToAgentEntries: SessionDetailRuntimeSnapshot["toolUseToAgentEntries"];
}

export interface SessionDetailStoreDivergenceInput {
  boundary: string;
  projectId: string;
  sessionId: string;
  live: SessionDetailRuntimeStateInput;
  store: SessionDetailRuntimeSnapshot;
}

declare global {
  interface Window {
    __YA_SESSION_DETAIL_SHADOW_DIAGNOSTICS__?: boolean;
  }
}

const MESSAGE_SAMPLE_SIZE = 6;
const loggedDivergenceKeys = new Set<string>();

function readLocalStorageFlag(): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }
  try {
    return (
      localStorage.getItem(UI_KEYS.sessionDetailShadowDiagnostics) === "true"
    );
  } catch {
    return false;
  }
}

export function isSessionDetailShadowDiagnosticsEnabled(): boolean {
  if (!import.meta.env.DEV) {
    return false;
  }
  if (
    typeof window !== "undefined" &&
    window.__YA_SESSION_DETAIL_SHADOW_DIAGNOSTICS__ === true
  ) {
    return true;
  }
  return readLocalStorageFlag();
}

function compactMessage(
  message: Message | undefined,
): CompactMessage | undefined {
  if (!message) {
    return undefined;
  }
  const role = message.message?.role ?? message.role;
  return {
    id: getMessageId(message),
    type: message.type,
    role,
    source: message._source,
    parent: message.parentUuid,
    ...(message._isStreaming === true ? { streaming: true } : {}),
  };
}

function compactMessages(messages: readonly Message[]): CompactMessage[] {
  return messages
    .map((message) => compactMessage(message))
    .filter((message): message is CompactMessage => message !== undefined);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function compactPagination(
  pagination: SessionDetailRuntimeSnapshot["pagination"],
): CompactPagination | undefined {
  if (!pagination) {
    return undefined;
  }
  return {
    hasOlderMessages: pagination.hasOlderMessages,
    truncatedBeforeMessageId: pagination.truncatedBeforeMessageId,
    totalMessageCount: pagination.totalMessageCount,
    returnedMessageCount: pagination.returnedMessageCount,
    totalCompactions: pagination.totalCompactions,
  };
}

function compactAgent(
  agentContent: SessionDetailRuntimeSnapshot["agentContent"][string],
): CompactAgent {
  return {
    status: agentContent.status,
    count: agentContent.messages.length,
    first: compactMessage(agentContent.messages[0]),
    last: compactMessage(agentContent.messages.at(-1)),
  };
}

function compactSessionDetail(
  input: SessionDetailRuntimeStateInput,
): CompactSessionDetail {
  const messages = compactMessages(input.messages);
  const agentKeys = Object.keys(input.agentContent).sort();
  const agents = Object.fromEntries(
    agentKeys.flatMap((agentId) => {
      const agentContent = input.agentContent[agentId];
      return agentContent ? [[agentId, compactAgent(agentContent)]] : [];
    }),
  );
  const toolUseToAgentEntries = [...input.toolUseToAgentEntries].sort(
    ([left], [right]) => left.localeCompare(right),
  );

  return {
    sessionId: input.session?.id,
    provider: input.session?.provider,
    messageCount: messages.length,
    messageHash: hashString(JSON.stringify(messages)),
    firstMessages: messages.slice(0, MESSAGE_SAMPLE_SIZE),
    lastMessages: messages.slice(-MESSAGE_SAMPLE_SIZE),
    pagination: compactPagination(input.pagination),
    agentKeys,
    agents,
    toolUseToAgentEntries,
  };
}

function comparableCompact(input: CompactSessionDetail): string {
  return JSON.stringify({
    sessionId: input.sessionId,
    provider: input.provider,
    messageCount: input.messageCount,
    messageHash: input.messageHash,
    pagination: input.pagination,
    agentKeys: input.agentKeys,
    agents: input.agents,
    toolUseToAgentEntries: input.toolUseToAgentEntries,
  });
}

function findFirstMessageDiff(
  liveMessages: readonly Message[],
  storeMessages: readonly Message[],
): { index: number; live?: CompactMessage; store?: CompactMessage } | null {
  const count = Math.max(liveMessages.length, storeMessages.length);
  for (let index = 0; index < count; index += 1) {
    const live = compactMessage(liveMessages[index]);
    const store = compactMessage(storeMessages[index]);
    if (JSON.stringify(live) !== JSON.stringify(store)) {
      return { index, live, store };
    }
  }
  return null;
}

export function reportSessionDetailStoreDivergence(
  input: SessionDetailStoreDivergenceInput,
): void {
  if (!isSessionDetailShadowDiagnosticsEnabled()) {
    return;
  }

  const live = compactSessionDetail(input.live);
  const store = compactSessionDetail(input.store);
  const liveKey = comparableCompact(live);
  const storeKey = comparableCompact(store);
  if (liveKey === storeKey) {
    return;
  }

  const divergenceKey = [
    "store",
    input.boundary,
    input.projectId,
    input.sessionId,
    hashString(liveKey),
    hashString(storeKey),
  ].join(":");
  if (loggedDivergenceKeys.has(divergenceKey)) {
    return;
  }
  loggedDivergenceKeys.add(divergenceKey);

  console.warn("[SessionDetailStore]", {
    event: "session-detail-store-divergence",
    boundary: input.boundary,
    projectId: input.projectId,
    sessionId: input.sessionId,
    provider: live.provider ?? store.provider,
    firstMessageDiff: findFirstMessageDiff(
      input.live.messages,
      input.store.messages,
    ),
    live,
    store,
  });
}

export function __resetSessionDetailShadowDiagnosticsForTest(): void {
  loggedDivergenceKeys.clear();
}
