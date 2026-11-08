import { isClaudeProviderName, type ProviderName } from "@yep-anywhere/shared";
import {
  type ConnectionImpactReason,
  parseConnectionImpact,
} from "./connectionImpact";

/**
 * Machine-readable fields a refusal body carries beside its `error` text, so
 * a caller can act on why a request was refused without matching message
 * wording. Both HTTP transports (direct and relay) copy them onto the error
 * they throw.
 */
export interface ApiRefusalFields {
  /** Stable refusal reason, e.g. `stale-session`. */
  reason?: string;
  /**
   * Set on a `stale-session` refusal when the user may start sessions in the
   * session's project: the turn belongs in a new session seeded with a
   * handoff (topics/limited-users.md § Freshness).
   */
  staleRedirect?: "stale-handoff";
  /** How to continue, e.g. `handoff-required` when the transcript cannot resume. */
  recovery?: string;
  /** Why a `connection-impact` refusal would disconnect this client. */
  connectionImpact?: ConnectionImpactReason[];
}

export function refusalFields(body: unknown): ApiRefusalFields {
  if (!body || typeof body !== "object") return {};
  const { reason, staleRedirect, recovery, connectionImpact } = body as Record<
    string,
    unknown
  >;
  const impact = parseConnectionImpact(connectionImpact);
  return {
    ...(typeof reason === "string" ? { reason } : {}),
    ...(staleRedirect === "stale-handoff" ? { staleRedirect } : {}),
    ...(typeof recovery === "string" ? { recovery } : {}),
    ...(impact ? { connectionImpact: impact } : {}),
  };
}

/** Whether a send was refused because its session went cold, with a redirect. */
export function isStaleSessionRedirect(error: unknown): boolean {
  const fields = error as ApiRefusalFields | null;
  return (
    fields?.reason === "stale-session" &&
    fields.staleRedirect === "stale-handoff"
  );
}

/**
 * Whether a resume was refused because the transcript itself cannot continue
 * and needs a handoff. Other 409s, such as a router account refusal, carry
 * their own remedy. Servers since 2026-05-31 send both the field and the text.
 */
export function isHandoffRequiredRefusal(error: unknown): boolean {
  const refused = error as (ApiRefusalFields & { status?: number }) | null;
  if (refused?.status !== 409) return false;
  if (refused.recovery === "handoff-required") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Start a handoff session");
}

/** A Claude resume refusal whose remedy is a handoff session. */
export function requiresHandoffAfterClaudeResumeError(
  error: unknown,
  provider: ProviderName | undefined,
): boolean {
  return isClaudeProviderName(provider) && isHandoffRequiredRefusal(error);
}
