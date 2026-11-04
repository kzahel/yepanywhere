import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitBlameLine, GitBlameResult } from "@yep-anywhere/shared";
import { highlightFile } from "../highlighting/index.js";
import { createLruMap, refreshLruMap } from "../lib/lruCollections.js";
import type { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import { getGitAuthorIdentity, getGitAuthorPalette } from "./authorPalette.js";
import { GIT_DECODE_PATHS_ARGS, runGit } from "./gitExec.js";
import { readHeadSha } from "./headSha.js";

/**
 * Whole-file `git blame` for the all-files provenance browser (topic:
 * source-review-to-session, stage 3). Each source line gets its originating
 * commit; clicking a line comments into the same review with a `sha` anchor.
 *
 * The highlighted file body is reconstructed from the blame content lines and
 * run through the shared `highlightFile`, so the code column and the blame
 * gutter come from the exact same revision and align line-for-line.
 *
 * Results are cached in one byte-capped LRU so revisiting a recently viewed
 * file is instant (first view pays git blame + highlight, 50-500ms measured).
 * A blame of an explicit commit is a pure function of (commit, path) and needs
 * no validation; a working-tree blame drifts, so its entry is validated by
 * (file mtime, size, HEAD sha) — a stat plus a few ref-file reads per hit, no
 * git process (`readHeadSha`) — and any commit or file edit invalidates it. Entries hold the *final*
 * result (truncated lines + highlight), so the cache, not the raw parse,
 * bounds memory.
 */

const BLAME_MAX_BUFFER = 32 * 1024 * 1024;
const BLAME_TIMEOUT_MS = 15_000;
/** Above this the viewer degrades to blame-only, no highlight, truncated. */
const MAX_BLAME_LINES = 20_000;
/** A hex commit-ish (short or full). */
const SHA_RE = /^[0-9a-f]{4,64}$/i;

/** Total byte budget across all cached results (content + highlight HTML). */
const MAX_BLAME_CACHE_BYTES = 32 * 1024 * 1024;

interface BlameCacheEntry {
  result: GitBlameResult;
  bytes: number;
  /**
   * `${mtimeMs}:${size}:${headSha}` for a working-tree entry; null for an
   * immutable explicit-commit entry.
   */
  validator: string | null;
}

/** Insertion order is LRU order: hits reinsert their key. */
const blameCache = createLruMap<string, BlameCacheEntry>();
let blameCacheBytes = 0;
let blameCacheHits = 0;

export async function getBlame(
  cwd: string,
  path: string,
  rev: string | undefined,
  storagePolicy?: ProjectStoragePolicy,
): Promise<GitBlameResult> {
  // Resolving covers "HEAD" and short shas, so equivalent revs share a key.
  const resolved = rev ? await resolveCommit(cwd, rev) : null;
  const key = resolved
    ? `sha\0${cwd}\0${resolved}\0${path}`
    : `wt\0${cwd}\0${path}`;
  // A null validator on a working-tree request means the file is unstattable
  // or HEAD unresolvable — treated as uncacheable, never as a match.
  const validator = resolved ? null : await worktreeValidator(cwd, path);

  const cached = blameCache.get(key);
  if (
    cached &&
    (resolved ? true : validator !== null) &&
    cached.validator === validator
  ) {
    refreshLruMap(blameCache, key, cached);
    blameCacheHits++;
    // Callers only serialize the result; the cached object is shared, not cloned.
    return cached.result;
  }
  if (cached) {
    blameCache.delete(key);
    blameCacheBytes -= cached.bytes;
  }

  const args = [
    ...GIT_DECODE_PATHS_ARGS,
    "blame",
    "--porcelain",
    ...(rev ? [rev] : []),
    "--",
    path,
  ];
  const [{ stdout }, authorPalette] = await Promise.all([
    runGit(cwd, args, {
      maxBuffer: BLAME_MAX_BUFFER,
      timeout: BLAME_TIMEOUT_MS,
    }),
    getGitAuthorPalette(cwd, storagePolicy),
  ]);
  let parsedLines = parseBlamePorcelain(stdout);

  let truncated = false;
  if (parsedLines.length > MAX_BLAME_LINES) {
    parsedLines = parsedLines.slice(0, MAX_BLAME_LINES);
    truncated = true;
  }
  const lines: GitBlameLine[] = parsedLines.map(
    ({ authorIdentity, ...line }) => {
      const authorColorSeed =
        !line.uncommitted && authorPalette
          ? authorPalette.seeds.get(authorIdentity)
          : undefined;
      return authorColorSeed === undefined
        ? line
        : { ...line, authorColorSeed };
    },
  );

  const result: GitBlameResult = {
    path,
    // The blamed revision as fact, not as request echo: the resolved full sha
    // for an explicit rev, "working-tree" otherwise — never "HEAD", which
    // would misstate a working-tree blame that includes uncommitted lines.
    rev: resolved ?? "working-tree",
    lines,
    truncated,
  };

  if (!truncated) {
    const content = lines.map((l) => l.content).join("\n");
    const highlighted = await highlightFile(content, path);
    if (highlighted) {
      result.highlightedHtml = highlighted.html;
      result.highlightedLanguage = highlighted.language;
      if (highlighted.truncated) result.truncated = true;
    }
  }

  if (resolved || validator !== null) {
    insertBlameCacheEntry(key, {
      result,
      bytes: entryBytes(result),
      validator,
    });
  }

  return result;
}

/**
 * Working-tree cache validator: the blame output is a function of the file's
 * content and the committed history, so (mtime, size, HEAD) drift covers both.
 */
async function worktreeValidator(
  cwd: string,
  path: string,
): Promise<string | null> {
  try {
    const [fileStat, headSha] = await Promise.all([
      stat(join(cwd, path)),
      readHeadSha(cwd),
    ]);
    if (!headSha) return null;
    return `${fileStat.mtimeMs}:${fileStat.size}:${headSha}`;
  } catch {
    return null;
  }
}

/** Approximate retained bytes: UTF-16 strings plus per-line object overhead. */
function entryBytes(result: GitBlameResult): number {
  let bytes = 256 + result.path.length * 2;
  for (const line of result.lines) {
    bytes += line.content.length * 2 + 120;
  }
  bytes += (result.highlightedHtml?.length ?? 0) * 2;
  return bytes;
}

function insertBlameCacheEntry(key: string, entry: BlameCacheEntry): void {
  // Concurrent misses on one key both insert; reclaim the loser's bytes so
  // the budget tracks the map instead of drifting up and over-evicting.
  const existing = blameCache.get(key);
  if (existing) {
    blameCache.delete(key);
    blameCacheBytes -= existing.bytes;
  }
  // An entry too large for the whole budget is served once, never cached.
  if (entry.bytes > MAX_BLAME_CACHE_BYTES) return;
  while (
    blameCacheBytes + entry.bytes > MAX_BLAME_CACHE_BYTES &&
    blameCache.size > 0
  ) {
    const oldest = blameCache.keys().next().value;
    if (oldest === undefined) break;
    blameCacheBytes -= blameCache.get(oldest)?.bytes ?? 0;
    blameCache.delete(oldest);
  }
  blameCache.set(key, entry);
  blameCacheBytes += entry.bytes;
}

/** Test hook: cache observability without exporting the cache itself. */
export function blameCacheStatsForTest(): {
  entries: number;
  bytes: number;
  hits: number;
} {
  return {
    entries: blameCache.size,
    bytes: blameCacheBytes,
    hits: blameCacheHits,
  };
}

/** Test hook: exercise same-key replacement without timing real git children. */
export function insertBlameCacheEntryForTest(key: string, bytes: number): void {
  insertBlameCacheEntry(key, {
    result: {
      path: key,
      rev: "test",
      lines: [],
      truncated: false,
    },
    bytes,
    validator: null,
  });
}

/** Test hook: drop all cached blame state. */
export function resetBlameCacheForTest(): void {
  blameCache.clear();
  blameCacheBytes = 0;
  blameCacheHits = 0;
}

async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  if (rev !== "HEAD" && !SHA_RE.test(rev)) return null;
  try {
    const { stdout } = await runGit(cwd, [
      "rev-parse",
      "--verify",
      `${rev}^{commit}`,
    ]);
    const sha = stdout.trim();
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Parse `git blame --porcelain`: a header `<sha> <origLine> <finalLine>
 * [<count>]` starts each line entry; the full commit metadata (author,
 * author-time, summary) appears only the first time a commit is seen, so it is
 * accumulated into a per-sha map and read back when emitting each line.
 */
interface ParsedGitBlameLine extends GitBlameLine {
  authorIdentity: string;
}

function parseBlamePorcelain(stdout: string): ParsedGitBlameLine[] {
  const rows = stdout.split("\n");
  const meta = new Map<
    string,
    {
      author: string;
      authorEmail: string;
      authorTime: string;
      summary: string;
    }
  >();
  const out: ParsedGitBlameLine[] = [];

  let curSha: string | null = null;
  let curFinalLine = 0;

  for (const row of rows) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(row);
    if (header?.[1] && header[2]) {
      curSha = header[1];
      curFinalLine = Number.parseInt(header[2], 10);
      if (!meta.has(curSha)) {
        meta.set(curSha, {
          author: "",
          authorEmail: "",
          authorTime: "",
          summary: "",
        });
      }
      continue;
    }
    if (curSha === null) continue;

    const entry = meta.get(curSha);
    if (entry) {
      if (row.startsWith("author ")) {
        entry.author = row.slice("author ".length);
      } else if (row.startsWith("author-mail ")) {
        entry.authorEmail = row.slice("author-mail ".length);
      } else if (row.startsWith("author-time ")) {
        entry.authorTime = epochToIso(row.slice("author-time ".length));
      } else if (row.startsWith("summary ")) {
        entry.summary = row.slice("summary ".length);
      }
    }

    if (row.startsWith("\t")) {
      const m = entry ?? {
        author: "",
        authorEmail: "",
        authorTime: "",
        summary: "",
      };
      out.push({
        line: curFinalLine,
        sha: curSha,
        shortSha: curSha.slice(0, 7),
        author: m.author,
        authorIdentity: getGitAuthorIdentity(m.author, m.authorEmail),
        authorTime: m.authorTime,
        summary: m.summary,
        content: row.slice(1),
        uncommitted: /^0+$/.test(curSha),
      });
      curSha = null;
    }
  }

  return out;
}

function epochToIso(value: string): string {
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString();
}
