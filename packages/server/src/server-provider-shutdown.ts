import { ClaudeGatewayProvider } from "./sdk/providers/claude-gateway.js";
import { retainProviderRuntimeProcessGroup } from "./sdk/providers/provider-runtime-host.js";
import { hasHostedProviderRuntime } from "./sdk/providers/provider-runtime-host.js";
import type { QueueRestartHandoff } from "./services/QueueRestartHandoff.js";
import type { Process } from "./supervisor/Process.js";
import type { Supervisor } from "./supervisor/Supervisor.js";

/** Return false whenever shutdown interrupts work or cannot prove owner release. */
export async function shutdownProviderSessions(
  signal: string,
  supervisor: Supervisor | null,
  handoff: QueueRestartHandoff | undefined,
): Promise<boolean> {
  if (!supervisor) return false;
  await supervisor.stopBackgroundTasks();
  let orderly = true;
  try {
    await Promise.all(
      supervisor
        .getAllProcesses()
        .map((p) => p.waitForPatientQueuePersistenceIdle()),
    );
    await handoff?.prepare(supervisor.getAllProcesses());
  } catch (error) {
    orderly = false;
    console.error("[QueueRestart] Could not prepare queue handoff:", error);
  }
  const processes = supervisor.getAllProcesses();
  if (supervisor.getWorkerActivity().queueLength > 0) orderly = false;
  // Inspect before teardown changes a busy owner into an apparently idle one.
  for (const p of processes) {
    if (!canReleaseWithoutInterruption(signal, p)) orderly = false;
  }
  if (processes.length > 0)
    console.log(`[Shutdown] Aborting ${processes.length} active session(s)...`);
  await Promise.all(
    processes.map(async (p) => {
      try {
        // Persist current controls for both retained workers and cold resumes.
        await supervisor.prepareForServerReload(p);
        handoff?.rememberPatientQueues([p]);
        if (!canReleaseWithoutInterruption(signal, p)) orderly = false;
        if (
          signal === "SIGHUP" &&
          hasHostedProviderRuntime(p.sessionId) &&
          p.canDetachForServerReload()
        ) {
          await p.detachForServerReload();
          console.log(
            `[Shutdown] Detached ${p.provider} session ${p.sessionId}`,
          );
        } else {
          const stopped = await p.abort();
          if (!stopped.verifiedStopped) orderly = false;
          console.log(`[Shutdown] Aborted session ${p.sessionId}`);
        }
        await p.waitForPatientQueuePersistenceIdle();
      } catch (error) {
        orderly = false;
        // A failed configuration save must still stop the owner.
        await p.abort().catch(() => undefined);
        console.error(
          `[Shutdown] Error aborting session ${p.sessionId}:`,
          error,
        );
      }
    }),
  );
  return orderly;
}

export async function shutdownOwnedGateway(signal: string): Promise<boolean> {
  let verified = true;
  let retainedGateway = false;
  if (signal === "SIGHUP") {
    const retentions =
      await ClaudeGatewayProvider.retainOwnedGatewayProcessGroups(
        retainProviderRuntimeProcessGroup,
      );
    for (const retention of retentions) {
      if (retention.error) {
        verified = false;
        console.error(
          `[Shutdown] Could not retain managed Claude Gateway process group ${retention.processGroupId}:`,
          retention.error,
        );
      } else if (retention.relinquished) {
        console.log(
          `[Shutdown] Managed Claude Gateway process group ${retention.processGroupId} retained by wrapper`,
        );
      }
    }
    // Stop the gateway unless every service handed its child over: a child
    // that stayed owned here is still this process's to kill.
    retainedGateway =
      retentions.length > 0 &&
      retentions.every((retention) => retention.relinquished);
  }
  if (!retainedGateway) {
    try {
      await ClaudeGatewayProvider.shutdownGateway();
      console.log("[Shutdown] Managed Claude Gateway stopped");
    } catch (error) {
      verified = false;
      console.error("[Shutdown] Error stopping managed Claude Gateway:", error);
    }
  }

  return verified;
}

function canReleaseWithoutInterruption(signal: string, p: Process): boolean {
  if (p.queueDepth > 0 || p.hasVolatileDeferredMessages()) return false;
  if (
    signal === "SIGHUP" &&
    hasHostedProviderRuntime(p.sessionId) &&
    p.canDetachForServerReload()
  )
    return true;
  const retention = p.getProviderRetentionSnapshot();
  return (
    !retention.backgroundWork?.length &&
    !retention.foregroundWaits?.length &&
    !retention.backgroundTaskCount &&
    !retention.sessionCronCount &&
    !retention.liveTaskCount &&
    p.state.type !== "in-turn" &&
    p.state.type !== "waiting-input" &&
    !p.queuedCompactionBlocksInput &&
    !p.isRetainingProviderWork() &&
    p.getLivenessSnapshot().derivedStatus === "verified-idle"
  );
}
