import type {
  ProviderWorkItem,
  SessionProviderPhase,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { ProviderRetentionSnapshot } from "../sdk/types.js";
import type { EventBus } from "../watcher/EventBus.js";
import type { SessionRuntimeProcess } from "./session-runtime-overlay.js";

/** Work items a session row carries; the full lists stay on liveness. */
const SESSION_PROVIDER_PHASE_WORK_LIMIT = 3;

/** The live-process state a row's provider phase reads. */
export interface SessionProviderPhaseProcess extends SessionRuntimeProcess {
  sessionId: string;
  projectId: UrlProjectId;
  getProviderRetentionSnapshot(): ProviderRetentionSnapshot;
}

function phaseWithWork(
  phase: SessionProviderPhase["phase"],
  items: ProviderWorkItem[] | undefined,
): SessionProviderPhase {
  if (!items?.length) return { phase };
  return {
    phase,
    work: items.slice(0, SESSION_PROVIDER_PHASE_WORK_LIMIT),
    ...(items.length > SESSION_PROVIDER_PHASE_WORK_LIMIT
      ? { workCount: items.length }
      : {}),
  };
}

/**
 * What a session row shows the provider doing, derived only from
 * event-driven state, so no timer is needed to keep it current. Undefined
 * when there is no process, the session waits on the user, or it is idle.
 */
export function sessionProviderPhaseFromProcess(
  process: SessionRuntimeProcess | undefined,
): SessionProviderPhase | undefined {
  if (!process?.getProviderRetentionSnapshot) return undefined;
  const state = process.state.type;
  if (state === "in-turn") {
    const waits = process.getProviderRetentionSnapshot().foregroundWaits;
    return waits?.length
      ? phaseWithWork("waiting", waits)
      : { phase: "generating" };
  }
  if (state === "idle" && process.isRetainingProviderWork()) {
    return phaseWithWork(
      "background",
      process.getProviderRetentionSnapshot().backgroundWork,
    );
  }
  return undefined;
}

interface PublishedPhase {
  state: object;
  key: string;
}

const publishedPhases = new WeakMap<SessionRuntimeProcess, PublishedPhase>();

/**
 * Publish a session's provider phase when a provider snapshot change moved
 * it. A state transition since the last publish always republishes: rows
 * refetched on that transition, so the stored key no longer says what they
 * show. Phase events never carry row activity; consumers of
 * `process-state-changed` are unaffected.
 */
export function publishProviderPhaseChange(
  eventBus: EventBus | undefined,
  process: SessionProviderPhaseProcess,
): void {
  if (!eventBus) return;
  const providerPhase = sessionProviderPhaseFromProcess(process) ?? null;
  const key = JSON.stringify(providerPhase);
  const previous = publishedPhases.get(process);
  if (previous?.state === process.state && previous.key === key) return;
  publishedPhases.set(process, { state: process.state, key });
  eventBus.emit({
    type: "session-provider-phase-changed",
    sessionId: process.sessionId,
    projectId: process.projectId,
    providerPhase,
    timestamp: new Date().toISOString(),
  });
}
