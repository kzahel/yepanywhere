import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from "react";
import { api } from "../api/client";
import type { AgentContent, AgentContentMap } from "../hooks/useSession";

interface AgentContentContextValue {
  /** Map of agentId → agent content (messages + status) */
  agentContent: AgentContentMap;
  /** Mapping from Task tool_use_id → agentId (for rendering during streaming) */
  toolUseToAgent: Map<string, string>;
  /** Load agent content from server (for lazy-loading completed tasks) */
  loadAgentContent: (
    projectId: string,
    sessionId: string,
    agentId: string,
  ) => Promise<AgentContent>;
  /** The current project ID */
  projectId: string;
}

export const AgentContentContext =
  createContext<AgentContentContextValue | null>(null);

interface AgentContentProviderProps {
  children: ReactNode;
  /** Live agentContent from useSession (for streaming updates) */
  agentContent: AgentContentMap;
  /** Merge loaded agent content through the session detail action layer */
  mergeLoadedAgentContent: (agentId: string, content: AgentContent) => void;
  /** Mapping from Task tool_use_id → agentId (for rendering during streaming) */
  toolUseToAgent: Map<string, string>;
  projectId: string;
  sessionId: string;
}

export function AgentContentProvider({
  children,
  agentContent,
  mergeLoadedAgentContent,
  toolUseToAgent,
  projectId,
}: AgentContentProviderProps) {
  // Agents whose JSONL has been loaded, as distinct from content that only
  // arrived over the stream.
  const loadedAgentsRef = useRef<Set<string>>(new Set());
  const inFlightLoadsRef = useRef<Map<string, Promise<AgentContent>>>(
    new Map(),
  );

  const loadAgentContent = useCallback(
    (
      loadProjectId: string,
      loadSessionId: string,
      agentId: string,
    ): Promise<AgentContent> => {
      if (loadedAgentsRef.current.has(agentId)) {
        return Promise.resolve(
          agentContent[agentId] ?? { messages: [], status: "pending" },
        );
      }

      const inFlight = inFlightLoadsRef.current.get(agentId);
      if (inFlight) return inFlight;

      const fetchAndMerge = async (): Promise<AgentContent> => {
        try {
          const data = await api.getAgentSession(
            loadProjectId,
            loadSessionId,
            agentId,
          );
          loadedAgentsRef.current.add(agentId);
          mergeLoadedAgentContent(agentId, data);
          return { messages: data.messages, status: data.status };
        } catch (error) {
          console.error(`Failed to load agent content for ${agentId}:`, error);
          return { messages: [], status: "failed" };
        }
      };
      // A failed load leaves the agent unloaded, so the next request retries.
      const load = fetchAndMerge().finally(() => {
        inFlightLoadsRef.current.delete(agentId);
      });
      inFlightLoadsRef.current.set(agentId, load);
      return load;
    },
    [agentContent, mergeLoadedAgentContent],
  );

  // Memoize so the context value only changes when its contents actually
  // change. Without this, every SessionPage re-render (≈1/s from status
  // timers) produced a fresh value object, and context propagation re-renders
  // every consumer (subagent Task/SpawnAgent rows and their nested rows)
  // through their `memo` boundaries — a per-second O(subagent-rows) idle churn.
  const value = useMemo<AgentContentContextValue>(
    () => ({
      agentContent,
      toolUseToAgent,
      loadAgentContent,
      projectId,
    }),
    [agentContent, toolUseToAgent, loadAgentContent, projectId],
  );

  return (
    <AgentContentContext.Provider value={value}>
      {children}
    </AgentContentContext.Provider>
  );
}

/**
 * Hook to access agent content context.
 * Provides access to subagent messages and lazy-loading functionality.
 */
export function useAgentContent() {
  const context = useContext(AgentContentContext);
  if (!context) {
    throw new Error(
      "useAgentContent must be used within an AgentContentProvider",
    );
  }
  return context;
}
