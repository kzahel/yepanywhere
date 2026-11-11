import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";
import { withSessionSandboxAgentContext } from "../../session-sandbox-agent-context.js";

type BasePrompt =
  | string
  | { type: "preset"; preset: "claude_code"; append?: string }
  | undefined;

export function claudeSessionSystemPrompt(
  basePrompt: (instructions?: string) => BasePrompt,
  globalInstructions: string | undefined,
  sandbox: SessionSandboxRuntime | undefined,
): Options["systemPrompt"] {
  const instructions = sandbox?.instructions;
  if (instructions && !instructions.startFromDefault) {
    return {
      type: "custom",
      prompt: withSessionSandboxAgentContext(instructions.text, sandbox) ?? "",
      snapshot: false,
    };
  }
  const append = [globalInstructions, instructions?.text]
    .filter(Boolean)
    .join("\n\n");
  const prompt = basePrompt(withSessionSandboxAgentContext(append, sandbox));
  if (!instructions || !prompt) return prompt;
  return typeof prompt === "string"
    ? { type: "custom", prompt, snapshot: false }
    : { ...prompt, snapshot: false };
}
