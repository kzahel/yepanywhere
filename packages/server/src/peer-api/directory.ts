import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Operation } from "../core-api/contracts.js";
import type { PeerPrincipal } from "../core-api/peer-policy.js";
import { CoreApiError } from "../core-api/errors.js";
import type { IdentityServicePeerBinding } from "../identity-service/contracts.js";

export const peerAttestation = z
  .object({
    sessionId: z.string().min(1).max(256).nullable(),
    launchId: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type PeerAttestation = z.infer<typeof peerAttestation>;
export interface IncomingPeerGrant {
  id: string;
  serverId: string;
  tokenHash: string;
  generation?: number;
  allProjects?: true;
  projects: readonly string[];
  operations: readonly Operation[];
  expiresAt: number;
  identityBinding?: IdentityServicePeerBinding;
  access?: readonly { tokenHash: string; expiresAt: number }[];
}
export interface PeerRequestAuthority {
  grant: IncomingPeerGrant;
  projects: readonly string[];
  operations: readonly Operation[];
  expiresAt: number;
  assertActive(): void;
}
export const hashPeerToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** No idle work. Each admitted request owns its deadline and cancellation. */
export class PeerDirectory {
  private readonly incoming = new Map<string, IncomingPeerGrant>();
  private readonly active = new Map<string, Set<AbortController>>();
  private activeCount = 0;

  constructor(grants: readonly IncomingPeerGrant[] = []) {
    for (const grant of grants) this.put(grant);
  }
  put(grant: IncomingPeerGrant) {
    if (!this.incoming.has(grant.id) && this.incoming.size >= 64)
      throw new CoreApiError("command_capacity", "Peer capacity reached", 503);
    this.revoke(grant.id);
    this.incoming.set(grant.id, {
      ...grant,
      projects: [...grant.projects],
      operations: [...grant.operations],
    });
  }
  updateAuthentication(
    id: string,
    expiresAt: number,
    access: IncomingPeerGrant["access"],
  ) {
    const grant = this.incoming.get(id);
    if (grant) {
      grant.expiresAt = expiresAt;
      grant.access = access;
    }
  }
  revoke(id: string) {
    this.incoming.delete(id);
    for (const controller of this.active.get(id) ?? []) controller.abort();
  }
  lookup(token: string) {
    const hash = hashPeerToken(token);
    return [...this.incoming.values()].find((g) =>
      g.access
        ? g.access.some((t) => t.tokenHash === hash && t.expiresAt > Date.now())
        : g.tokenHash === hash,
    );
  }
  authenticate(
    token: string,
    attestation: PeerAttestation,
    authority?: PeerRequestAuthority,
  ) {
    const hash = hashPeerToken(token);
    const grant = [...this.incoming.values()].find((g) =>
      g.access
        ? g.access.some((t) => t.tokenHash === hash && t.expiresAt > Date.now())
        : g.tokenHash === hash,
    );
    if (
      !grant ||
      !Number.isFinite(grant.expiresAt) ||
      grant.expiresAt <= Date.now()
    )
      throw new CoreApiError(
        "unauthorized",
        "Peer credential is not active",
        401,
      );
    if (grant.identityBinding && (!authority || authority.grant !== grant))
      throw new CoreApiError(
        "unauthorized",
        "Fleet peer authority is required for this credential",
        401,
      );
    const expiresAt = Math.min(
      grant.access?.find((t) => t.tokenHash === hash)?.expiresAt ??
        grant.expiresAt,
      grant.expiresAt,
      authority?.expiresAt ?? grant.expiresAt,
    );
    authority?.assertActive();
    if (expiresAt <= Date.now())
      throw new CoreApiError("unauthorized", "Peer authority expired", 401);
    if (this.activeCount >= 128)
      throw new CoreApiError(
        "command_capacity",
        "Peer request capacity reached",
        503,
      );
    const controller = new AbortController();
    const deadline = setTimeout(
      () =>
        controller.abort(
          new CoreApiError(
            "controller_unavailable",
            "Peer request deadline reached",
            503,
          ),
        ),
      Math.max(0, Math.min(12_000, expiresAt - Date.now())),
    );
    deadline.unref?.();
    let active = this.active.get(grant.id);
    if (!active) {
      active = new Set();
      this.active.set(grant.id, active);
    }
    active.add(controller);
    this.activeCount++;
    const principal: PeerPrincipal = {
      kind: "peer",
      serverId: grant.serverId,
      credentialId: grant.id,
      credentialGeneration: grant.generation,
      ...(!grant.identityBinding && grant.allProjects
        ? { allProjects: true as const }
        : {}),
      projects: authority
        ? grant.projects.filter((id) => authority.projects.includes(id))
        : grant.projects,
      operations: authority
        ? grant.operations.filter((op) => authority.operations.includes(op))
        : grant.operations,
      sourceSessionId: attestation.sessionId,
      sourceLaunchId: attestation.launchId,
      signal: controller.signal,
      assertActive: () => {
        if (this.incoming.get(grant.id) !== grant || expiresAt <= Date.now())
          throw new CoreApiError(
            "unauthorized",
            "Peer credential is not active",
            401,
          );
        authority?.assertActive();
        if (controller.signal.aborted)
          throw controller.signal.reason instanceof CoreApiError
            ? controller.signal.reason
            : new CoreApiError(
                "controller_unavailable",
                "Peer request was cancelled",
                503,
              );
      },
    };
    let released = false;
    return {
      principal,
      release: () => {
        if (released) return;
        released = true;
        clearTimeout(deadline);
        active!.delete(controller);
        this.activeCount--;
        if (!active!.size) this.active.delete(grant.id);
      },
    };
  }
  close() {
    for (const id of this.incoming.keys()) this.revoke(id);
  }
}

/** Development enrollment only: callers own the out-of-band secret exchange. */
export function fixturePeerGrant(
  serverId: string,
  token: string,
  projects: string[],
  operations: Operation[],
): IncomingPeerGrant {
  if (token.length < 32)
    throw new Error("Fixture peer token must be at least 32 characters");
  return {
    id: randomUUID(),
    serverId,
    tokenHash: hashPeerToken(token),
    projects,
    operations,
    expiresAt: Date.now() + 60 * 60_000,
  };
}
