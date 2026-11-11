import type { CodexAppServerClient } from "./codex-app-server-client.js";
import type {
  ThreadResumeParams,
  ThreadStartParams,
} from "./codex-protocol/index.js";
import type { StartSessionOptions } from "./types.js";

/** Preserve operator and sandbox instructions when adding YA's own fragment. */
export async function configureCodexApiBootstrap(
  client: CodexAppServerClient,
  options: StartSessionOptions,
  start: ThreadStartParams,
  resume: ThreadResumeParams,
): Promise<void> {
  if (!options.agentApiInstructions) return;
  const result = await client.request<{
    config: { developer_instructions?: unknown };
  }>("config/read", { cwd: options.cwd, includeLayers: false });
  const configured = result.config?.developer_instructions;
  const instructions = [
    typeof configured === "string" ? configured : undefined,
    start.developerInstructions,
    options.agentApiInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");
  start.developerInstructions = instructions;
  resume.developerInstructions = instructions;
}

/** Resume overrides alone do not replace already-materialized model history. */
export async function injectResumedCodexApiBootstrap(
  client: CodexAppServerClient,
  options: StartSessionOptions,
  threadId: string,
): Promise<void> {
  if (!options.agentApiInstructions || !options.resumeSessionId) return;
  await client.request("thread/inject_items", {
    threadId,
    items: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: options.agentApiInstructions }],
      },
    ],
  });
}
