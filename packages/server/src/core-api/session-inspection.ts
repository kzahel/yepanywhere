import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import {
  sessionInspectionSchema,
  type ApiSessionInspection,
} from "./selection-contracts.js";

/** Cheap observations only, acquired after the session resource is authorized. */
export function inspectApiSession(
  sessionId: string,
  metadata: Pick<SessionMetadataService, "getMetadata"> | undefined,
  supervisor: Pick<Supervisor, "getProcessForSession"> | undefined,
): ApiSessionInspection {
  const saved = metadata?.getMetadata(sessionId);
  const settings = saved?.effectiveLaunchSettings;
  const candidate = supervisor?.getProcessForSession(sessionId);
  const live = candidate && !candidate.isTerminated ? candidate : undefined;
  const binding = saved?.routerBinding;
  return sessionInspectionSchema.parse({
    settings: {
      source: live ? "live" : settings ? "saved" : "unavailable",
      requestedModel: live
        ? (live.requestedModel ?? null)
        : (settings?.requestedModel ?? null),
      model: live?.resolvedModel ?? null,
      thinking: live ? (live.thinking ?? null) : (settings?.thinking ?? null),
      effort: live ? (live.appliedEffort ?? null) : (settings?.effort ?? null),
      permissionMode: live
        ? live.permissionMode
        : (settings?.permissionMode ?? null),
      serviceTier: live
        ? (live.serviceTier ?? null)
        : (settings?.serviceTier ?? null),
      ...(settings ? { revision: settings.revision } : {}),
    },
    // The pin's labels are saved observations; inspecting never refreshes AAR.
    routing: binding
      ? { ...binding, mode: "aar" }
      : { mode: saved || live ? "direct" : "unknown" },
  });
}
