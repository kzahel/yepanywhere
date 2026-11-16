import type {
  SessionCreationReceipt,
  StagedAttachmentRef,
  UserMessageMetadata,
} from "@yep-anywhere/shared";
import { generateUUID } from "./uuid";
import type { SourceTransport } from "./transport/types";
import type { SessionOptions } from "../api/client";

export function getSessionCreation(
  transport: Pick<SourceTransport, "fetch">,
  requestId: string,
) {
  return transport.fetch<SessionCreationReceipt>(
    `/session-creations/${encodeURIComponent(requestId)}`,
  );
}
export interface PendingCreation {
  requestId: string;
  payload: string;
  clientTimestamp: number;
  draftText?: string;
  draftAttachments?: string;
  draftFileIds?: string[];
  receipt?: SessionCreationReceipt;
}

const listeners = new Set<() => void>();
/** Observe saved creation records, including a sibling tab's changes. */
export function subscribeSessionCreations(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function published(): void {
  for (const listener of [...listeners]) listener();
}
export function readSessionCreation(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
// The saved record only helps recovery. A browser that cannot store it (full
// or unavailable storage) must still be able to send, so writes never throw.
function saveSessionCreation(key: string, pending: PendingCreation): void {
  try {
    localStorage.setItem(key, JSON.stringify(pending));
  } catch {
    return;
  }
  published();
}
/**
 * A record this build cannot read, from damage or another client version, is
 * no record: it never blocks sending and the next request replaces it.
 */
export function parseSessionCreation(
  saved: string | null,
): PendingCreation | null {
  try {
    const value = JSON.parse(saved ?? "null");
    if (
      !value ||
      typeof value.requestId !== "string" ||
      typeof value.payload !== "string" ||
      typeof value.clientTimestamp !== "number"
    )
      return null;
    const request = JSON.parse(value.payload);
    return request && typeof request.message === "string" ? value : null;
  } catch {
    return null;
  }
}
export function pendingSessionCreation(key: string): PendingCreation | null {
  return parseSessionCreation(readSessionCreation(key));
}
/** The prompt a saved record was sent with, for showing what is unresolved. */
export function pendingSessionCreationPrompt(pending: PendingCreation): string {
  return pending.draftText ?? JSON.parse(pending.payload).message;
}
export function settleSessionCreation(key: string, requestId: string): void {
  if (pendingSessionCreation(key)?.requestId === requestId)
    forgetSessionCreation(key);
}
/**
 * Start fresh: drop whatever is saved under this key, readable or not, so the
 * next request is independent. Nothing is sent and the earlier request is
 * left as it was; if the server did save it, its session is still listed.
 */
export function forgetSessionCreation(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage that cannot be changed held no readable record to block on.
  }
  published();
}
function rememberReceipt(
  key: string,
  pending: PendingCreation,
  receipt: SessionCreationReceipt,
) {
  if (pendingSessionCreation(key)?.requestId === pending.requestId)
    saveSessionCreation(key, { ...pending, receipt });
  return receipt;
}
function creationIntent(payload: string): string {
  const request = JSON.parse(payload);
  const {
    clientTimestamp: _client,
    serverReceivedAt: _server,
    composition: _composition,
    speech: _speech,
    ...choices
  } = request.metadata ?? {};
  // Build provenance changes with every client update, which would otherwise
  // turn an unchanged retry into a different request the user cannot recreate.
  const { creationProvenance: _provenance, ...options } = request.options ?? {};
  return JSON.stringify({ ...request, options, metadata: choices });
}

export async function acceptSessionCreation(
  transport: Pick<SourceTransport, "fetch">,
  key: string,
  projectId: string | undefined,
  message: string,
  options: SessionOptions,
  clientTimestamp: number,
  metadata?: UserMessageMetadata,
  draftText?: string,
  stagedAttachments?: StagedAttachmentRef[],
  draftAttachments?: string,
  draftFileIds?: string[],
): Promise<SessionCreationReceipt> {
  const payload = JSON.stringify({
    projectId,
    message,
    options,
    metadata,
    stagedAttachments,
  });
  const previous = pendingSessionCreation(key);
  // Refused rather than replaced so a different request is never sent by
  // accident while an earlier one may have been saved. Every caller must offer
  // forgetSessionCreation beside this refusal: it is the only way out when the
  // earlier request can no longer be confirmed.
  if (previous && creationIntent(previous.payload) !== creationIntent(payload))
    throw new Error(
      "An earlier request is still unconfirmed. Check it, or choose Start fresh and send again.",
    );
  const pending = previous ?? {
    requestId: generateUUID(),
    payload,
    clientTimestamp,
    ...(draftText !== undefined ? { draftText } : {}),
    ...(draftAttachments !== undefined ? { draftAttachments } : {}),
    ...(draftFileIds !== undefined ? { draftFileIds } : {}),
  };
  if (!previous) saveSessionCreation(key, pending);
  if (previous?.receipt)
    return rememberReceipt(
      key,
      pending,
      await getSessionCreation(transport, pending.requestId),
    );
  const frozen = JSON.parse(pending.payload) as {
    message: string;
    options: SessionOptions;
    metadata?: UserMessageMetadata;
    stagedAttachments?: StagedAttachmentRef[];
  };
  try {
    const receipt = await transport.fetch<SessionCreationReceipt>(
      projectId
        ? `/projects/${projectId}/session-creations`
        : "/session-creations",
      {
        method: "POST",
        body: JSON.stringify({
          ...frozen.options,
          requestId: pending.requestId,
          message: frozen.message,
          clientTimestamp: pending.clientTimestamp,
          messageMetadata: frozen.metadata,
          stagedAttachments: frozen.stagedAttachments,
        }),
      },
    );
    return rememberReceipt(key, pending, receipt);
  } catch (error) {
    const refusal = error as { status?: number; reason?: string } | null;
    if (refusal?.status === 400 && refusal.reason === "creation-not-accepted") {
      settleSessionCreation(key, pending.requestId);
      throw error;
    }
    // A failed HTTP reply does not establish whether the server saved input.
    try {
      const receipt = await getSessionCreation(transport, pending.requestId);
      return rememberReceipt(key, pending, receipt);
    } catch {
      throw error;
    }
  }
}
