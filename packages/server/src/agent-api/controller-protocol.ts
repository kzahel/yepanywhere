import { operations, type Operation } from "../core-api/contracts.js";
import { httpReplySchema } from "../core-api/http-contracts.js";
import { CoreApiError } from "../core-api/errors.js";
import type { ApiReadPort } from "../core-api/service.js";
import { httpRequestSchema } from "../core-api/http-contracts.js";
import { launchContextSchema } from "../core-api/contracts.js";
import { z } from "zod";

/** Only bounded authenticated operations cross the trusted provider/controller channel. */
export const agentCatalogRequest = z
  .object({
    operation: z.enum([
      "servers",
      "server",
      "access",
      "capabilities",
      "projects",
      "uploadAttachment",
      "providers",
      "selection",
      "sessions",
      "session",
      "conversation",
      "followConversation",
      "createSession",
      "receipt",
      "relationships",
      "createInput",
      "inputs",
      "cancelInput",
      "followReceipt",
      "targetHelp",
      "targetSchema",
      "requests",
      "respond",
      "cancel",
      "stop",
    ]),
    input: z
      .object({
        serverId: z.string().min(1).max(4096).optional(),
        projectId: z.string().min(1).max(4096).optional(),
        sessionId: z.string().min(1).max(4096).optional(),
        receiptId: z.string().min(1).max(128).optional(),
        body: z.unknown().optional(),
        pendingRequestId: z.string().max(4096).optional(),
        inputId: z.string().min(1).max(256).optional(),
        http: httpRequestSchema.optional(),
        unknownRoute: z.boolean().optional(),
        launch: launchContextSchema.optional(),
        query: z
          .record(z.string().max(128), z.string().max(4096))
          .refine((value) => Object.keys(value).length <= 32)
          .optional(),
      })
      .strict(),
  })
  .strict();
export const AGENT_CATALOG_TIMEOUT_MS = 10_000;
export const AGENT_CATALOG_MAX_BYTES = 2 * 1024 * 1024;

/** Serializable, trusted controller projection; signals and owner proof stay local. */
export function agentCatalogInput(
  input: NonNullable<Parameters<ApiReadPort>[2]>,
) {
  return {
    serverId: input.serverId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    receiptId: input.receiptId,
    body: input.body,
    launch: input.launch,
    query: input.query,
    http: input.http,
    pendingRequestId: input.pendingRequestId,
    inputId: input.inputId,
    unknownRoute: input.unknownRoute,
  };
}
export function parseAgentCatalogReply(
  operation: Operation,
  input: NonNullable<Parameters<ApiReadPort>[2]>,
  result: unknown,
) {
  const schema = operations.find((item) => item.id === operation)!.response;
  return (input.http ? httpReplySchema.or(schema) : schema).safeParse(result);
}

export const agentLeaseRevoked = () =>
  new CoreApiError("forbidden", "Agent API launch authority was revoked", 403);

export function cancelAgentCatalogRequest(
  pending: Map<string, AbortController>,
  message: { requestId?: unknown; authorityRevoked?: unknown },
) {
  const id = String(message.requestId);
  pending
    .get(id)
    ?.abort(
      message.authorityRevoked === true ? agentLeaseRevoked() : undefined,
    );
  pending.delete(id);
}
