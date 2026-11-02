/** YA startup evidence is separate from native history and provider liveness. */
export interface SessionCreationStatus {
  state:
    | "saved"
    | "queued"
    | "dispatching"
    | "bound"
    | "failed"
    | "uncertain"
    | "deleted";
  /** False only for an explicitly prepared empty session; no initial turn was submitted. */
  initialInputExpected?: false;
  attemptId: string;
  updatedAt: string;
  delivery: "not-admitted" | "uncertain" | "consumed";
  failure?: "startup-unavailable" | "launch-refused" | "cancelled";
}

/** Durable text acceptance; provider startup and delivery are separate facts. */
export interface TextSessionCreationReceipt {
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
        ["dispatching", "bound"].includes(creation.state)
      ),
  );
}
