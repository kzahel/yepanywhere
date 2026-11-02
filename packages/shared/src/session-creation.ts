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
