import { lstatSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { RouterEndpoint } from "./agent-auth-router-connection.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentAuthRouterIssueCode } from "@yep-anywhere/shared";

export class RouterUnavailable extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: AgentAuthRouterIssueCode = "operation-rejected",
    /** AAR refused because the account's login expired or was cleared. */
    readonly loginRequired = false,
  ) {
    super(message);
  }
}
/**
 * A refusal from the launch's router step, which precedes any provider
 * start. Creation records it as a known failure, not uncertain delivery.
 */
export class RouterRefusedBeforeProvider extends RouterUnavailable {
  constructor(cause: RouterUnavailable) {
    super(cause.status, cause.message, cause.code, cause.loginRequired);
  }
}
/** The account itself is fine; only its owner can restore its login. */
export function routerLoginRequired(accountName?: string): RouterUnavailable {
  return new RouterUnavailable(
    409,
    `The pinned router account${accountName ? ` (${accountName})` : ""} needs to sign in again: its login in AAR expired or was cleared. Sign that account in again in AAR, then retry. This session's pin will not change.`,
    "account-unavailable",
    true,
  );
}
/** AAR's own default control socket, used when the owner names none. */
export function defaultRouterSocket(): string {
  return join(homedir(), ".agent-auth-router", "control.sock");
}

export function validateRouterSocket(socketPath: string): void {
  if (process.platform === "win32")
    throw new RouterUnavailable(
      409,
      "Local router requires macOS or Linux",
      "unsupported",
    );
  for (const [path, socket] of [
    [dirname(socketPath), false],
    [socketPath, true],
  ] as const) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      throw routerOffline();
    }
    if (
      st.isSymbolicLink() ||
      (socket ? !st.isSocket() : !st.isDirectory()) ||
      st.uid !== process.getuid?.() ||
      st.mode & 0o077
    )
      throw new RouterUnavailable(
        409,
        "Router socket must be private and owned by the YA server user. Fix its ownership and permissions, then retry.",
        "unsafe-socket",
      );
  }
}
export function routerOffline() {
  return new RouterUnavailable(
    503,
    "Router unavailable. Start AAR on the YA server and check its socket in Settings → Providers, then retry. This session will keep its pinned account.",
    "unavailable",
  );
}
/**
 * Only 4xx policy refusals are the router's own decisions; 5xx bodies may
 * describe upstream failures and stay generic. Accepted reasons are short
 * plain text, so they cannot carry tokens, paths or markup.
 */
function rejectionReason(
  status: number | undefined,
  body: Buffer,
): string | undefined {
  if (!status || status < 400 || status >= 500) return undefined;
  try {
    const { error } = JSON.parse(body.toString()) as { error?: unknown };
    if (
      typeof error === "string" &&
      /^[A-Za-z][A-Za-z ,;:'()-]{0,159}$/.test(error)
    )
      return error;
  } catch {
    /* Generic message below. */
  }
  return undefined;
}
/** AAR 2026-11 refuses a lapsed or cleared login with a 409 code. */
function rejectedForLogin(status: number | undefined, body: Buffer): boolean {
  if (status !== 409) return false;
  try {
    const { code } = JSON.parse(body.toString()) as { code?: unknown };
    return code === "login_required" || code === "not_enrolled";
  } catch {
    return false;
  }
}
export function hostedRouterOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RouterUnavailable(
      400,
      "Enter a valid HTTPS router URL",
      "invalid-url",
    );
  }
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new RouterUnavailable(
      400,
      "Use a bare HTTPS router URL without credentials, a path, query or fragment",
      "invalid-url",
    );
  return url.origin;
}
function transportFailure(
  endpoint: RouterEndpoint,
  error?: Error & { code?: string },
) {
  if (typeof endpoint === "string") return routerOffline();
  const host = new URL(endpoint.origin).host;
  if (
    error?.code &&
    /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(
      error.code,
    )
  )
    return new RouterUnavailable(
      503,
      `The certificate for ${host} could not be verified. Check its hostname, validity and certificate chain.`,
      "certificate-invalid",
    );
  return new RouterUnavailable(
    503,
    `Can't reach ${host}. Check the router and retry. Sessions keep their pinned accounts.`,
    "unavailable",
  );
}
/** Neither transport follows redirects or changes credential surfaces. */
export async function routerRequest<T>(
  endpoint: RouterEndpoint,
  path: string,
  credential?: string,
  body?: object,
): Promise<T> {
  if (typeof endpoint === "string") validateRouterSocket(endpoint);
  else hostedRouterOrigin(endpoint.origin);
  return new Promise<T>((resolveResult, reject) => {
    const remote =
      typeof endpoint !== "string" ? new URL(endpoint.origin) : undefined;
    const request = (remote ? https : http).request(
      {
        ...(remote
          ? {
              hostname: remote.hostname.replace(/^\[|\]$/g, ""),
              port: remote.port || 443,
              protocol: "https:",
              rejectUnauthorized: true,
            }
          : { socketPath: endpoint as string }),
        path: remote ? `/control${path}` : path,
        method: body ? "POST" : "GET",
        headers: {
          host: remote?.host ?? "localhost",
          "content-type": "application/json",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024)
            response.destroy(new Error("oversized response"));
          else chunks.push(chunk);
        });
        response.on("error", () => reject(transportFailure(endpoint)));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            if (rejectedForLogin(response.statusCode, Buffer.concat(chunks)))
              return reject(routerLoginRequired());
            const reason = rejectionReason(
              response.statusCode,
              Buffer.concat(chunks),
            );
            return reject(
              new RouterUnavailable(
                response.statusCode ?? 503,
                response.statusCode === 401
                  ? "Router connection revoked. Finish disconnecting in Settings → Providers, then reconnect for new sessions. Existing sessions cannot adopt a new pairing."
                  : `Router rejected the operation${reason ? ` (${reason})` : ""}. Check the pinned account and model in Settings → Providers, then retry. No account was substituted.`,
                response.statusCode === 401
                  ? "revoked"
                  : response.statusCode === 403 &&
                      pendingPairing(Buffer.concat(chunks))
                    ? "pairing-pending"
                    : "operation-rejected",
              ),
            );
          }
          try {
            resolveResult(JSON.parse(Buffer.concat(chunks).toString()) as T);
          } catch {
            reject(
              new RouterUnavailable(
                502,
                "Invalid router response. Check the AAR version and retry.",
                "protocol-mismatch",
              ),
            );
          }
        });
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("deadline")),
      20_000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", (error) => reject(transportFailure(endpoint, error)));
    request.end(body ? JSON.stringify(body) : undefined);
  });
}

function pendingPairing(body: Buffer): boolean {
  try {
    return JSON.parse(body.toString()).code === "pairing_pending";
  } catch {
    return false;
  }
}
