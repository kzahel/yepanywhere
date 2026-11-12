import type {
  EffortLevel,
  ProviderName,
  ThinkingConfig,
} from "@yep-anywhere/shared";
import { type ReactNode, createContext, useContext, useMemo } from "react";

/**
 * Minimal session metadata for components that need project/session info.
 * Keep this focused - only add fields that are truly needed across the component tree.
 *
 * Every transcript text block and tool row consumes this context, so a new
 * value re-renders the whole visible transcript. Keep fields that change
 * often (such as the session title) out of it, and keep the value's identity
 * stable while its contents are unchanged.
 */
interface SessionMetadata {
  projectId: string;
  projectPath: string | null;
  sessionId: string;
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
}

const SessionMetadataContext = createContext<SessionMetadata | null>(null);

export function SessionMetadataProvider({
  projectId,
  projectPath,
  sessionId,
  provider,
  model,
  thinking,
  effort,
  children,
}: SessionMetadata & { children: ReactNode }) {
  // Callers rebuild `thinking` on every render; compare it by value so an
  // unchanged config does not publish a new context value.
  const thinkingKey = thinking === undefined ? "" : JSON.stringify(thinking);
  const value = useMemo<SessionMetadata>(
    () => ({
      projectId,
      projectPath,
      sessionId,
      provider,
      model,
      thinking: thinkingKey
        ? (JSON.parse(thinkingKey) as ThinkingConfig)
        : undefined,
      effort,
    }),
    [projectId, projectPath, sessionId, provider, model, thinkingKey, effort],
  );

  return (
    <SessionMetadataContext.Provider value={value}>
      {children}
    </SessionMetadataContext.Provider>
  );
}

/**
 * Get session metadata. Throws if used outside SessionMetadataProvider.
 */
export function useSessionMetadata(): SessionMetadata {
  const context = useContext(SessionMetadataContext);
  if (!context) {
    throw new Error(
      "useSessionMetadata must be used within SessionMetadataProvider",
    );
  }
  return context;
}

export function useOptionalSessionMetadata(): SessionMetadata | null {
  return useContext(SessionMetadataContext);
}
