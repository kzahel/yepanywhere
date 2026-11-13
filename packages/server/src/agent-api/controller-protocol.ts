import { operations, type Operation } from "../core-api/contracts.js";
import { httpReplySchema } from "../core-api/http-contracts.js";
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
      "providers",
      "selection",
      "sessions",
      "session",
      "conversation",
      "followConversation",
      "createSession",
      "receipt",
      "relationships",
      "prompt",
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
        sessionId: z.string().min(1).max(4096).optional(),
        receiptId: z.string().min(1).max(128).optional(),
        body: z.unknown().optional(),
        pendingRequestId: z.string().max(4096).optional(),
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
    sessionId: input.sessionId,
    receiptId: input.receiptId,
    body: input.body,
    launch: input.launch,
    query: input.query,
    http: input.http,
    pendingRequestId: input.pendingRequestId,
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
