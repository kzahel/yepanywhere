// Stages an `agy` store's conversations into a probe profile as independent
// regular files, so a census `session/load` can never open, or create
// sidecars beside, a file in the source store. Links in the staged part of
// the source are refused, not followed, and a profile with any entry that
// resolves outside it is refused before `agy` starts.
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/** `dev:ino:size:mtimeMs` without following a final link; null when absent. */
export function identity(path) {
  try {
    const info = lstatSync(path);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** A source path whose every component is a real directory, or a regular
 * file at the end when `kind` is "file". Throws naming any link. */
function checked(root, rel, kind) {
  let path = root;
  const parts = rel.split("/");
  parts.forEach((part, index) => {
    path = join(path, part);
    const info = lstatSync(path);
    const last = index === parts.length - 1;
    if (info.isSymbolicLink())
      throw new Error(`refusing a link in the source store: ${rel}`);
    if (
      last
        ? !(kind === "file" ? info.isFile() : info.isDirectory())
        : !info.isDirectory()
    )
      throw new Error(
        `refusing a non-regular entry in the source store: ${rel}`,
      );
  });
  return path;
}

function copyFile(root, target, rel) {
  const to = join(target, rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(checked(root, rel, "file"), to);
  if (!lstatSync(to).isFile()) throw new Error(`staged ${rel} is not a file`);
}

/** Copies a directory of regular files, or only checks it when `target`
 * is null. */
function copyTree(root, target, rel) {
  checked(root, rel, "dir");
  if (target) mkdirSync(join(target, rel), { recursive: true });
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) copyTree(root, target, child);
    else if (!entry.isFile())
      throw new Error(
        `refusing a link or special file in the source store: ${child}`,
      );
    else if (target) copyFile(root, target, child);
  }
}

/**
 * Copies `files` (each with its `-wal` when present) and `trees`, then
 * compares the source identity of `watched` before and after. A change
 * means the copy may mix two persisted states: `coherent` is false.
 */
function stage(source, target, { files, trees = [], watched }, afterCopy) {
  const root = realpathSync(source);
  // Refuse before copying anything.
  for (const rel of files) {
    checked(root, rel, "file");
    if (identity(join(root, `${rel}-wal`)) !== null)
      checked(root, `${rel}-wal`, "file");
  }
  for (const rel of trees) copyTree(root, null, rel);
  const before = watched.map((rel) => identity(join(root, rel)));
  for (const rel of [...files, ...trees])
    rmSync(join(target, rel), { force: true, recursive: true });
  for (const rel of files) {
    rmSync(join(target, `${rel}-wal`), { force: true });
    rmSync(join(target, `${rel}-shm`), { force: true });
    copyFile(root, target, rel);
    if (identity(join(root, `${rel}-wal`)) !== null)
      copyFile(root, target, `${rel}-wal`);
  }
  for (const rel of trees) copyTree(root, target, rel);
  afterCopy?.();
  const after = watched.map((rel) => identity(join(root, rel)));
  return { coherent: before.every((value, index) => value === after[index]) };
}

const log = (id) => `brain/${id}/.system_generated/logs/transcript_full.jsonl`;

/** The summaries index and its WAL. */
export function stageSummaries(source, target, afterCopy) {
  const db = "conversation_summaries.db";
  return stage(
    source,
    target,
    { files: [db], watched: [db, `${db}-wal`] },
    afterCopy,
  );
}

/** One conversation: its database and WAL, and its brain directory. */
export function stageConversation(source, target, id, afterCopy) {
  const db = `conversations/${id}.db`;
  return stage(
    source,
    target,
    {
      files: [db],
      trees: [`brain/${id}`],
      watched: [db, `${db}-wal`, log(id)],
    },
    afterCopy,
  );
}

/** Throws if anything under `root` is a link that resolves outside it. */
export function assertContained(root) {
  const base = realpathSync(root);
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        let resolved;
        try {
          resolved = realpathSync(child);
        } catch {
          throw new Error(
            `refusing an unresolvable link in the profile: ${child}`,
          );
        }
        const rel = relative(base, resolved);
        if (rel.startsWith("..") || isAbsolute(rel))
          throw new Error(
            `refusing a link that leaves the profile: ${child} -> ${resolved}`,
          );
      } else if (entry.isDirectory()) walk(child);
    }
  };
  walk(base);
}
