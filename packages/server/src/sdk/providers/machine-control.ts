import { RETIRED_COMPUTER_CONTROL_ERROR } from "../../machine-control/legacy-retirement.js";
import { delimiter, win32 } from "node:path";
import { machineControlInstructions } from "@yep-anywhere/shared/machine-control-instructions";
import {
  findInstalledMachineControl,
  type InstalledMachineControl,
} from "../../machine-control/installation.js";
import { startNativeSudoSession } from "./native-sudo.js";
import type {
  AgentSession,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

export interface MachineControlDependencies {
  platform?: string;
  environment?: NodeJS.ProcessEnv;
  verify?: (
    installation: string,
    publisher: string | undefined,
    platform: NodeJS.Platform,
  ) => Promise<InstalledMachineControl>;
  /** Whether a path is occupied, to tell a failed install from an absent one. */
  exists?: (path: string) => Promise<boolean>;
  /** The operator's setting; defaults to the launch's runtime snapshot. */
  enabledByDefault?: () => boolean;
}

let enabledByDefault = () => false;

/** Wired to the runtime snapshot, so a provider worker sees the setting too. */
export function setMachineControlDefault(getter: () => boolean) {
  enabledByDefault = getter;
}

/** Advertisement is launcher context, never an MC grant or OS containment. */
export async function startMachineControlSession(
  provider: ProviderName,
  options: StartSessionOptions,
  start: (options: StartSessionOptions) => Promise<AgentSession>,
  dependencies: MachineControlDependencies = {},
): Promise<AgentSession> {
  if (options.computerControl) throw new Error(RETIRED_COMPUTER_CONTROL_ERROR);
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const seeded = environment.YEP_MC_CONTROL === "1";
  const defaulted =
    options.machineControl === undefined &&
    (dependencies.enabledByDefault ?? enabledByDefault)();
  const selected = options.machineControl ?? (seeded || defaulted);
  if (
    !selected ||
    !["darwin", "win32", "linux"].includes(platform) ||
    options.executor ||
    options.sessionSandbox ||
    options.sessionSandboxOptions?.level === "project-write" ||
    options.permissionMode === "plan" ||
    !["codex", "claude", "claude-gateway", "claude-ollama"].includes(
      provider,
    ) ||
    (provider === "codex" && options.permissionMode !== "bypassPermissions")
  )
    return start(options);
  let installation: InstalledMachineControl;
  try {
    installation = await findInstalledMachineControl(
      platform,
      environment,
      dependencies.verify,
      dependencies.exists,
    );
  } catch {
    // The setting is a standing default, so a missing or unverified install
    // leaves the launch unadvertised. A choice made for this launch refuses.
    if (defaulted && !seeded) return start(options);
    throw new Error(
      "Configured Machine Control desktop installation is missing, incompatible, or failed publisher/integrity verification",
    );
  }
  const quoted =
    platform === "win32"
      ? `& '${installation.command.replaceAll("'", "''")}'`
      : `'${installation.command.replaceAll("'", "'\\''")}'`;
  const fragment = machineControlInstructions(installation.version, quoted);
  return start({
    ...options,
    ...(provider === "codex"
      ? { machineControlInstructions: fragment }
      : {
          globalInstructions: [options.globalInstructions, fragment]
            .filter(Boolean)
            .join("\n\n"),
        }),
    agentEnvironment: {
      ...options.agentEnvironment,
      ...(platform === "win32"
        ? {
            MACHINE_CONTROL_DESKTOP_INSTALL_DIR: win32.dirname(
              installation.root,
            ),
          }
        : {}),
      PATH: [
        installation.directory,
        options.agentEnvironment?.PATH ?? environment.PATH,
      ]
        .filter(Boolean)
        .join(delimiter),
    },
  });
}

export function startMachineControlToolsSession(
  provider: ProviderName,
  options: StartSessionOptions,
  start: (options: StartSessionOptions) => Promise<AgentSession>,
) {
  return startMachineControlSession(provider, options, (resolved) =>
    startNativeSudoSession(provider, resolved, start),
  );
}
