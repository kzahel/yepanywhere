import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runGit, runGitBytes } from "../git/gitExec.js";
import type { ProjectDirectoryStorage } from "../services/ServerSettingsService.js";
import { syncDirectory } from "../utils/syncDirectory.js";
import { ensureManagedProjectDir } from "./managedProjectDir.js";

const PROJECT_STORAGE_TRANSITION_VERSION = 1;
const PROJECT_STORAGE_TRANSITION_FILENAME = "project-storage-transition.json";

export interface ProjectStorageTransitionParticipant {
  /** Hold mutable operations while the destination is prepared and committed. */
  withStorageTransition<T>(
    targetMode: ProjectDirectoryStorage,
    commit: () => Promise<T>,
  ): Promise<T>;
}

interface ProjectStorageTransitionJournal {
  version: typeof PROJECT_STORAGE_TRANSITION_VERSION;
  id: string;
  sourceMode: ProjectDirectoryStorage;
  targetMode: ProjectDirectoryStorage;
}

export interface ProjectStoragePolicyOptions {
  dataDir: string;
  getMode: () => ProjectDirectoryStorage;
  runGit?: ProjectStorageGitRunner;
}

export type ProjectStorageGitRunner = (
  projectPath: string,
  args: readonly string[],
  output: "text" | "buffer",
) => Promise<string | Buffer>;

/** Resolve all YA-owned project state through one explicit storage policy. */
export class ProjectStoragePolicy {
  readonly dataDir: string;
  private readonly getModeValue: () => ProjectDirectoryStorage;
  private readonly runGit: ProjectStorageGitRunner;
  private readonly transitionParticipants =
    new Set<ProjectStorageTransitionParticipant>();
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(options: ProjectStoragePolicyOptions) {
    this.dataDir = resolve(options.dataDir);
    this.getModeValue = options.getMode;
    this.runGit = options.runGit ?? runProjectStorageGit;
  }

  get mode(): ProjectDirectoryStorage {
    return this.getModeValue() === "project" ? "project" : "app-data";
  }

  projectRoot(projectPath: string): string {
    return join(projectPath, ".yep");
  }

  appDataRoot(projectPath: string): string {
    return join(this.dataDir, "projects", projectStorageKey(projectPath));
  }

  rootForMode(projectPath: string, mode: ProjectDirectoryStorage): string {
    return mode === "project"
      ? this.projectRoot(projectPath)
      : this.appDataRoot(projectPath);
  }

  writePathFor(
    mode: ProjectDirectoryStorage,
    projectPath: string,
    ...segments: string[]
  ): string {
    return containedPath(this.rootForMode(projectPath, mode), segments);
  }

  writePath(projectPath: string, ...segments: string[]): string {
    return this.writePathFor(this.mode, projectPath, ...segments);
  }

  /** Create only the requested write location. Reads never call this method. */
  async ensureWriteDirectoryFor(
    mode: ProjectDirectoryStorage,
    projectPath: string,
    ...segments: string[]
  ): Promise<string> {
    if (mode === "project") {
      const root = this.projectRoot(projectPath);
      const directory = containedPath(root, segments);
      await assertNoSymlinkComponents(resolve(projectPath), directory);
      await assertProjectRootUntracked(projectPath, this.runGit);
      await ensureManagedProjectDir(projectPath, ".yep", ...segments);
      await assertContainedDirectory(projectPath, directory);
      return directory;
    }
    const directory = containedPath(this.appDataRoot(projectPath), segments);
    await assertNoSymlinkComponents(this.dataDir, directory);
    await mkdir(directory, { recursive: true });
    await assertContainedDirectory(this.dataDir, directory);
    return directory;
  }

  async ensureWriteDirectory(
    projectPath: string,
    ...segments: string[]
  ): Promise<string> {
    return this.ensureWriteDirectoryFor(this.mode, projectPath, ...segments);
  }

  async ensureParentForWriteFor(
    mode: ProjectDirectoryStorage,
    projectPath: string,
    ...segments: string[]
  ): Promise<string> {
    const filePath = this.writePathFor(mode, projectPath, ...segments);
    await this.ensureWriteDirectoryFor(
      mode,
      projectPath,
      ...segments.slice(0, Math.max(0, segments.length - 1)),
    );
    await mkdir(dirname(filePath), { recursive: true });
    return filePath;
  }

  async ensureParentForWrite(
    projectPath: string,
    ...segments: string[]
  ): Promise<string> {
    return this.ensureParentForWriteFor(this.mode, projectPath, ...segments);
  }

  /** Selected location first, then the other location for read compatibility. */
  readPaths(projectPath: string, ...segments: string[]): string[] {
    const selected = this.writePath(projectPath, ...segments);
    const alternate = this.writePathFor(
      this.mode === "project" ? "app-data" : "project",
      projectPath,
      ...segments,
    );
    return selected === alternate ? [selected] : [selected, alternate];
  }

  registerTransitionParticipant(
    participant: ProjectStorageTransitionParticipant,
  ): () => void {
    this.transitionParticipants.add(participant);
    return () => this.transitionParticipants.delete(participant);
  }

  transitionJournalPath(): string {
    return join(this.dataDir, PROJECT_STORAGE_TRANSITION_FILENAME);
  }

  /** Journal, reconcile, then durably publish one global mode transition. */
  transitionMode<T>(
    targetMode: ProjectDirectoryStorage,
    commit: () => Promise<T>,
  ): Promise<T> {
    const operation = this.transitionTail.then(() =>
      this.runModeTransition(targetMode, commit),
    );
    this.transitionTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async runModeTransition<T>(
    targetMode: ProjectDirectoryStorage,
    commit: () => Promise<T>,
  ): Promise<T> {
    const sourceMode = this.mode;
    if (targetMode === sourceMode) return commit();

    await this.recoverTransitionJournal();
    const journal: ProjectStorageTransitionJournal = {
      version: PROJECT_STORAGE_TRANSITION_VERSION,
      id: randomUUID(),
      sourceMode,
      targetMode,
    };
    await writeAtomicJson(this.transitionJournalPath(), journal);

    const participants = [...this.transitionParticipants];
    let reconcileAndCommit = commit;
    for (const participant of participants.reverse()) {
      const next = reconcileAndCommit;
      reconcileAndCommit = () =>
        participant.withStorageTransition(targetMode, next);
    }

    const result = await reconcileAndCommit();
    if (this.mode !== targetMode) {
      throw new Error(
        "Project storage mode did not commit the requested target",
      );
    }
    await removeTransitionJournal(this.transitionJournalPath()).catch(
      (error) => {
        console.warn(
          "[ProjectStoragePolicy] Could not clear completed transition journal:",
          error,
        );
      },
    );
    return result;
  }

  private async recoverTransitionJournal(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.transitionJournalPath(), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const journal = parseTransitionJournal(JSON.parse(raw));
    if (this.mode !== journal.sourceMode && this.mode !== journal.targetMode) {
      throw new Error("Project storage transition journal has invalid modes");
    }
    await removeTransitionJournal(this.transitionJournalPath());
  }
}

function parseTransitionJournal(
  value: unknown,
): ProjectStorageTransitionJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project storage transition journal is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== PROJECT_STORAGE_TRANSITION_VERSION ||
    typeof record.id !== "string" ||
    (record.sourceMode !== "app-data" && record.sourceMode !== "project") ||
    (record.targetMode !== "app-data" && record.targetMode !== "project") ||
    record.sourceMode === record.targetMode
  ) {
    throw new Error("Project storage transition journal is invalid");
  }
  return {
    version: PROJECT_STORAGE_TRANSITION_VERSION,
    id: record.id,
    sourceMode: record.sourceMode,
    targetMode: record.targetMode,
  };
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf-8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, filePath);
    published = true;
    await syncDirectory(dirname(filePath));
  } finally {
    if (!published) {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

async function removeTransitionJournal(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await syncDirectory(dirname(filePath));
}

export function projectStorageKey(projectPath: string): string {
  return createHash("sha256")
    .update(resolve(projectPath))
    .digest("hex")
    .slice(0, 32);
}

function containedPath(root: string, segments: readonly string[]): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...segments);
  const relativePath = relative(resolvedRoot, target);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Project storage path escaped its managed root");
  }
  return target;
}

async function assertNoSymlinkComponents(
  containingDirectory: string,
  target: string,
): Promise<void> {
  const relativePath = relative(resolve(containingDirectory), resolve(target));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Project storage path escaped its containing directory");
  }
  let current = resolve(containingDirectory);
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing symlinked project storage path: ${current}`);
    }
  }
}

async function assertContainedDirectory(
  containingDirectory: string,
  directory: string,
): Promise<void> {
  await assertNoSymlinkComponents(containingDirectory, directory);
  const [resolvedContaining, resolvedDirectory] = await Promise.all([
    realpath(containingDirectory),
    realpath(directory),
  ]);
  const relativePath = relative(resolvedContaining, resolvedDirectory);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Project storage directory escaped its containing root");
  }
}

async function runProjectStorageGit(
  projectPath: string,
  args: readonly string[],
  output: "text" | "buffer",
): Promise<string | Buffer> {
  if (output === "buffer") {
    const { stdout } = await runGitBytes(projectPath, args, { timeout: 5000 });
    return stdout;
  }
  const { stdout } = await runGit(projectPath, args, { timeout: 5000 });
  return stdout;
}

function isConfirmedNonGitProject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as { code?: string | number; stderr?: unknown };
  return (
    failure.code === 128 &&
    String(failure.stderr).toLowerCase().includes("not a git repository")
  );
}

async function assertProjectRootUntracked(
  projectPath: string,
  runGit: ProjectStorageGitRunner,
): Promise<void> {
  let inside: string | Buffer;
  try {
    inside = await runGit(
      projectPath,
      ["rev-parse", "--is-inside-work-tree"],
      "text",
    );
  } catch (error) {
    if (isConfirmedNonGitProject(error)) return;
    throw new Error("Could not verify project storage Git state", {
      cause: error,
    });
  }
  if (inside.toString().trim() !== "true") return;

  let tracked: string | Buffer;
  try {
    tracked = await runGit(
      projectPath,
      ["ls-files", "-z", "--", ".yep"],
      "buffer",
    );
  } catch (error) {
    throw new Error("Could not verify whether the .yep root is tracked", {
      cause: error,
    });
  }
  if (tracked.length > 0) {
    throw new Error("Refusing YA-managed writes into a tracked .yep root");
  }
}
