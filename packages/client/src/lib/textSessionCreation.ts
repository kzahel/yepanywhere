import type {
  TextSessionCreationReceipt,
  StagedAttachmentRef,
  UserMessageMetadata,
} from "@yep-anywhere/shared";
import { generateUUID } from "./uuid";
import type { SourceTransport } from "./transport/types";
import type { SessionOptions } from "../api/client";

export function getTextCreation(
  transport: Pick<SourceTransport, "fetch">,
  requestId: string,
) {
  return transport.fetch<TextSessionCreationReceipt>(
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
  receipt?: TextSessionCreationReceipt;
}
export function settleTextCreation(key: string, requestId: string): void {
  if (pendingTextCreation(key)?.requestId === requestId)
    localStorage.removeItem(key);
}
function rememberReceipt(
  key: string,
  pending: PendingCreation,
  receipt: TextSessionCreationReceipt,
) {
  if (pendingTextCreation(key)?.requestId === pending.requestId)
    localStorage.setItem(key, JSON.stringify({ ...pending, receipt }));
  return receipt;
}
export function pendingTextCreation(key: string): PendingCreation | null {
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
export async function acceptTextCreation(
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
): Promise<TextSessionCreationReceipt> {
  const payload = JSON.stringify({
    projectId,
    message,
    options,
    metadata,
    stagedAttachments,
  });
  const previous = pendingTextCreation(key);
  if (previous && previous.payload !== payload)
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
      await getTextCreation(transport, pending.requestId),
    );
  try {
    const receipt = await transport.fetch<TextSessionCreationReceipt>(
      projectId
        ? `/projects/${projectId}/session-creations`
        : "/session-creations",
      {
        method: "POST",
        body: JSON.stringify({
          ...options,
          requestId: pending.requestId,
          message,
          clientTimestamp: pending.clientTimestamp,
          messageMetadata: metadata,
          stagedAttachments,
        }),
      },
    );
    return rememberReceipt(key, pending, receipt);
  } catch (error) {
    const refusal = error as { status?: number; reason?: string } | null;
    if (refusal?.status === 400 && refusal.reason === "creation-not-accepted") {
      settleTextCreation(key, pending.requestId);
      throw error;
    }
    // A failed HTTP reply does not establish whether the server saved input.
    try {
      const receipt = await getTextCreation(transport, pending.requestId);
      return rememberReceipt(key, pending, receipt);
    } catch {
      throw error;
    }
  }
}
