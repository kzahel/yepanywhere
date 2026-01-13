import { z } from "zod";
import { BaseEntrySchema } from "./BaseEntrySchema.js";

// Regular system entry (tool-related)
const RegularSystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  content: z.string(),
  toolUseID: z.string(),
  level: z.enum(["info"]),
});

// Compact boundary system entry (conversation compaction)
const CompactBoundarySystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("compact_boundary"),
  content: z.string(),
  level: z.enum(["info"]),
  slug: z.string().optional(),
  logicalParentUuid: z.string().uuid().optional(),
  compactMetadata: z
    .object({
      trigger: z.string(),
      preTokens: z.number(),
    })
    .optional(),
});

// Init system entry (session initialization with available commands/agents)
const InitSystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  slash_commands: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  claude_code_version: z.string().optional(),
  apiKeySource: z.string().optional(),
  output_style: z.string().optional(),
});

// Status system entry (compacting indicator)
const StatusSystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("status"),
  status: z.enum(["compacting"]).nullable(),
});

export const SystemEntrySchema = z.union([
  RegularSystemEntrySchema,
  CompactBoundarySystemEntrySchema,
  InitSystemEntrySchema,
  StatusSystemEntrySchema,
]);

export type SystemEntry = z.infer<typeof SystemEntrySchema>;

// Export InitSystemEntry type for consumers that need slash_commands
export type InitSystemEntry = z.infer<typeof InitSystemEntrySchema>;
