import type { AgentAuthRouterIssueCode } from "@yep-anywhere/shared";
export interface RouterInfo {
  protocol: number;
  routerId: string;
  inferenceOrigin: string;
  capabilities: string[];
  supportedPolicies?: string[];
  policies?: { id: string; label: string }[];
}
export interface RouterPairing {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  interval: number;
}
interface ConnectionIdentity {
  id: string;
  token: string;
  routerId: string;
  pairingIssue?: { code: AgentAuthRouterIssueCode; message: string };
  state: "pairing" | "connected" | "revocation-pending" | "disconnected";
}
export type RouterConnection = ConnectionIdentity &
  (
    | { kind?: "local"; socketPath: string }
    | {
        kind: "hosted";
        origin: string;
        name: string;
        startedAt?: number;
        pendingApproval?: boolean;
        pairing?: RouterPairing;
        expired?: boolean;
      }
  );
export type RouterEndpoint = string | { origin: string };
export const routerEndpoint = (c: RouterConnection): RouterEndpoint =>
  c.kind === "hosted" ? { origin: c.origin } : c.socketPath;
