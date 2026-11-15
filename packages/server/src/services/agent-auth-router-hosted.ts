import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type {
  RouterConnection,
  RouterInfo,
  RouterPairing,
} from "./agent-auth-router-connection.js";
import {
  hostedRouterOrigin,
  RouterUnavailable,
  routerRequest,
} from "./agent-auth-router-control.js";
import { runOutsideRequestContext } from "../lib/outsideRequestContext.js";

type HostedConnection = Extract<RouterConnection, { kind: "hosted" }>;
export const defaultRouterPairingName = () => `Yep Anywhere on ${hostname()}`;

export class HostedRouterPairing {
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(
    private readonly owner: {
      get: () => RouterConnection | undefined;
      save: (connection: RouterConnection) => Promise<void>;
      info: (connection: RouterConnection) => Promise<RouterInfo>;
      observe: () => Promise<unknown>;
    },
  ) {
    this.schedule();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
  private schedule() {
    clearTimeout(this.timer);
    const c = this.owner.get();
    // One installation-owned deadline timer; no account/session polling.
    if (
      this.closed ||
      c?.kind !== "hosted" ||
      !(
        c.state === "pairing" ||
        (c.state === "revocation-pending" && c.pendingApproval)
      ) ||
      c.expired
    )
      return;
    this.timer = runOutsideRequestContext(() =>
      setTimeout(
        () => {
          void this.owner
            .observe()
            .catch(() => {})
            .finally(() => this.schedule());
        },
        (c.pairing?.interval ?? 5) * 1000,
      ),
    );
    this.timer.unref();
  }
  async connect(url: string, name: string) {
    const origin = hostedRouterOrigin(url);
    const label = name.trim();
    if (
      !label ||
      label.length > 120 ||
      [...label].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new RouterUnavailable(
        400,
        "Enter a name of 1–120 characters",
        "operation-rejected",
      );
    let previous = this.owner.get();
    if (previous && previous.state !== "disconnected") {
      if (
        previous.kind !== "hosted" ||
        previous.origin !== origin ||
        previous.state === "revocation-pending"
      )
        throw new RouterUnavailable(
          409,
          "Disconnect the current router before pairing another one",
        );
      if (previous.expired) {
        await this.check();
        previous = this.owner.get();
      }
      if (previous?.state !== "disconnected") {
        if (previous?.state === "connected") return;
        if (previous?.kind === "hosted") return this.prepare(previous);
      }
    }
    const connection: HostedConnection = {
      kind: "hosted",
      origin,
      name: label,
      id: randomUUID(),
      token: `aar_ctl_${randomBytes(32).toString("base64url")}`,
      routerId: "",
      state: "pairing",
      startedAt: Date.now(),
      pendingApproval: true,
    };
    const info = await this.owner.info(connection);
    connection.routerId = info.routerId;
    // Persist the identity before sending its hash: a lost reply reuses it.
    await this.owner.save(connection);
    try {
      await this.prepare(connection);
    } finally {
      this.schedule();
    }
  }
  private async prepare(c: HostedConnection) {
    await this.owner.info(c);
    const result = await routerRequest<Record<string, unknown>>(
      { origin: c.origin },
      "/v1/pair",
      undefined,
      {
        id: c.id,
        name: c.name,
        tokenHash: createHash("sha256").update(c.token).digest("hex"),
      },
    );
    if (result.state === "active") {
      await this.owner.save({
        ...c,
        state: "connected",
        pairing: undefined,
        pendingApproval: undefined,
        expired: undefined,
        pairingIssue: undefined,
      });
      return;
    }
    let verification: URL;
    try {
      verification = new URL(String(result.verificationUri));
    } catch {
      throw new RouterUnavailable(
        502,
        "Invalid router pairing response",
        "protocol-mismatch",
      );
    }
    const expiry = Date.parse(String(result.expiresAt));
    if (
      result.state !== "pending" ||
      typeof result.userCode !== "string" ||
      !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(result.userCode) ||
      verification.origin !== c.origin ||
      verification.username ||
      verification.password ||
      verification.search ||
      verification.pathname !== "/" ||
      verification.hash !== "#pair" ||
      !Number.isFinite(expiry) ||
      expiry > Date.now() + 15 * 60_000 ||
      expiry <= Date.now() ||
      typeof result.interval !== "number" ||
      !Number.isFinite(result.interval) ||
      result.interval < 1 ||
      result.interval > 60
    )
      throw new RouterUnavailable(
        502,
        "Invalid router pairing response",
        "protocol-mismatch",
      );
    const pairing: RouterPairing = {
      userCode: result.userCode,
      verificationUri: verification.href,
      expiresAt: new Date(expiry).toISOString(),
      interval: result.interval,
    };
    await this.owner.save({
      ...c,
      pairing,
      expired: undefined,
      pairingIssue: undefined,
    });
    this.schedule();
  }
  async check() {
    const c = this.owner.get();
    if (
      c?.kind !== "hosted" ||
      !["pairing", "revocation-pending"].includes(c.state)
    )
      return;
    try {
      await this.owner.info(c);
      if (!c.pairing && c.state === "pairing") return await this.prepare(c);
      const result = await routerRequest<{ state: string; routerId?: string }>(
        { origin: c.origin },
        "/v1/pair/status",
        c.token,
      );
      if (
        result.state !== "active" ||
        (result.routerId && result.routerId !== c.routerId)
      )
        throw new RouterUnavailable(
          409,
          "Router pairing identity changed",
          "identity-mismatch",
        );
      if (c.state === "revocation-pending") {
        await routerRequest(
          { origin: c.origin },
          "/v1/disconnect",
          c.token,
          {},
        );
        await this.owner.save({
          ...c,
          state: "disconnected",
          pairing: undefined,
          pendingApproval: undefined,
          expired: undefined,
          pairingIssue: undefined,
        });
      } else
        await this.owner.save({
          ...c,
          state: "connected",
          pairing: undefined,
          pendingApproval: undefined,
          expired: undefined,
          pairingIssue: undefined,
        });
    } catch (error) {
      if (error instanceof RouterUnavailable && error.status === 401) {
        await this.owner.save({
          ...c,
          state: "disconnected",
          expired: c.pendingApproval === true,
          pendingApproval: undefined,
          pairingIssue: undefined,
        });
      } else if (
        error instanceof RouterUnavailable &&
        error.code === "pairing-pending"
      ) {
        if (c.pairing && Date.parse(c.pairing.expiresAt) <= Date.now())
          await this.owner.save({
            ...c,
            expired: true,
            pairingIssue: undefined,
          });
        else if (c.pairingIssue)
          await this.owner.save({ ...c, pairingIssue: undefined });
      } else {
        const expired =
          Date.now() >=
          (c.pairing
            ? Date.parse(c.pairing.expiresAt)
            : (c.startedAt ?? 0) + 10 * 60_000);
        await this.owner.save({
          ...c,
          expired: expired || c.expired,
          pairingIssue:
            error instanceof RouterUnavailable
              ? { code: error.code, message: error.message }
              : {
                  code: "unavailable",
                  message:
                    "Can't reach the router. Retry in Settings → Providers.",
                },
        });
        throw error;
      }
    } finally {
      this.schedule();
    }
  }
  async cancel() {
    const c = this.owner.get();
    if (c?.kind !== "hosted" || c.state === "disconnected") return;
    await this.owner.save({ ...c, state: "revocation-pending" });
    try {
      await this.check();
    } finally {
      this.schedule();
    }
  }
}
