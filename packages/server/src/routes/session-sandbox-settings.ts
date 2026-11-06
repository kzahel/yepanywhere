import type { SessionSandboxLevel } from "@yep-anywhere/shared";

export function parseSessionSandboxLevel(
  value: unknown,
  networkFirewall: unknown = undefined,
  fallbackLevel: SessionSandboxLevel = "none",
  fallbackNetworkFirewall: boolean | undefined = undefined,
):
  | {
      sandboxLevel: SessionSandboxLevel;
      sandboxNetworkFirewall: boolean;
    }
  | { error: string } {
  const sandboxLevel =
    value === undefined || value === null || value === ""
      ? fallbackLevel
      : value;
  if (sandboxLevel !== "none" && sandboxLevel !== "project-write") {
    return { error: 'sandboxLevel must be "none" or "project-write"' };
  }
  if (
    networkFirewall !== undefined &&
    networkFirewall !== null &&
    typeof networkFirewall !== "boolean"
  ) {
    return { error: "sandboxNetworkFirewall must be a boolean" };
  }
  if (sandboxLevel !== "project-write" && networkFirewall === true) {
    return {
      error: "sandboxNetworkFirewall requires sandboxLevel project-write",
    };
  }
  const defaultNetworkFirewall =
    sandboxLevel === fallbackLevel && fallbackNetworkFirewall !== undefined
      ? fallbackNetworkFirewall
      : true;
  return {
    sandboxLevel,
    sandboxNetworkFirewall:
      sandboxLevel === "project-write" &&
      (networkFirewall === undefined || networkFirewall === null
        ? defaultNetworkFirewall
        : networkFirewall),
  };
}

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
