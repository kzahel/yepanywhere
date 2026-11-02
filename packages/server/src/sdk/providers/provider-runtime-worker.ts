import "../../startupEnv.js";
import type { PermissionMode } from "@yep-anywhere/shared";
import { nativeSessionFamily } from "@yep-anywhere/shared";
import { prepareSessionSandbox } from "../../session-sandbox.js";
import { getModuleEnv } from "../../yaModuleEnv.js";
import {
  copyAgentctlBashEnvInto,
  createAgentctlSessionEnvBridge,
  pickStaticAgentEnvironment,
} from "./agentctl-session-env.js";
import { ClaudeGatewayProvider } from "./claude-gateway.js";
import { getRawProvider, type ProviderRuntimeSnapshot } from "./index.js";
import { applyProviderRuntimeSnapshot } from "./provider-runtime-snapshot.js";
import { ProviderRuntimeSocketAdapter } from "./provider-runtime-socket-adapter.js";
import {
  ProviderSessionOwner,
  providerSessionErrorMessage,
} from "./provider-session-owner.js";
import type { ProviderName, StartSessionOptions } from "./types.js";
import { withInstructionRestoration } from "./instruction-restoration.js";

interface WorkerLaunchRequest {
  creation?: unknown;
  providerName: ProviderName;
  options: StartSessionOptions & {
    browserDebugEnvironment?: Record<string, string>;
  };
  runtimeConfig: ProviderRuntimeSnapshot;
}

async function readLaunchRequest(): Promise<WorkerLaunchRequest> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const parsed = JSON.parse(input) as WorkerLaunchRequest;
  if (!parsed || typeof parsed.providerName !== "string") {
    throw new Error("Provider worker received an invalid launch request");
  }
  return parsed;
}

async function main(): Promise<void> {
  const workerEnv = getModuleEnv("provider-worker");
  const socketPath = workerEnv.SOCKET;
  const token = workerEnv.TOKEN;
  const runtimeId = workerEnv.RUNTIME_ID;
  if (!socketPath || !token || !runtimeId) {
    throw new Error("Provider worker environment is incomplete");
  }

  let adapter: ProviderRuntimeSocketAdapter | null = null;
  let owner: ProviderSessionOwner;
  let terminalShutdownPromise: Promise<void> | null = null;
  let exitCode = 0;
  const terminalShutdown = (reason: string, requestedExitCode = 0) => {
    exitCode = Math.max(exitCode, requestedExitCode);
    if (terminalShutdownPromise) return terminalShutdownPromise;
    terminalShutdownPromise = (async () => {
      await owner.shutdown(reason).catch(() => {
        exitCode = 1;
      });
      await adapter?.close().catch(() => {
        exitCode = 1;
      });
      process.exit(exitCode);
    })();
    return terminalShutdownPromise;
  };
  owner = new ProviderSessionOwner({
    runtimeId,
    emitSupervisor: (message) => {
      if (typeof process.send === "function" && process.connected) {
        process.send(message);
      }
    },
    onTerminal: terminalShutdown,
  });
  adapter = new ProviderRuntimeSocketAdapter(socketPath, token, owner);

  process.on("message", (message: unknown) => {
    owner.handleSupervisorMessage(message);
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "shutdown"
    ) {
      void terminalShutdown(
        "reason" in message ? String(message.reason) : "runtime host shutdown",
      );
    }
  });
  process.on("disconnect", () => {
    void terminalShutdown("runtime host IPC closed");
  });
  process.on("SIGINT", () => {
    void terminalShutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void terminalShutdown("SIGTERM");
  });

  try {
    // Sent before reading launch input or preparing any provider resources.
    // Managed creation support is advertised only after its owner is qualified.
    if (typeof process.send === "function" && process.connected) {
      process.send({ type: "launchHello", protocolVersion: 1, features: [] });
    }
    const request = await readLaunchRequest();
    if (request.creation !== undefined)
      owner.setCreationIdentity(request.creation);
    const creation = owner.creationEvidence()?.identity;
    if (
      creation &&
      (nativeSessionFamily(request.providerName) !==
        creation.nativeNamespace.family ||
        request.options.newSessionId !== creation.nativeSessionId ||
        request.options.resumeSessionId !== undefined ||
        (request.options.initialMessage !== undefined &&
          request.options.initialMessage.uuid !== creation.initialInputId))
    )
      throw new Error("Creation identity does not match provider launch");
    owner.setIssuedPeerGrantId(request.options.agentApi?.peerGrantId);
    const {
      browserDebugEnvironment: initialBrowserDebugEnvironment,
      ...providerOptions
    } = request.options;
    const metadata = await owner.start(async (hooks) => {
      await applyProviderRuntimeSnapshot(request.runtimeConfig);
      const provider = getRawProvider(request.providerName);
      if (!provider)
        throw new Error(`Unknown provider ${request.providerName}`);
      if (creation) {
        const namespace = await provider.getNewSessionNamespace?.(
          providerOptions.cwd,
        );
        if (
          !namespace ||
          namespace.family !== creation.nativeNamespace.family ||
          namespace.storageScope !== creation.nativeNamespace.storageScope
        )
          throw new Error(
            "Creation native namespace does not match this worker",
          );
      }
      if (request.providerName === "claude-gateway") {
        await provider.getAvailableModels();
        await ClaudeGatewayProvider.retainOwnedGatewayProcessGroups(
          (processGroupId) => {
            // A worker with no live channel still gives the child up: the
            // gateway is a shared service that has to outlive this session
            // either way, and killing it on this worker's exit is worse than
            // the runtime host not knowing about it.
            if (typeof process.send === "function" && process.connected) {
              process.send({ type: "retainedProcessGroup", processGroupId });
            }
          },
        );
      }

      const sandboxOptions = providerOptions.sessionSandboxOptions;
      if (
        sandboxOptions &&
        sandboxOptions.provider !== request.providerName &&
        !(
          sandboxOptions.provider === "gemini" &&
          request.providerName === "gemini-acp"
        )
      ) {
        throw new Error(
          "Provider worker sandbox request has the wrong provider",
        );
      }
      const sessionSandbox = sandboxOptions
        ? await prepareSessionSandbox(sandboxOptions)
        : undefined;
      const agentctlSessionEnvBridge = createAgentctlSessionEnvBridge(
        creation?.sessionId ?? providerOptions.resumeSessionId,
        () => ({ ...hooks.getBrowserDebugEnvironment() }),
      );
      copyAgentctlBashEnvInto(process.env, agentctlSessionEnvBridge, {
        sessionId: creation?.sessionId ?? providerOptions.resumeSessionId,
      });
      try {
        const session = await provider.startSession({
          ...providerOptions,
          ...(creation ? { publicSessionId: creation.sessionId } : {}),
          getSessionChildEnv: () => ({
            ...hooks.getBrowserDebugEnvironment(),
          }),
          sessionSandbox,
          sessionSandboxOptions: undefined,
          onToolApproval: hooks.onToolApproval,
          onAgentApiRead: hooks.onAgentApiRead,
          shouldEmitLiveDeltas: hooks.shouldEmitLiveDeltas,
          onPermissionModeApplied: (mode: PermissionMode) =>
            hooks.onPermissionModeApplied(mode),
          onProviderRetentionChange: hooks.onProviderRetentionChange,
        });
        return {
          session: withInstructionRestoration(session, {
            ...providerOptions,
            sessionSandbox,
          }),
          agentctlSessionEnvBridge,
          sandbox: sessionSandbox
            ? {
                enforcement: sessionSandbox.enforcement,
                stateKey: sessionSandbox.stateKey,
                projectPath: sessionSandbox.projectPath,
              }
            : undefined,
        };
      } catch (error) {
        agentctlSessionEnvBridge.cleanup();
        throw error;
      }
    }, pickStaticAgentEnvironment(initialBrowserDebugEnvironment));
    await adapter.listen();
    owner.begin();
    if (typeof process.send === "function" && process.connected) {
      process.send({
        type: "ready",
        providerPid: owner.providerPid(),
        metadata,
      });
    }
  } catch (error) {
    if (typeof process.send === "function" && process.connected) {
      process.send({
        type: "startupError",
        error: providerSessionErrorMessage(error),
      });
    }
    await owner.shutdown("provider worker startup failed").catch(() => {});
    await adapter.close().catch(() => {});
    throw error;
  }
}

void main().catch((error) => {
  process.stderr.write(
    `[ProviderRuntimeWorker] ${providerSessionErrorMessage(error)}\n`,
  );
  process.exit(1);
});
