import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { antigravityWriteIsOwn } from "../sdk/providers/antigravity-owners.js";
import type { ObservedPublicSession } from "../supervisor/ExternalSessionTracker.js";
import type { ResolvedSessionFile } from "../watcher/FocusedSessionWatchManager.js";
import type { FileChangeEvent } from "../watcher/EventBus.js";
import {
  ANTIGRAVITY_SESSION_ID,
  readAntigravityMetadata,
} from "./antigravity-metadata.js";
import { openPhysicalBrainTranscript } from "./antigravity-subagent-links.js";

const ID = ANTIGRAVITY_SESSION_ID.source.slice(1, -1);
const DATABASE = new RegExp(`^(?:conversations/)?(${ID})\\.db(-wal)?$`, "i");
const LOG = new RegExp(
  `/brain/(${ID})/\\.system_generated/logs/transcript_full\\.jsonl$`,
  "i",
);

/**
 * Whether a native file event shows something wrote one conversation, and
 * which (plan 195 step 7). Every `agy` step writes the conversation's WAL
 * within a few milliseconds of its log record, and closing checkpoints the
 * database (measured on 1.5.13 and 1.5.14), so these are evidence: its
 * database changing, its WAL growing past empty, and its log changing (the
 * log is watched only for a conversation open in a client). Not evidence: a
 * 0-byte WAL or the shared-memory file (any SQLite open creates them, `agy`'s
 * resume and load included), a deletion (a writer closing), and the
 * store-wide summaries index, which every conversation's writer changes. A
 * focused watch's database and WAL target, before the log exists, refreshes
 * the page only: its events carry absolute paths and the root watcher
 * reports the same files.
 */
export function antigravityWriteEvidence(
  event: FileChangeEvent,
): { scopeDir: string; id: string } | undefined {
  if (
    event.provider !== "antigravity" ||
    event.changeType === "delete" ||
    event.mtimeMs === undefined ||
    event.size === undefined
  )
    return undefined;
  const relative = event.relativePath.replace(/\\/g, "/");
  const database = DATABASE.exec(relative);
  if (database && event.nativeStorageScope) {
    if (database[2] && event.size === 0) return undefined;
    return {
      scopeDir: relative.startsWith("conversations/")
        ? join(event.nativeStorageScope, "conversations")
        : event.nativeStorageScope,
      id: database[1]!.toLowerCase(),
    };
  }
  const log = LOG.exec(event.path.replace(/\\/g, "/"));
  if (log && event.size > 0) {
    // <store>/brain/<id>/.system_generated/logs/transcript_full.jsonl
    const store = dirname(dirname(dirname(dirname(dirname(event.path)))));
    return {
      scopeDir: join(store, "conversations"),
      id: log[1]!.toLowerCase(),
    };
  }
  return undefined;
}

/**
 * The public session a write by another program belongs to, or null when
 * the event is not evidence of one: YA's own `agy` made it, the file is
 * not one conversation's, or the conversation is a child or unlisted.
 * While YA's owner holds the conversation every change is taken as its
 * own (ownership stays YA's while its process lives). Reads file facts and
 * the summaries index only, never the conversation's database or the log's
 * content.
 */
export async function resolveAntigravityObservedWrite(
  event: FileChangeEvent,
  signal: AbortSignal,
  deps: {
    sessionMetadataService?: SessionMetadataService;
    scanner: Pick<ProjectScanner, "getOrCreateProject">;
  },
): Promise<ObservedPublicSession | null> {
  const evidence = antigravityWriteEvidence(event);
  if (!evidence) return null;
  const scope = await realpath(evidence.scopeDir).catch(() => null);
  if (!scope || signal.aborted) return null;
  if (antigravityWriteIsOwn(scope, evidence.id, event.mtimeMs!)) return null;
  const metadata = await readAntigravityMetadata(scope, evidence.id).catch(
    () => null,
  );
  if (!metadata || metadata.isChild || signal.aborted) return null;
  const projectId = toUrlProjectId(metadata.cwd);
  const identities = deps.sessionMetadataService?.identities;
  if (!identities)
    return { sessionId: evidence.id, projectId, provider: "antigravity" };
  const native = nativeSessionRef(
    "antigravity",
    scope,
    parseNativeSessionId(evidence.id),
  );
  let identity = identities.lookupNative(native);
  if (!identity) {
    if (
      !identities.canDiscoverNative(native) ||
      identities.resolveYa(parseYaSessionId(evidence.id))
    )
      return null;
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project || signal.aborted) return null;
    identity = identities.adoptDiscoveredBatch([
      {
        native,
        provider: "antigravity",
        projectId: project.id,
        createdAt: new Date(
          metadata.info.birthtimeMs || metadata.info.mtimeMs,
        ).toISOString(),
      },
    ])[0];
    if (!identity) return null;
  }
  return {
    sessionId: identity.sessionId,
    provider: identity.provider,
    projectId:
      deps.sessionMetadataService?.getMetadata(identity.sessionId)
        ?.workingProjectId ?? identity.projectId,
  };
}

/**
 * What an open client's focused watch follows for a conversation: its log,
 * which its pages are read from, so a log append refreshes a stopped page;
 * or, before the log exists, its database and WAL. One per open view.
 */
export async function antigravityFocusedFile(
  databasePath: string,
): Promise<ResolvedSessionFile> {
  const opened = await openPhysicalBrainTranscript(
    dirname(databasePath),
    basename(databasePath, ".db"),
    "transcript_full.jsonl",
  ).catch(() => undefined);
  if (opened?.status === "ok") {
    await opened.handle.close().catch(() => {});
    return { filePath: opened.path, provider: "antigravity" };
  }
  return {
    filePath: databasePath,
    additionalFilePaths: [`${databasePath}-wal`],
    provider: "antigravity",
  };
}
