/** Owner settings surface; a saved browser host is independent of a peer pair. */
export interface PeerServerIdentity {
  serverId: string;
  hostname: string;
  os: string;
  architecture: string;
  icon?: string;
}
export type PeerConnectionRoute =
  | { kind: "direct"; url: string }
  | { kind: "relay"; url: string; username: string };
export interface PeerConnectionDirection {
  authentication?: {
    mode: "automatic" | "fixed";
    status: "ready" | "unavailable" | "sign-in-required" | "update-required";
    lastRefreshedAt?: number;
    nextAttemptAt?: number;
  };
  credentialId: string;
  generation: number;
  expiresAt: number;
  active: boolean;
  origin: "manual" | "fleet";
  allProjects: boolean;
  selected?: boolean;
  route?: PeerConnectionRoute;
}
export interface PeerConnectionEntry {
  serverId: string;
  identity?: PeerServerIdentity;
  label?: string;
  setupRoute?: PeerConnectionRoute;
  setupUsername?: string;
  createdAt?: string;
  updatedAt?: string;
  verifiedAt?: string;
  lastOutcome?: "verified" | "partial" | "uncertain" | "failed";
  incoming: PeerConnectionDirection[];
  outgoing: PeerConnectionDirection[];
}
export interface PeerConnectionAudit {
  id: string;
  at: string;
  serverId: string | null;
  action: string;
  actor: "owner";
  initiatingServerId?: string;
  operationId?: string;
  credentialId?: string;
  generation?: number;
}
export interface PeerConnectionsResponse {
  identity: PeerServerIdentity;
  enabled: boolean;
  environmentOverride: boolean | null;
  agentAccess: { enabled: boolean; grantId?: string };
  peers: PeerConnectionEntry[];
  audit: PeerConnectionAudit[];
  nextCursor: string | null;
  total: number;
  relay: { url: string; username: string; enabled: boolean } | null;
}
export interface PeerConnectionSetupRequest {
  automaticSignIn?: boolean;
  route: PeerConnectionRoute;
  username: string;
  password: string;
  label?: string;
  bidirectional?: boolean;
  returnRoute?: PeerConnectionRoute;
  expectedServerId?: string;
  replace?: boolean;
  direction?: "outgoing" | "incoming" | "both";
}
export interface PeerConnectionSetupResponse {
  serverId: string;
  outcome: "connected" | "partial" | "uncertain";
  outgoing: "confirmed" | "unknown" | "unchanged";
  incoming: "confirmed" | "unknown" | "not-requested";
  ownerSessionCleanup: "confirmed" | "unconfirmed";
  operationId: string;
  issue?: string;
}
