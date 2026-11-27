import type { Stats } from "node:fs";
import type { ProjectScanner } from "../../projects/scanner.js";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { getCodexRolloutFileIdentity } from "../../utils/codexRolloutFiles.js";
import type { CatalogFileLookup, SessionCatalogRow } from "../catalog-types.js";
import { readCodexSessionFile } from "../codex-discovery.js";
import { codexRootFileIndex } from "../codex-root-file-index.js";
import type { createCodexRolloutPathMapper } from "../codex-thread-index.js";
import { locateCodexThread } from "../codex-thread-locator.js";
import { catalogFileVersion, catalogProjectIdentity } from "./row.js";

export interface AddedFile {
  filePath: string;
  sessionId: string;
  projectRow: Readonly<SessionCatalogRow>;
  initialStat?: Stats;
}

export async function newCodexFile(
  store: string,
  filePath: string,
  lookup: CatalogFileLookup,
  scanner: ProjectScanner,
  locatePath: ReturnType<typeof createCodexRolloutPathMapper>,
): Promise<AddedFile | undefined> {
  const id = getCodexRolloutFileIdentity(filePath);
  if (
    !id?.timestamp ||
    id.rolloutId !== id.threadId ||
    !filePath.endsWith(".jsonl")
  )
    return;
  const root = codexRootFileIndex(store);
  const read = root.readVersion();
  const located = await locatePath(filePath);
  if (located.kind !== "active" || located.path !== filePath) return;
  try {
    const initialStat = await stat(filePath);
    const meta = await readCodexSessionFile({
      sessionsDir: store,
      filePath,
    });
    if (
      !meta ||
      meta.id !== id.threadId ||
      meta.isSubagent ||
      !isAbsolute(meta.cwd)
    )
      return;
    const identity = catalogProjectIdentity(meta.cwd);
    const projectRow = lookup.newCodexSessionProject(
      store,
      identity.projectIdentityKey,
      meta.id,
    );
    const project = scanner.retainedFileProject(identity.projectId, "byId");
    if (
      !projectRow?.nativeStorageScope ||
      project?.path !== identity.projectPath ||
      projectRow.projectPath !== identity.projectPath ||
      projectRow.projectId !== identity.projectId
    )
      return;
    // Summary and identity readers resolve by logical thread. Give them the
    // same verified point even when there is no native threads database.
    const elected = await locateCodexThread({
      sessionsDir: store,
      threadId: meta.id,
      readMeta: (path) =>
        path === filePath
          ? Promise.resolve(meta)
          : readCodexSessionFile({ sessionsDir: store, filePath: path }),
    });
    if (
      elected.kind === "found"
        ? elected.session?.filePath !== filePath
        : elected.kind !== "fallback" ||
          !["unavailable", "missing-row"].includes(elected.reason)
    )
      return;
    if (
      !(await sameCodexArrival(
        initialStat,
        store,
        filePath,
        meta.id,
        identity.projectPath,
      )) ||
      !root.observePoints([meta], read) ||
      root.getSession(meta.id)?.filePath !== filePath
    )
      return;
    return {
      sessionId: meta.id,
      filePath,
      projectRow: { ...projectRow, projectName: project.name },
      initialStat,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// An open writer may append between the header and summary reads. Growth
// alone does not prove the header survived a same-inode rewrite.
export async function sameCodexArrival(
  before: Stats,
  store: string,
  filePath: string,
  id: string,
  projectPath: string,
): Promise<boolean> {
  try {
    const now = await stat(filePath);
    if (catalogFileVersion(now) === catalogFileVersion(before)) return true;
    if (
      now.dev !== before.dev ||
      now.ino !== before.ino ||
      now.size <= before.size
    )
      return false;
    const head = await readCodexSessionFile({ sessionsDir: store, filePath });
    const after = await stat(filePath);
    return (
      head?.id === id &&
      !head.isSubagent &&
      catalogProjectIdentity(head.cwd).projectPath === projectPath &&
      after.dev === now.dev &&
      after.ino === now.ino &&
      (after.size > now.size ||
        catalogFileVersion(after) === catalogFileVersion(now))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}
