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
interface PendingCreation {
  requestId: string;
  payload: string;
  clientTimestamp: number;
  draftText?: string;
  draftAttachments?: string;
  draftFileIds?: string[];
  receipt?: SessionCreationReceipt;
}
export function settleSessionCreation(key: string, requestId: string): void {
  if (pendingSessionCreation(key)?.requestId === requestId)
    localStorage.removeItem(key);
}
function rememberReceipt(
  key: string,
  pending: PendingCreation,
  receipt: SessionCreationReceipt,
) {
  if (pendingSessionCreation(key)?.requestId === pending.requestId)
    localStorage.setItem(key, JSON.stringify({ ...pending, receipt }));
  return receipt;
}
export function pendingSessionCreation(key: string): PendingCreation | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value &&
      typeof value.requestId === "string" &&
      typeof value.payload === "string" &&
      typeof value.clientTimestamp === "number"
      ? value
      : null;
  } catch {
    return null;
  }
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
  return JSON.stringify({ ...request, metadata: choices });
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
  if (previous && creationIntent(previous.payload) !== creationIntent(payload))
    throw new Error(
      "Check the earlier unconfirmed creation before submitting another request.",
    );
  const pending = previous ?? {
    requestId: generateUUID(),
    payload,
    clientTimestamp,
    ...(draftText !== undefined ? { draftText } : {}),
    ...(draftAttachments !== undefined ? { draftAttachments } : {}),
    ...(draftFileIds !== undefined ? { draftFileIds } : {}),
  };
  // Failure to retain the recovery identity refuses the request before sending.
  localStorage.setItem(key, JSON.stringify(pending));
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
