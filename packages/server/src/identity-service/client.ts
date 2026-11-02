import * as oauth from "oauth4webapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { IdentityServiceCredentials } from "./auth.js";
import {
  clientIntroductionSchema,
  identityServiceCredentialsSchema,
  type ProfileKeys,
} from "./contracts.js";
import {
  identityServiceOrigin,
  importIdentityServiceKey,
  publicIdentityServiceKey,
} from "./crypto.js";
import { IdentityServiceError } from "./errors.js";
import { identityServiceWait } from "./limits.js";

export { identityServiceCredentialsSchema } from "./contracts.js";
export const oidcPendingSchema = z
  .object({
    flowId: z.uuid(),
    authorizationUrl: z.string().url().max(8192),
    token: z.string().max(32768),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type IdentityServiceOidcPending = z.infer<typeof oidcPendingSchema>;

/** One bounded serial HTTP lane; only an explicit pre-admission nonce is retried. */
export class IdentityServiceClient {
  private handle?: Promise<oauth.DPoPHandle>;
  private handleSkew = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private credentials?: IdentityServiceCredentials;
  private epoch = 0;
  private lifecycle = new AbortController();
  private disconnecting?: Promise<void>;
  private closed = false;
  constructor(
    readonly issuer: string,
    readonly profileId: string,
    readonly keys: ProfileKeys,
    private readonly options: {
      allowInsecureLoopback?: boolean;
      fetch?: typeof fetch;
      now?: () => number;
      publish?: (
        credentials: IdentityServiceCredentials,
        assertOwner?: () => void,
      ) => Promise<void>;
      remove?: () => Promise<void>;
      discard?: (credentials: IdentityServiceCredentials) => Promise<void>;
    } = {},
  ) {
    this.issuer = identityServiceOrigin(issuer, options.allowInsecureLoopback);
    if (options.publish && !options.remove)
      throw new IdentityServiceError(
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
      importIdentityServiceKey(this.keys.signing),
      importIdentityServiceKey(publicIdentityServiceKey(this.keys.signing)),
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
    if (this.closed)
      return Promise.reject(
        new IdentityServiceError("unauthorized", "Fleet client is closed", 401),
      );
    if (this.disconnecting)
      return Promise.reject(
        new IdentityServiceError(
          "unauthorized",
          "Fleet client is disconnecting",
          401,
        ),
      );
    if (this.waiting >= 9)
      return Promise.reject(
        new IdentityServiceError("capacity", "Fleet client queue is full", 503),
      );
    const epoch = this.epoch;
    this.waiting++;
    const pending = this.tail.then(() => {
      signal.throwIfAborted();
      if (epoch !== this.epoch)
        throw new IdentityServiceError(
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
    return identityServiceWait(pending, signal);
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
      throw new IdentityServiceError(
        "bad_response",
        "Fleet service returned an empty reply",
        502,
      );
    try {
      for (;;) {
        const { value, done } = await identityServiceWait(
          reader.read(),
          signal,
        );
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 256 * 1024)
          throw new IdentityServiceError(
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
      throw new IdentityServiceError(
        "bad_response",
        "Fleet service returned invalid JSON",
        502,
      );
    }
    if (!response.ok) {
      const error = z
        .object({ error: z.string(), message: z.string() })
        .safeParse(result);
      throw new IdentityServiceError(
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
    assertOwner?: () => void,
  ): Promise<unknown> {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("..") ||
      path.includes("#")
    )
      throw new IdentityServiceError(
        "invalid_request",
        "Use a fleet resource path",
      );
    const url = new URL(`${this.issuer}/fleet/v0${path}`),
      handle = await this.dpop();
    const send = () => {
      return oauth.protectedResourceRequest(
        token,
        method,
        url,
        new Headers({ "Content-Type": "application/json" }),
        body === undefined ? undefined : JSON.stringify(body),
        {
          DPoP: handle,
          [oauth.allowInsecureRequests]: this.options.allowInsecureLoopback,
          [oauth.customFetch]: (input, init) => {
            // The maintained helper awaits DPoP signing before invoking fetch.
            // Admission belongs here, after that await, on every actual send.
            signal.throwIfAborted();
            assertOwner?.();
            return (this.options.fetch ?? fetch)(input, {
              ...init,
              body: typeof init.body === "string" ? init.body : undefined,
              signal,
              redirect: "error",
            });
          },
        },
      );
    };
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
  private async publish(
    credentials: IdentityServiceCredentials,
    epoch: number,
    assertOwner?: () => void,
  ) {
    try {
      assertOwner?.();
      if (epoch !== this.epoch)
        throw new IdentityServiceError(
          "unauthorized",
          "Fleet client was disconnected",
          401,
        );
      await this.options.publish?.(credentials, assertOwner);
      assertOwner?.();
      if (epoch !== this.epoch)
        throw new IdentityServiceError(
          "unauthorized",
          "Fleet client was disconnected",
          401,
        );
      this.credentials = credentials;
    } catch (error) {
      if (assertOwner) {
        this.credentials = undefined;
        await this.options.discard?.(credentials);
      }
      throw error;
    }
  }

  restore(credentials: IdentityServiceCredentials) {
    const valid = identityServiceCredentialsSchema.parse(credentials);
    if (
      valid.client.profileId !== this.profileId ||
      JSON.stringify(valid.client.signingKey) !==
        JSON.stringify(publicIdentityServiceKey(this.keys.signing)) ||
      JSON.stringify(valid.client.encryptionKey) !==
        JSON.stringify(publicIdentityServiceKey(this.keys.encryption))
    )
      throw new IdentityServiceError(
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
        signingKey: publicIdentityServiceKey(this.keys.signing),
        encryptionKey: publicIdentityServiceKey(this.keys.encryption),
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
      const credentials = identityServiceCredentialsSchema.parse(
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
      const credentials = identityServiceCredentialsSchema.parse(
        await this.protected(token, "/enroll", "POST", undefined, signal),
      );
      signal.throwIfAborted();
      await this.publish(credentials, epoch);
      return credentials.client;
    });
  }
  startOidc(
    input: {
      providerId: string;
      accountId: string;
      ownerBinding: string;
      enrollmentEpoch: number;
      displayName: string;
    },
    caller?: AbortSignal,
  ) {
    const signal = this.signal(caller);
    return this.serialize(signal, async () => {
      const introduction = {
        profileId: this.profileId,
        displayName: input.displayName,
        signingKey: publicIdentityServiceKey(this.keys.signing),
        encryptionKey: publicIdentityServiceKey(this.keys.encryption),
      };
      const { displayName: _, ...binding } = input;
      const response = await (this.options.fetch ?? fetch)(
        `${this.issuer}/fleet/v0/oidc/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...binding, introduction }),
          signal,
          redirect: "error",
        },
      );
      return oidcPendingSchema.parse(await this.json(response, signal));
    });
  }
  oidcProviders(caller?: AbortSignal) {
    const signal = this.signal(caller);
    return this.serialize(signal, async () =>
      this.json(
        await (this.options.fetch ?? fetch)(
          `${this.issuer}/fleet/v0/oidc/providers`,
          { signal, redirect: "error" },
        ),
        signal,
      ),
    );
  }
  oidcStatus(flow: IdentityServiceOidcPending, caller?: AbortSignal) {
    const signal = this.signal(caller);
    return this.serialize(signal, () =>
      this.protected(
        flow.token,
        `/oidc/flows/${flow.flowId}`,
        "GET",
        undefined,
        signal,
      ),
    );
  }
  completeOidc(
    flow: IdentityServiceOidcPending,
    ownerBinding: string,
    enrollmentEpoch: number,
    confirmationCode: string | undefined,
    assertOwner: () => void,
    caller?: AbortSignal,
  ) {
    const signal = this.signal(caller),
      epoch = this.epoch;
    return this.serialize(signal, async () => {
      assertOwner();
      if (this.options.publish && !this.options.discard)
        throw new IdentityServiceError(
          "invalid_configuration",
          "OIDC publication requires conditional local credential discard",
        );
      let submitted = false;
      try {
        const pending = z
          .object({ token: z.string().max(32768), expiresAt: z.number() })
          .strict()
          .parse(
            await this.protected(
              flow.token,
              `/oidc/flows/${flow.flowId}/redeem`,
              "POST",
              { ownerBinding, enrollmentEpoch, confirmationCode },
              signal,
              assertOwner,
            ),
          );
        const admit = () => {
          assertOwner();
          signal.throwIfAborted();
          submitted = true;
        };
        const credentials = identityServiceCredentialsSchema.parse(
          await this.protected(
            pending.token,
            "/enroll",
            "POST",
            undefined,
            signal,
            admit,
          ),
        );
        assertOwner();
        signal.throwIfAborted();
        await this.publish(credentials, epoch, assertOwner);
        return credentials.client;
      } catch (error) {
        if (
          submitted &&
          error instanceof IdentityServiceError &&
          error.code === "owner_session_changed"
        )
          throw new IdentityServiceError(
            "owner_session_changed_remote_unconfirmed",
            "Owner authorization changed; local adoption was refused and remote enrollment may have committed",
            403,
          );
        throw error;
      }
    });
  }

  private async ready(signal: AbortSignal) {
    const credentials = this.credentials;
    if (!credentials || credentials.familyExpiresAt <= this.now())
      throw new IdentityServiceError(
        "login_required",
        "Fleet login is required",
        401,
      );
    if (credentials.expiresAt > this.now() + 15_000) return credentials;
    const epoch = this.epoch;
    // Retire the consumed capability even if publication or the response fails.
    this.credentials = undefined;
    const refreshed = identityServiceCredentialsSchema.parse(
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
  async close() {
    this.closed = true;
    this.epoch++;
    this.lifecycle.abort();
    this.credentials = undefined;
    await this.tail;
  }
}
