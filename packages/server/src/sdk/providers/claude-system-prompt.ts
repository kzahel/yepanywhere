import { findAgentApiBootstrapInstructions } from "@yep-anywhere/shared/agent-api-bootstrap";
import { findMachineControlInstructions } from "@yep-anywhere/shared/machine-control-instructions";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";
import { withSessionSandboxAgentContext } from "../../session-sandbox-agent-context.js";
import { appendBootInstructions } from "./boot-instructions.js";

type BasePrompt =
  | string
  | { type: "preset"; preset: "claude_code"; append?: string }
  | undefined;

/**
 * A Claude session's system prompt: the base prompt with server-wide and boot
 * instructions appended, or a sandbox's replacement prompt.
 */
export function claudeSessionSystemPrompt(
  basePrompt: (instructions?: string) => BasePrompt,
  launch: Parameters<typeof appendBootInstructions>[0],
  sandbox: SessionSandboxRuntime | undefined,
): Options["systemPrompt"] {
  const globalInstructions = appendBootInstructions(launch);
  const refreshInstructions = Boolean(
    globalInstructions &&
      (findAgentApiBootstrapInstructions(globalInstructions) ||
        findMachineControlInstructions(globalInstructions)),
  );
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
  if ((!instructions && !refreshInstructions) || !prompt) return prompt;
  return typeof prompt === "string"
    ? { type: "custom", prompt, snapshot: false }
    : { ...prompt, snapshot: false };
}
