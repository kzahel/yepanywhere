import type { ProviderName } from "./types.js";

/** Relationship references grant no authority to control either endpoint. */
export type SessionRelationshipEndpoint =
  | {
      kind: "session";
      serverId: string;
      sessionId: string;
      projectId: string;
      provider: ProviderName;
    }
  | {
      kind: "provider-child";
      serverId: string;
      parentSessionId: string;
      childId: string;
      projectId: string;
      provider: ProviderName;
    };

export interface SessionRelationshipProof {
  trust:
    | "local-authenticated"
    | "peer-attested"
    | "provider-observed"
    | "command-observed";
  observedAt: string;
  title?: string;
  agentType?: string;
  toolUseId?: string;
  spawnDepth?: number;
  sourceTimestamp?: string;
}

export interface SessionRelationshipPage {
  relationships: {
    /** Unknown future predicates are display-only, never child controls. */
    type: string;
    source: SessionRelationshipEndpoint;
    target: SessionRelationshipEndpoint;
    evidence: SessionRelationshipProof[];
  }[];
  nextCursor: string | null;
}
