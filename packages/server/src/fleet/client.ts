import * as oauth from "oauth4webapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { FleetCredentials } from "./auth.js";
import {
  clientIntroductionSchema,
  enrolledClientSchema,
  type ProfileKeys,
} from "./contracts.js";
import { fleetOrigin, importFleetKey, publicFleetKey } from "./crypto.js";
import { FleetError } from "./errors.js";
import { fleetWait } from "./limits.js";

export const fleetCredentialsSchema = z
  .object({
    client: enrolledClientSchema,
    accessToken: z.string().max(32768),
    refreshToken: z.string().max(32768),
    expiresAt: z.number(),
    familyExpiresAt: z.number(),
  })
  .strict();

/** One bounded serial HTTP lane; only an explicit pre-admission nonce is retried. */
export class FleetHttpClient {
  private handle?: Promise<oauth.DPoPHandle>;
  private handleSkew = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private credentials?: FleetCredentials;
  private epoch = 0;
  private lifecycle = new AbortController();
  private disconnecting?: Promise<void>;
  constructor(
    readonly issuer: string,
    readonly profileId: string,
    readonly keys: ProfileKeys,
    private readonly options: {
      allowInsecureLoopback?: boolean;
      fetch?: typeof fetch;
      now?: () => number;
      publish?: (credentials: FleetCredentials) => Promise<void>;
      remove?: () => Promise<void>;
    } = {},
  ) {
    this.issuer = fleetOrigin(issuer, options.allowInsecureLoopback);
    if (options.publish && !options.remove)
      throw new FleetError(
        "invalid_configuration",
        "Credential persistence requires durable removal on disconnect",
      );
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private dpop() {
    const now = () => this.now();
    const skew = (now() - Date.now()) / 1000;
    if (Math.abs(skew - this.handleSkew) > 1) {
      this.handle = undefined;
      this.handleSkew = skew;
    }
    this.handle ??= Promise.all([
      importFleetKey(this.keys.signing),
      importFleetKey(publicFleetKey(this.keys.signing)),
    ]).then(([privateKey, publicKey]) =>
      oauth.DPoP(
        {
          get [oauth.clockSkew]() {
            return (now() - Date.now()) / 1000;
          },
        },
        { privateKey, publicKey },
      ),
    );
    return this.handle;
  }
  private serialize<T>(signal: AbortSignal, work: () => Promise<T>) {
    if (this.disconnecting)
      return Promise.reject(
        new FleetError("unauthorized", "Fleet client is disconnecting", 401),
      );
    if (this.waiting >= 9)
      return Promise.reject(
        new FleetError("capacity", "Fleet client queue is full", 503),
      );
    const epoch = this.epoch;
    this.waiting++;
    const pending = this.tail.then(() => {
      signal.throwIfAborted();
      if (epoch !== this.epoch)
        throw new FleetError(
          "unauthorized",
          "Fleet client was disconnected",
          401,
        );
      return work();
    });
    this.tail = pending.catch(() => {});
    void pending
      .finally(() => {
        this.waiting--;
      })
      .catch(() => {});
    return fleetWait(pending, signal);
  }
  private signal(caller?: AbortSignal) {
    return AbortSignal.any([
      this.lifecycle.signal,
      ...(caller ? [caller] : []),
      AbortSignal.timeout(10_000),
    ]);
  }
  private async json(response: Response, signal: AbortSignal) {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (!reader)
      throw new FleetError(
        "bad_response",
        "Fleet service returned an empty reply",
        502,
      );
    try {
      for (;;) {
        const { value, done } = await fleetWait(reader.read(), signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 256 * 1024)
          throw new FleetError(
            "bad_response",
            "Fleet reply exceeds its byte bound",
            502,
          );
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let result: unknown;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new FleetError(
        "bad_response",
        "Fleet service returned invalid JSON",
        502,
      );
    }
    if (!response.ok) {
      const error = z
        .object({ error: z.string(), message: z.string() })
        .safeParse(result);
      throw new FleetError(
        error.success ? error.data.error : "fleet_unavailable",
        error.success ? error.data.message : "Fleet request failed",
        response.status >= 400 && response.status < 600
          ? (response.status as ContentfulStatusCode)
          : 502,
      );
    }
    return result;
  }
  private async protected(
    token: string,
    path: string,
    method: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("..") ||
      path.includes("#")
    )
      throw new FleetError("invalid_request", "Use a fleet resource path");
    const url = new URL(`${this.issuer}/fleet/v0${path}`),
      handle = await this.dpop();
    const send = () =>
      oauth.protectedResourceRequest(
        token,
        method,
        url,
        new Headers({ "Content-Type": "application/json" }),
        body === undefined ? undefined : JSON.stringify(body),
        {
          DPoP: handle,
          [oauth.allowInsecureRequests]: this.options.allowInsecureLoopback,
          [oauth.customFetch]: (input, init) =>
            (this.options.fetch ?? fetch)(input, {
              ...init,
              body: typeof init.body === "string" ? init.body : undefined,
              signal,
              redirect: "error",
            }),
        },
      );
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      if (!oauth.isDPoPNonceError(error)) throw error;
      signal.throwIfAborted();
      response = await send();
    }
    if (response.status === 204) return null;
    return this.json(response, signal);
  }
  private async publish(credentials: FleetCredentials, epoch: number) {
    if (epoch !== this.epoch)
      throw new FleetError(
        "unauthorized",
        "Fleet client was disconnected",
        401,
      );
    await this.options.publish?.(credentials);
    if (epoch !== this.epoch)
      throw new FleetError(
        "unauthorized",
        "Fleet client was disconnected",
        401,
      );
    this.credentials = credentials;
  }
  restore(credentials: FleetCredentials) {
    const valid = fleetCredentialsSchema.parse(credentials);
    if (
      valid.client.profileId !== this.profileId ||
      JSON.stringify(valid.client.signingKey) !==
        JSON.stringify(publicFleetKey(this.keys.signing)) ||
      JSON.stringify(valid.client.encryptionKey) !==
        JSON.stringify(publicFleetKey(this.keys.encryption))
    )
      throw new FleetError(
        "invalid_key",
        "Fleet credentials do not match this profile",
      );
    this.credentials = valid;
  }
  basicLogin(
    username: string,
    password: string,
    displayName: string,
    caller?: AbortSignal,
  ) {
    const signal = this.signal(caller),
      epoch = this.epoch;
    return this.serialize(signal, async () => {
      const introduction = clientIntroductionSchema.parse({
        profileId: this.profileId,
        displayName,
        signingKey: publicFleetKey(this.keys.signing),
        encryptionKey: publicFleetKey(this.keys.encryption),
      });
      const response = await (this.options.fetch ?? fetch)(
        `${this.issuer}/fleet/v0/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password, introduction }),
          signal,
          redirect: "error",
        },
      );
      const pending = z
        .object({ token: z.string().max(32768), expiresAt: z.number() })
        .strict()
        .parse(await this.json(response, signal));
      const credentials = fleetCredentialsSchema.parse(
        await this.protected(
          pending.token,
          "/enroll",
          "POST",
          undefined,
          signal,
        ),
      );
      signal.throwIfAborted();
      await this.publish(credentials, epoch);
      return credentials.client;
    });
  }
  completeEnrollment(token: string, caller?: AbortSignal) {
    const signal = this.signal(caller),
      epoch = this.epoch;
    return this.serialize(signal, async () => {
      const credentials = fleetCredentialsSchema.parse(
        await this.protected(token, "/enroll", "POST", undefined, signal),
      );
      signal.throwIfAborted();
      await this.publish(credentials, epoch);
      return credentials.client;
    });
  }
  private async ready(signal: AbortSignal) {
    const credentials = this.credentials;
    if (!credentials || credentials.familyExpiresAt <= this.now())
      throw new FleetError("login_required", "Fleet login is required", 401);
    if (credentials.expiresAt > this.now() + 15_000) return credentials;
    const epoch = this.epoch;
    // Retire the consumed capability even if publication or the response fails.
    this.credentials = undefined;
    const refreshed = fleetCredentialsSchema.parse(
      await this.protected(
        credentials.refreshToken,
        "/refresh",
        "POST",
        undefined,
        signal,
      ),
    );
    signal.throwIfAborted();
    await this.publish(refreshed, epoch);
    return refreshed;
  }
  request(path: string, method = "GET", body?: unknown, caller?: AbortSignal) {
    const signal = this.signal(caller);
    return this.serialize(signal, async () => {
      const credentials = await this.ready(signal);
      return this.protected(
        credentials.accessToken,
        path,
        method,
        body,
        signal,
      );
    });
  }
  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    this.epoch++;
    this.lifecycle.abort();
    this.credentials = undefined;
    const pending = this.tail.then(async () => {
      await this.options.remove?.();
    });
    this.disconnecting = pending;
    void pending.then(
      () => {
        this.lifecycle = new AbortController();
        this.disconnecting = undefined;
      },
      () => {},
    );
    return pending;
  }
}
