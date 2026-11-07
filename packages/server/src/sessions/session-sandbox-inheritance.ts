import type { SessionSandboxLevel } from "@yep-anywhere/shared";

/**
 * What a launch inherits from a session's saved sandbox: whether its network
 * firewall stays on, the project-write settings a successor keeps, and the
 * directory it runs in.
 */

export function persistedSandboxNetworkFirewall(
  metadata:
    | { sandboxLevel?: SessionSandboxLevel; sandboxNetworkFirewall?: boolean }
    | null
    | undefined,
): boolean {
  return (
    metadata?.sandboxLevel === "project-write" &&
    metadata.sandboxNetworkFirewall !== false
  );
}

export function inheritedSandboxSettings(
  metadata:
    | {
        sandboxLevel?: SessionSandboxLevel;
        sandboxNetworkFirewall?: boolean;
        sandboxStateKey?: string;
      }
    | null
    | undefined,
):
  | {
      sandboxLevel: "project-write";
      sandboxNetworkFirewall: boolean;
      sandboxStateKey?: string;
    }
  | Record<string, never> {
  if (metadata?.sandboxLevel !== "project-write") return {};
  return {
    sandboxLevel: "project-write",
    sandboxNetworkFirewall: metadata.sandboxNetworkFirewall !== false,
    sandboxStateKey: metadata.sandboxStateKey,
  };
}

/**
 * The directory a session launched from `metadata` runs in: its sandbox
 * working copy when it is project-write sandboxed, otherwise the project.
 */
export function sandboxWorkingProjectPath(
  metadata:
    | { sandboxLevel?: SessionSandboxLevel; sandboxProjectPath?: string }
    | undefined,
  projectPath: string,
): string {
  return metadata?.sandboxLevel === "project-write"
    ? (metadata.sandboxProjectPath ?? projectPath)
    : projectPath;
}
