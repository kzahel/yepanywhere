import { randomBytes, randomUUID, randomInt } from "node:crypto";
import { CoreApiError } from "../core-api/errors.js";
import { hashPeerToken } from "./directory.js";
import { awaitPeerWork } from "./srp-protocol.js";
import type { SrpPeerTransport } from "./srp-client.js";
import {
  PEER_AUTHENTICATION,
  PEER_ACCESS_MS,
  PEER_IDLE_MS,
  type PeerRefreshReceipt,
} from "./authentication-contracts.js";
import {
  outgoingPeerPolicy,
  uiPairingOperation,
  type PeerAccessStore,
  type StoredOutgoingPeer,
} from "./state.js";

/** Profile-owned authentication: one timer, two jobs, no provider/session scans. */
export class PeerAuthentication {
  private readonly jobs = new Map<
    string,
    {
      peer: StoredOutgoingPeer;
      controller: AbortController;
      promise: Promise<string>;
    }
  >();
  private readonly cooldowns = new Map<
    string,
    {
      key: string;
      retryAt: number;
      failures: number;
      status: "unavailable" | "sign-in-required" | "update-required";
    }
  >();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly store: PeerAccessStore,
    private readonly enabled: () => boolean,
    private readonly transport: (peer: StoredOutgoingPeer) => SrpPeerTransport,
    private readonly now = Date.now,
    private readonly timeout = () => AbortSignal.timeout(30_000),
  ) {}
  private key(peer: StoredOutgoingPeer) {
    const policy = outgoingPeerPolicy(peer);
    if (uiPairingOperation(this.store.read(), peer))
      policy.invitation.expiresAt = 0;
    return JSON.stringify(policy);
  }
  private current(peer: StoredOutgoingPeer) {
    const current = this.store
      .read()
      .outgoing.find(
        (p) => p.invitation.credentialId === peer.invitation.credentialId,
      );
    if (
      this.closed ||
      !this.enabled() ||
      !current ||
      this.store.read().selected[current.invitation.targetServerId] !==
        current.invitation.credentialId ||
      this.key(current) !== this.key(peer)
    )
      throw new CoreApiError(
        "unauthorized",
        "Server connection changed during authentication",
        401,
      );
    return current;
  }
  eligible(peer: StoredOutgoingPeer) {
    return (
      peer.origin === "manual" &&
      (!!peer.invitation.authentication ||
        !!uiPairingOperation(this.store.read(), peer))
    );
  }
  token(peer: StoredOutgoingPeer, signal?: AbortSignal): Promise<string> {
    const current = this.current(peer),
      auth = current.authentication;
    if (!current.invitation.authentication && !auth?.pending)
      return Promise.resolve(current.invitation.secret);
    if (auth?.current && auth.current.expiresAt > this.now() + 10_000)
      return Promise.resolve(auth.current.token);
    const work = this.refresh(current);
    return signal ? awaitPeerWork(work, signal) : work;
  }
  refresh(peer: StoredOutgoingPeer): Promise<string> {
    const id = peer.invitation.credentialId,
      existing = this.jobs.get(id);
    if (existing) return existing.promise;
    const auth = this.current(peer).authentication;
    const cooldown = this.cooldowns.get(id);
    if (
      auth?.status === "sign-in-required" ||
      cooldown?.status === "sign-in-required"
    )
      return Promise.reject(
        new CoreApiError("unauthorized", "Sign in again to this server", 401),
      );
    if (
      auth?.status === "update-required" ||
      cooldown?.status === "update-required"
    )
      return Promise.reject(
        new CoreApiError(
          "peer_unsupported",
          "Update both servers to enable automatic sign-in",
          501,
        ),
      );
    if (Math.max(auth?.retryAt ?? 0, cooldown?.retryAt ?? 0) > this.now())
      return Promise.reject(
        new CoreApiError(
          "peer_unavailable",
          "Server authentication is temporarily unavailable; automatic retry is scheduled",
          503,
        ),
      );
    if (this.jobs.size >= 2)
      return Promise.reject(
        new CoreApiError(
          "command_capacity",
          "Server authentication capacity reached",
          503,
        ),
      );
    const controller = new AbortController();
    const promise = this.run(
      peer,
      AbortSignal.any([controller.signal, this.timeout()]),
    );
    this.jobs.set(id, { peer, controller, promise });
    void promise
      .catch(() => {})
      .finally(() => {
        this.jobs.delete(id);
        this.changed();
      });
    return promise;
  }
  private async run(
    peer: StoredOutgoingPeer,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let current = this.current(peer);
        if (
          current.authentication?.pending &&
          this.now() >
            Math.max(
              current.invitation.expiresAt,
              current.authentication.pending.createdAt,
            ) +
              PEER_IDLE_MS +
              60_000
        )
          throw new CoreApiError(
            "unauthorized",
            "Sign in again after prolonged inactivity",
            401,
          );
        if (
          current.invitation.expiresAt <= this.now() &&
          !current.authentication?.pending
        )
          throw new CoreApiError(
            "unauthorized",
            "Sign in again after prolonged inactivity",
            401,
          );
        if (
          !current.invitation.authentication &&
          !current.authentication?.pending
        ) {
          const capabilities = (await this.transport(current).request(
            "capabilities",
            { serverId: current.invitation.targetServerId, signal },
            { sessionId: null, launchId: null },
          )) as { peerAuthentication?: string };
          if (capabilities.peerAuthentication !== PEER_AUTHENTICATION)
            throw new CoreApiError(
              "peer_unsupported",
              "Update the other server to enable automatic sign-in",
              501,
            );
        }
        if (!this.eligible(current))
          throw new CoreApiError(
            "forbidden",
            "This grant requires owner renewal",
            403,
          );
        if (!current.authentication?.pending) {
          const token = randomBytes(32).toString("base64url");
          const pending = {
            requestId: randomUUID(),
            createdAt: this.now(),
            sequence: (current.authentication?.current?.sequence ?? 0) + 1,
            tokenHash: hashPeerToken(token),
            token,
            ...(!current.invitation.authentication
              ? {
                  migrationOperationId: uiPairingOperation(
                    this.store.read(),
                    current,
                  ),
                }
              : {}),
          };
          await this.store.publishPeerAuthentication((next) => {
            this.current(peer);
            signal.throwIfAborted();
            const record = next.outgoing.find(
              (p) => p.invitation.credentialId === peer.invitation.credentialId,
            )!;
            record.authentication = { ...record.authentication, pending };
          });
          current = this.current(peer);
        }
        const pending = current.authentication!.pending!;
        const { token, createdAt: _createdAt, ...request } = pending;
        const receipt: PeerRefreshReceipt = await this.transport(
          current,
        ).refresh(request, signal);
        if (
          receipt.requestId !== pending.requestId ||
          receipt.sequence !== pending.sequence ||
          receipt.tokenHash !== pending.tokenHash ||
          receipt.migrationOperationId !== pending.migrationOperationId ||
          receipt.expiresAt > this.now() + PEER_ACCESS_MS + 60_000 ||
          receipt.idleExpiresAt > this.now() + PEER_IDLE_MS + 60_000 ||
          receipt.refreshAt >= receipt.expiresAt ||
          receipt.expiresAt > receipt.idleExpiresAt
        )
          throw new CoreApiError(
            "peer_identity_mismatch",
            "Invalid server authentication receipt",
            502,
          );
        await this.store.publishPeerAuthentication((next) => {
          this.current(peer);
          signal.throwIfAborted();
          const record = next.outgoing.find(
            (p) => p.invitation.credentialId === peer.invitation.credentialId,
          )!;
          if (record.authentication?.pending?.requestId !== pending.requestId)
            throw new CoreApiError(
              "peer_record_conflict",
              "Pending authentication changed",
              409,
            );
          record.invitation.authentication = PEER_AUTHENTICATION;
          record.invitation.expiresAt = receipt.idleExpiresAt;
          record.authentication = {
            current: {
              requestId: receipt.requestId,
              sequence: receipt.sequence,
              token,
              tokenHash: receipt.tokenHash,
              expiresAt: receipt.expiresAt,
              refreshAt: receipt.refreshAt,
            },
            status: "ready",
            lastRefreshedAt: receipt.expiresAt - PEER_ACCESS_MS,
          };
        });
        // A replay can recover an old receipt after its access token expired. Commit
        // that sequence first, then mint once more. Never replay the native operation.
        this.cooldowns.delete(peer.invitation.credentialId);
        if (receipt.expiresAt > this.now() + 10_000) return token;
      }
      throw new CoreApiError(
        "peer_unavailable",
        "Authentication recovery did not produce a usable credential",
        503,
      );
    } catch (error) {
      try {
        const current = this.current(peer),
          id = peer.invitation.credentialId;
        const status =
          error instanceof CoreApiError && error.status === 501
            ? "update-required"
            : error instanceof CoreApiError &&
                [401, 403, 409].includes(error.status)
              ? "sign-in-required"
              : "unavailable";
        const failures = Math.min(
          16,
          Math.max(
            current.authentication?.failures ?? 0,
            this.cooldowns.get(id)?.failures ?? 0,
          ) + 1,
        );
        const retryAt =
          this.now() +
          Math.max(
            60_000,
            Math.min(
              6 * 60 * 60_000,
              Math.round(
                60_000 *
                  2 ** (failures - 1) *
                  (0.8 + randomInt(0, 4001) / 10_000),
              ),
            ),
          );
        // Publication itself can be busy. Retain a bounded profile-owned floor
        // even when the durable writer cannot accept the failure record.
        this.cooldowns.set(id, {
          key: this.key(current),
          status,
          failures,
          retryAt,
        });
        await this.store.publishPeerAuthentication((next) => {
          this.current(peer);
          const record = next.outgoing.find(
            (p) => p.invitation.credentialId === id,
          )!;
          record.authentication = {
            ...record.authentication,
            status,
            failures,
            retryAt,
          };
        });
      } catch {}
      throw error;
    }
  }
  status(peer: StoredOutgoingPeer) {
    const durable = this.current(peer).authentication?.status,
      memory = this.cooldowns.get(peer.invitation.credentialId)?.status;
    return [durable, memory].includes("sign-in-required")
      ? "sign-in-required"
      : [durable, memory].includes("update-required")
        ? "update-required"
        : (memory ?? durable);
  }
  async retry(
    peer: StoredOutgoingPeer,
    guard: () => void,
    signal: AbortSignal,
  ) {
    guard();
    signal.throwIfAborted();
    this.current(peer);
    if (this.status(peer) === "sign-in-required")
      throw new CoreApiError(
        "unauthorized",
        "Sign in again to this server",
        401,
      );
    await this.store.publishPeerAuthentication((next) => {
      guard();
      signal.throwIfAborted();
      this.current(peer);
      if (this.status(peer) === "sign-in-required")
        throw new CoreApiError(
          "unauthorized",
          "Sign in again to this server",
          401,
        );
      const record = next.outgoing.find(
        (p) => p.invitation.credentialId === peer.invitation.credentialId,
      )!;
      const {
        status: _status,
        retryAt: _retryAt,
        failures: _failures,
        ...rest
      } = record.authentication ?? {};
      record.authentication = rest;
    });
    guard();
    signal.throwIfAborted();
    if (this.status(peer) === "sign-in-required")
      throw new CoreApiError(
        "unauthorized",
        "Sign in again to this server",
        401,
      );
    this.cooldowns.delete(peer.invitation.credentialId);
    return awaitPeerWork(this.refresh(this.current(peer)), signal);
  }

  changed() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    for (const [id, job] of this.jobs) {
      try {
        const peer = this.store
          .read()
          .outgoing.find((p) => p.invitation.credentialId === id);
        if (
          !peer ||
          !this.enabled() ||
          this.store.read().selected[peer.invitation.targetServerId] !== id ||
          this.key(peer) !== this.key(job.peer)
        )
          job.controller.abort();
      } catch {
        job.controller.abort();
      }
    }
    for (const [id, cooldown] of this.cooldowns) {
      const peer = this.store
        .read()
        .outgoing.find((p) => p.invitation.credentialId === id);
      if (!peer || this.key(peer) !== cooldown.key) this.cooldowns.delete(id);
    }
    if (this.closed || !this.enabled()) return;
    const peers = this.store
      .read()
      .outgoing.filter(
        (p) =>
          this.store.read().selected[p.invitation.targetServerId] ===
            p.invitation.credentialId &&
          this.eligible(p) &&
          !this.jobs.has(p.invitation.credentialId) &&
          !["sign-in-required", "update-required"].includes(
            p.authentication?.status ?? "",
          ) &&
          !["sign-in-required", "update-required"].includes(
            this.cooldowns.get(p.invitation.credentialId)?.status ?? "",
          ),
      );
    if (!peers.length || this.jobs.size >= 2) return;
    const due = (p: StoredOutgoingPeer) =>
      Math.max(
        this.cooldowns.get(p.invitation.credentialId)?.retryAt ?? 0,
        p.authentication?.retryAt ??
          p.authentication?.current?.refreshAt ??
          this.now(),
      );
    const next = peers.sort((a, b) => due(a) - due(b))[0]!;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.refresh(next).catch(() => {});
        this.changed();
      },
      Math.min(24 * 60 * 60_000, Math.max(25, due(next) - this.now())),
    );
    this.timer.unref?.();
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    return Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
  }
}
