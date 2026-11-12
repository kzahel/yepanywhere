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
      "sendMessage",
      "followReceipt",
    ]),
    input: z
      .object({
        serverId: z.string().min(1).max(4096).optional(),
        sessionId: z.string().min(1).max(4096).optional(),
        receiptId: z.string().min(1).max(128).optional(),
        body: z.unknown().optional(),
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
