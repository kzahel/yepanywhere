import {
  operations,
  operationMethod,
  type Operation,
} from "../core-api/contracts.js";
import { CoreApiError, type CoreApi } from "../core-api/service.js";
import type { PeerAttestation } from "./directory.js";

export type PeerInput = NonNullable<Parameters<CoreApi["read"]>[2]>;
export interface PeerTransport {
  readonly serverId: string;
  request(
    operation: Operation,
    input: PeerInput,
    attestation: PeerAttestation,
  ): Promise<unknown>;
}

/** No failover or retry. Plain HTTP is allowed only for explicit loopback fixtures. */
export class HttpPeerTransport implements PeerTransport {
  private readonly origin: string;
  constructor(
    readonly serverId: string,
    origin: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    fixtureLoopback = false,
  ) {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          fixtureLoopback &&
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error(
        "Peer transport requires an HTTPS origin (or an explicit loopback fixture)",
      );
    this.origin = url.origin;
  }
  private async response(response: Response) {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024)
            throw new Error("Oversized peer response");
          chunks.push(value);
        }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      await reader?.cancel().catch(() => {});
    }
  }
  async request(
    operation: Operation,
    input: PeerInput,
    attestation: PeerAttestation,
  ) {
    const descriptor = operations.find((op) => op.id === operation)!;
    if (!descriptor.path.includes(":serverId"))
      throw new CoreApiError(
        "peer_unsupported",
        "Only server-addressed resources can be forwarded",
        501,
      );
    const signal = AbortSignal.any([
      AbortSignal.timeout(10_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    try {
      // Reject a wrongly configured target before releasing its peer credential.
      const identity = await this.fetcher(`${this.origin}/peer/id`, {
        signal,
        redirect: "error",
      });
      if (
        !identity.ok ||
        JSON.parse(await this.response(identity)).serverId !== this.serverId
      )
        throw new CoreApiError(
          "peer_identity_mismatch",
          "Configured peer identity does not match",
          502,
        );
      const path = descriptor.path
        .replace(":serverId", encodeURIComponent(this.serverId))
        .replace(":sessionId", encodeURIComponent(input.sessionId ?? ""))
        .replace(":receiptId", encodeURIComponent(input.receiptId ?? ""));
      const url = new URL(`/v0${path}`, this.origin);
      for (const [key, value] of Object.entries(input.query ?? {}))
        if (value !== undefined) url.searchParams.set(key, value);
      const response = await this.fetcher(url, {
        method: operationMethod(descriptor),
        signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "X-YA-Peer-Context": Buffer.from(
            JSON.stringify(attestation),
          ).toString("base64url"),
        },
        ...(operationMethod(descriptor) === "POST"
          ? { body: JSON.stringify(input.body) }
          : {}),
      });
      if (response.headers.get("X-YA-Server-ID") !== this.serverId) {
        await response.body?.cancel();
        throw new CoreApiError(
          "peer_identity_mismatch",
          "Peer response identity does not match",
          502,
        );
      }
      const value = JSON.parse(await this.response(response));
      if (!response.ok) {
        const restored = CoreApiError.restore({
          ...value.error,
          status: response.status,
        });
        if (restored) throw restored;
        throw new CoreApiError(
          "peer_unsupported",
          "Peer does not support this operation",
          501,
        );
      }
      const parsed = descriptor.response.safeParse(value);
      if (!parsed.success)
        throw new CoreApiError(
          "peer_unsupported",
          "Peer response does not match the operation contract",
          501,
        );
      return parsed.data;
    } catch (error) {
      if (error instanceof CoreApiError) throw error;
      throw new CoreApiError(
        "peer_unavailable",
        "Peer request outcome is unavailable; mutations may have been accepted. Retry only with the identical request key.",
        503,
      );
    }
  }
}
