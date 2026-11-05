/** YA startup evidence is separate from native history and provider liveness. */
export interface SessionCreationStatus {
  /** Optional profile revision orders live status against in-flight snapshots. */
  revision?: number;
  state:
    | "saved"
    | "queued"
    | "dispatching"
    | "bound"
    | "failed"
    | "uncertain"
    | "deleted";
  /** Copying history is an admitted operation with no initial user turn. */
  kind?: "copy";
  /** False for preparation and transcript copies; no initial turn was submitted. */
  initialInputExpected?: false;
  attemptId: string;
  updatedAt: string;
  /** Safe router refusal text, saved only before provider startup. Absent on older servers. */
  failureDetail?: string;
  delivery: "not-admitted" | "uncertain" | "consumed";
  /**
   * Safe outcome codes. The `router-*` codes mean Agent Auth Router refused
   * the session's account before any provider started (2026-11), so nothing
   * was sent; older clients show their generic failure for them.
   * `provider-host-outdated` means the long-lived provider host lacks a
   * feature this server requires and must be restarted (2026-11); older
   * clients likewise show the generic failure.
   */
  failure?:
    | "startup-unavailable"
    | "launch-refused"
    | "cancelled"
    | "router-login-required"
    | "router-refused"
    | "provider-host-outdated";
}

/** Durable creation acceptance; provider startup and delivery are separate facts. */
export interface SessionCreationReceipt {
  requestId: string;
  sessionId: string;
  projectId: string;
  provider: string;
  creation: SessionCreationStatus;
  serverTimestamp: number;
}

/** Preparing an empty session permits its first turn on the incumbent owner. */
export function isSessionCreationPending(
  creation: SessionCreationStatus | undefined,
): boolean {
  return Boolean(
    creation &&
      creation.delivery !== "consumed" &&
      !(
        creation.initialInputExpected === false &&
        (creation.state === "bound" ||
          (creation.state === "dispatching" && creation.kind !== "copy"))
      ),
  );
}
