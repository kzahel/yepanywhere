import type { Principal } from "../auth/principal.js";
import type { ApiCreator } from "./command-contracts.js";
import type { Operation } from "./contracts.js";
import { CoreApiError } from "./errors.js";

/** Established by the receiving authenticator, never by operation JSON. */
export interface PeerPrincipal {
  kind: "peer";
  serverId: string;
  credentialId: string;
  credentialGeneration?: number;
  allProjects?: true;
  projects: readonly string[];
  operations: readonly Operation[];
  sourceSessionId: string | null;
  sourceLaunchId: string | null;
  signal: AbortSignal;
  assertActive(): void;
}
export type ApiPrincipal = Principal | PeerPrincipal;

export function assertPeerOperation(
  caller: ApiPrincipal,
  operation: Operation,
) {
  if (caller.kind !== "peer") return;
  caller.assertActive();
  if (!caller.operations.includes(operation))
    throw new CoreApiError("forbidden", "Peer operation is not granted", 403);
}

export function peerProject(caller: PeerPrincipal, projectId: string) {
  caller.assertActive();
  return caller.allProjects === true || caller.projects.includes(projectId);
}

export function peerCreator(caller: PeerPrincipal): ApiCreator {
  caller.assertActive();
  return {
    serverId: caller.serverId,
    sessionId: caller.sourceSessionId,
    launchId: caller.sourceLaunchId,
    principal: { kind: "peer" },
    authentication: {
      credentialId: caller.credentialId,
      generation: caller.credentialGeneration,
      sessionAttribution: "source-attested",
    },
  };
}
