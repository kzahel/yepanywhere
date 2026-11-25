import type { CodexAppServerClient } from "./codex-app-server-client.js";
import type {
  ThreadResumeParams,
  ThreadStartParams,
} from "./codex-protocol/index.js";
import { readBootInstructionText } from "./boot-instructions.js";
import type { StartSessionOptions } from "./types.js";

function launchInstructions(options: StartSessionOptions): string {
  return [options.agentApiInstructions, options.machineControlInstructions]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Preserve operator and sandbox instructions when adding YA's own fragment.
 * A session's boot instructions take the place of the operator's configured
 * developer instructions.
 */
export async function configureCodexLaunchInstructions(
  client: CodexAppServerClient,
  options: StartSessionOptions,
  start: ThreadStartParams,
  resume: ThreadResumeParams,
): Promise<void> {
  const fragment = launchInstructions(options);
  const boot = options.bootInstructions
    ? readBootInstructionText(options.bootInstructions.source)
    : undefined;
  if (!fragment && boot === undefined) return;
  const configured =
    boot === undefined
      ? (
          await client.request<{
            config: { developer_instructions?: unknown };
          }>("config/read", { cwd: options.cwd, includeLayers: false })
        ).config?.developer_instructions
      : boot;
  const instructions = [
    typeof configured === "string" ? configured : undefined,
    start.developerInstructions,
    fragment,
  ]
    .filter(Boolean)
    .join("\n\n");
  start.developerInstructions = instructions;
  resume.developerInstructions = instructions;
}

/** Resume overrides alone do not replace already-materialized model history. */
export async function injectResumedCodexLaunchInstructions(
  client: CodexAppServerClient,
  options: StartSessionOptions,
  threadId: string,
): Promise<void> {
  const fragment = launchInstructions(options);
  if (!fragment || !options.resumeSessionId) return;
  await client.request("thread/inject_items", {
    threadId,
    items: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: fragment }],
      },
    ],
  });
}
