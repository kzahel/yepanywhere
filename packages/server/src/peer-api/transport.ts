import {
  PEER_ENVELOPE_VERSION,
  RECEIPT_HEADER,
  type ApiHttpReply,
} from "../core-api/http-contracts.js";
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

export function peerOperationRequest(
  operation: Operation,
  input: PeerInput,
  attestation: PeerAttestation,
  token: string,
) {
  if (input.http)
    return {
      method: input.http.method,
      path: input.http.path,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": input.http.contentType ?? "application/json",
        "X-YA-Peer-Envelope": PEER_ENVELOPE_VERSION,
        "X-YA-Peer-Context": Buffer.from(JSON.stringify(attestation)).toString(
          "base64url",
        ),
        ...(input.http.key ? { "Idempotency-Key": input.http.key } : {}),
      },
      ...(input.http.body !== undefined ? { body: input.http.body } : {}),
    };
  const descriptor = operations.find((op) => op.id === operation)!;
  if (!descriptor.path.includes(":serverId"))
    throw new CoreApiError(
      "peer_unsupported",
      "Only server-addressed resources can be forwarded",
      501,
    );
  const path = descriptor.path
    .replace(":serverId", encodeURIComponent(input.serverId ?? ""))
    .replace(":sessionId", encodeURIComponent(input.sessionId ?? ""))
    .replace(":receiptId", encodeURIComponent(input.receiptId ?? ""))
    .replace(":requestId", encodeURIComponent(input.pendingRequestId ?? ""));
  const url = new URL(`/v0${path}`, "http://peer.internal");
  for (const [key, value] of Object.entries(input.query ?? {}))
    if (value !== undefined) url.searchParams.set(key, value);
  return {
    method: operationMethod(descriptor),
    path: `${url.pathname}${url.search}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json" as const,
      "X-YA-Peer-Envelope": PEER_ENVELOPE_VERSION,
      ...((input.body as { requestId?: string })?.requestId
        ? { "Idempotency-Key": (input.body as { requestId: string }).requestId }
        : {}),
      "X-YA-Peer-Context": Buffer.from(JSON.stringify(attestation)).toString(
        "base64url",
      ),
    },
    ...(operationMethod(descriptor) === "POST"
      ? {
          body: JSON.stringify(
            input.body && typeof input.body === "object"
              ? Object.fromEntries(
                  Object.entries(input.body).filter(
                    ([key]) => key !== "requestId",
                  ),
                )
              : input.body,
          ),
        }
      : {}),
  };
}

export function validatePeerReply(
  _operation: Operation,
  serverId: string,
  status: number,
  headers: Headers,
  value: unknown,
  opaque = false,
) {
  if (headers.get("X-YA-Server-ID") !== serverId)
    throw new CoreApiError(
      "peer_identity_mismatch",
      "Peer response identity does not match",
      502,
    );
  if (opaque)
    return {
      status,
      headers: Object.fromEntries(
        [...headers].filter(([name]) =>
          [
            "content-type",
            "x-ya-server-id",
            RECEIPT_HEADER.toLowerCase(),
          ].includes(name.toLowerCase()),
        ),
      ),
      body: typeof value === "string" ? value : JSON.stringify(value),
    } satisfies ApiHttpReply;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      /* Markdown help. */
    }
  }
  if (status < 200 || status >= 300) {
    const error =
      value && typeof value === "object"
        ? (value as { error?: object }).error
        : undefined;
    throw (
      CoreApiError.restore({ ...error, status }) ??
      new CoreApiError("peer_unsupported", "Target rejected operation", 501)
    );
  }
  return value;
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
      const request = peerOperationRequest(
        operation,
        { ...input, serverId: this.serverId },
        attestation,
        this.token,
      );
      const response = await this.fetcher(new URL(request.path, this.origin), {
        method: request.method,
        signal,
        redirect: "error",
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
      });
      if (response.headers.get("X-YA-Server-ID") !== this.serverId) {
        await response.body?.cancel();
        throw new CoreApiError(
          "peer_identity_mismatch",
          "Peer response identity does not match",
          502,
        );
      }
      const value = await this.response(response);
      return validatePeerReply(
        operation,
        this.serverId,
        response.status,
        response.headers,
        value,
        Boolean(input.http),
      );
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
