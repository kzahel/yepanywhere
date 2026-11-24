import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import {
  canonicalizeProjectPath,
  COPILOT_SESSIONS_DIR,
  encodeProjectId,
} from "../projects/paths.js";
import type { ObservedPublicSession } from "../supervisor/ExternalSessionTracker.js";
import type { FileChangeEvent } from "../watcher/EventBus.js";
import {
  locateCopilotTranscript,
  readCopilotTranscriptHead,
} from "./copilot-transcript.js";

export async function resolveCopilotObservedWrite(
  event: FileChangeEvent,
  signal: AbortSignal,
  metadata?: SessionMetadataService,
): Promise<ObservedPublicSession | null> {
  if (event.fileType !== "session" || event.changeType === "delete")
    return null;
  const root = event.nativeStorageScope ?? COPILOT_SESSIONS_DIR;
  const id = basename(dirname(event.path));
  const transcript = await locateCopilotTranscript(root, id);
  if (!transcript || resolve(transcript.path) !== resolve(event.path))
    return null;
  const [scope, head] = await Promise.all([
    realpath(root).catch(() => undefined),
    readCopilotTranscriptHead(transcript.path, id),
  ]);
  if (!scope || !head || signal.aborted) return null;
  const projectId = encodeProjectId(canonicalizeProjectPath(head.cwd));
  if (!metadata) return { sessionId: id, provider: "copilot", projectId };
  const native = nativeSessionRef("copilot", scope, parseNativeSessionId(id));
  const identity = metadata.identities.adoptDiscoveredBatch([
    {
      native,
      provider: "copilot",
      projectId,
      createdAt: new Date(
        head.createdAtMs ?? transcript.stats.mtimeMs,
      ).toISOString(),
    },
  ])[0];
  return identity
    ? { sessionId: identity.sessionId, provider: "copilot", projectId }
    : null;
}
