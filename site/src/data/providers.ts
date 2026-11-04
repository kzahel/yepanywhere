import {
  ALL_PROVIDERS,
  type ProviderName,
} from "../../../packages/shared/src/types";

export type ProviderStatus = "stable" | "experimental";

export interface PublicProvider {
  id: string;
  name: string;
  status: ProviderStatus;
  summary: string;
  notes: string;
  runtimeIds: readonly ProviderName[];
  sourceRefs: string[];
}

export const providers = [
  {
    id: "claude",
    name: "Claude Code",
    status: "stable",
    summary:
      "The primary integration, with an advanced opt-in route for compatible LLM gateways.",
    notes:
      "Sessions, streaming, approvals, diffs, steering, recaps, and model controls; gateway routing stays separate from regular Claude sessions.",
    runtimeIds: ["claude", "claude-gateway"],
    sourceRefs: [
      "packages/server/src/sdk/providers/claude.ts",
      "packages/server/src/sdk/providers/claude-gateway.ts",
      "README.md",
    ],
  },
  {
    id: "codex",
    name: "Codex",
    status: "stable",
    summary:
      "First-class Codex CLI support with live and replayed session parity.",
    notes:
      "Sessions, streaming, approvals, apply-patch diffs, steering, recaps, and effort controls.",
    runtimeIds: ["codex", "codex-oss"],
    sourceRefs: [
      "packages/server/src/sdk/providers/codex.ts",
      "site/src/pages/spring-2026.astro",
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    status: "experimental",
    summary:
      "Start, resume, and inspect OpenCode sessions through its native server.",
    notes:
      "Permissions, questions, tools, images, and history are supported; capability parity varies.",
    runtimeIds: ["opencode"],
    sourceRefs: ["topics/opencode-backend.md"],
  },
  {
    id: "grok",
    name: "Grok Build",
    status: "experimental",
    summary: "Use the Grok Build CLI through the Agent Client Protocol.",
    notes:
      "Includes prompt suggestions, effort controls, approvals, and steering where upstream supports them.",
    runtimeIds: ["grok"],
    sourceRefs: [
      "topics/grok.md",
      "packages/server/src/sdk/providers/grok-acp.ts",
    ],
  },
  {
    id: "ollama",
    name: "Claude + Ollama (legacy)",
    status: "experimental",
    summary:
      "Read or resume existing Claude + Ollama sessions during its deprecation period.",
    notes:
      "Hidden unless previously configured or used; choose Claude Gateway for new compatible endpoints.",
    runtimeIds: ["claude-ollama"],
    sourceRefs: [
      "packages/server/src/sdk/providers/claude-ollama.ts",
      "topics/claude.md",
    ],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    status: "experimental",
    summary:
      "Launch or read Gemini CLI sessions through its experimental ACP integration.",
    notes:
      "Streaming and tool rendering are available; approvals, steering, and history behavior vary by mode.",
    runtimeIds: ["gemini", "gemini-acp"],
    sourceRefs: ["packages/server/src/sdk/providers/gemini-acp.ts"],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    status: "experimental",
    summary:
      "Start and resume Antigravity sessions through its opt-in Agent Client Protocol integration.",
    notes:
      "Text, file references, approvals, streaming, and native history are supported; macOS is live-qualified, Linux remains unqualified, and Windows is unavailable.",
    runtimeIds: ["antigravity"],
    sourceRefs: ["topics/antigravity.md"],
  },
  {
    id: "pi",
    name: "pi",
    status: "experimental",
    summary:
      "Drive pi's provider-agnostic coding agent through its supported headless RPC mode.",
    notes:
      "Sessions, streaming, tool rendering, model and thinking controls, compaction, forks, and durable history are supported; tools currently run without a Yep Anywhere approval bridge.",
    runtimeIds: ["pi"],
    sourceRefs: [
      "packages/server/src/sdk/providers/pi.ts",
      "topics/pi-provider.md",
    ],
  },
] as const satisfies readonly PublicProvider[];

export type ProviderId = (typeof providers)[number]["id"];

export { ALL_PROVIDERS };
