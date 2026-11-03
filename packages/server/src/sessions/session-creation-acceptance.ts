import { createHash } from "node:crypto";
import type { SessionCreationReceipt } from "@yep-anywhere/shared";
import type { SavedSessionCreation } from "./SessionCreationStore.js";

/** Fingerprint submitted choices before defaults, availability or routing change. */
export function textCreationSubmissionHash(
  body: unknown,
  projectId: string,
): string {
  const wire = JSON.stringify({ body, projectId }, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    );
  });
  return createHash("sha256").update(wire).digest("hex");
}

export function textCreationReceipt(
  saved: SavedSessionCreation,
): SessionCreationReceipt {
  if (!saved.request || saved.deleted)
    throw new Error("Saved creation was deleted");
  return {
    requestId: saved.requestId,
    sessionId: saved.sessionId,
    projectId: saved.request.projectId,
    provider: saved.request.provider,
    creation: {
      state: saved.attempt.state,
      attemptId: saved.attempt.attemptId,
      updatedAt: saved.attempt.updatedAt,
      delivery: saved.attempt.delivery,
      ...(saved.attempt.kind ? { kind: saved.attempt.kind } : {}),
      ...(saved.request.intent ? { initialInputExpected: false as const } : {}),
      ...(saved.attempt.failure ? { failure: saved.attempt.failure } : {}),
    },
    serverTimestamp: Date.now(),
  };
}
