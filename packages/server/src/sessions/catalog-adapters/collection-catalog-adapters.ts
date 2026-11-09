import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { parseNativeSessionId } from "@yep-anywhere/shared";
import type { ProjectScanner } from "../../projects/scanner.js";
import type { Project } from "../../supervisor/types.js";
import { getCodexRolloutActivityTimeMs } from "../../utils/codexRolloutFiles.js";
import { buildProviderProjectCatalog } from "../../routes/provider-catalog.js";
import {
  providerResolutionDeps,
  type SessionProviderResolutionDeps,
} from "../../routes/session-provider-resolution.js";
import {
  getSessionSources,
  type SessionSource,
} from "../provider-resolution.js";
import {
  providerCatalogFamily,
  type ProviderCatalogFamily,
} from "../provider-catalog-family.js";
import {
  type NativeSessionCatalogAdapter,
  SESSION_CATALOG_TITLE_MAX_LENGTH,
  type SessionCatalogRow,
  sessionCatalogRowKey,
} from "../catalog-types.js";
import { toSessionListSummary } from "../types.js";
import {
  readClaudeCatalogHead,
  readClaudeCatalogTail,
} from "../claude-summary.js";
import {
  nativeCatalogAdapters,
  type NativeCatalogOptions,
} from "./native-catalog-registry.js";
import {
  catalogAdaptersForRows,
  catalogFileVersion,
  catalogProjectIdentity,
} from "./row.js";

/**
 * Version of the facts `readFileRow` stores. Bump it whenever a stored fact is
 * added or changed. Rows without it predate the untruncated title and the
 * summary's creation time; format 1 rows lack the last human turn and, for a
 * Claude session without a cached summary, its creation time. Both are read
 * once more. Format 4 also requires native-root facts for Gemini rows.
 */
const FILE_ROW_FORMAT = 4;

export interface CollectionCatalogDeps
  extends SessionProviderResolutionDeps,
    NativeCatalogOptions {
  scanner: ProjectScanner;
  getCatalogFamilies: () => readonly ProviderCatalogFamily[];
}

async function sessionFiles(source: SessionSource) {
  if (source.reader.listSessionFiles)
    return source.reader.listSessionFiles(source.sessionDir);
  try {
    return (await readdir(source.sessionDir))
      .filter((name) => name.endsWith(".jsonl") && !name.startsWith("agent-"))
      .map((name) => ({
        sessionId: name.slice(0, -6),
        filePath: join(source.sessionDir, name),
      }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readFileRow(
  deps: CollectionCatalogDeps,
  project: Project,
  source: SessionSource,
  file: { sessionId: string; filePath: string },
  old?: Readonly<SessionCatalogRow>,
): Promise<SessionCatalogRow | undefined> {
  const family = providerCatalogFamily(source.provider);
  try {
    const stats = await stat(file.filePath);
    const sourceVersion = catalogFileVersion(stats);
    if (
      old?.sourceVersion === sourceVersion &&
      old.rowFormat === FILE_ROW_FORMAT &&
      (!source.reader.getNativeSessionRef || old.nativeStorageScope)
    )
      return { ...old, projectName: project.name };
    const nativeStorageScope = (
      await source.reader.getNativeSessionRef?.(
        parseNativeSessionId(file.sessionId),
      )
    )?.storageScope;
    // A changed/disappeared source cannot publish an unqualified native alias.
    if (source.reader.getNativeSessionRef && !nativeStorageScope) return;
    const cached = await deps.sessionIndexService?.getCachedSessionSummary(
      source.sessionDir,
      project.id,
      file.sessionId,
      source.reader,
    );
    const summary = cached
      ? toSessionListSummary(cached)
      : await source.reader.getSessionListSummary?.(
          file.sessionId,
          project.id,
          undefined,
          { deferAsyncQuestions: true },
        );
    // The untruncated text, because All Sessions matches these rows in the
    // browser: a display-length title would make a needle past its cut
    // unfindable with no way for the reader to tell searching from missing.
    const summaryTitle = summary?.fullTitle ?? summary?.title;
    // A live Claude session is appended to constantly and so rarely has a
    // cached summary. Its row still needs the times the sidebar files it by:
    // without them a session being worked in reads as never touched.
    const head =
      family === "claude" &&
      (summaryTitle === undefined ||
        summaryTitle === null ||
        !summary?.createdAt)
        ? await readClaudeCatalogHead(file.filePath)
        : undefined;
    const title = summaryTitle ?? head?.title;
    const createdAt = summary?.createdAt ?? head?.createdAt;
    const tail =
      !summary && family === "claude"
        ? await readClaudeCatalogTail(file.filePath)
        : undefined;
    // A summary is exact, so its missing human turn means there was none.
    const lastHumanTurnAt = summary
      ? summary.lastHumanTurnAt
      : tail?.lastHumanTurnAt;
    // Storage time is not content time. Claude appends non-conversation rows
    // at shutdown, so an mtime-derived row makes a read session unread and
    // falsely recent; Codex has its own content-aware activity time.
    const contentUpdatedAt = summary?.updatedAt ?? tail?.updatedAt;
    const storageUpdatedAt = () =>
      new Date(
        family === "codex"
          ? getCodexRolloutActivityTimeMs(file.filePath, stats)
          : stats.mtimeMs,
      ).toISOString();
    const after = await stat(file.filePath);
    if (catalogFileVersion(after) !== sourceVersion) {
      // Never label facts read across an append/replacement as an exact projection.
      if (old) return old;
      return {
        catalogFamily: family,
        storeKey: source.sessionDir,
        sessionId: file.sessionId,
        ...(nativeStorageScope ? { nativeStorageScope } : {}),
        ...catalogProjectIdentity(project.path),
        projectId: project.id,
        projectName: project.name,
        provider: source.provider,
        updatedAt: contentUpdatedAt ?? storageUpdatedAt(),
        fidelity: "identity",
        sourceVersion: `unsettled:${sourceVersion}`,
        location: { kind: "file", path: file.filePath },
      };
    }
    return {
      catalogFamily: family,
      storeKey: source.sessionDir,
      sessionId: file.sessionId,
      ...(nativeStorageScope ? { nativeStorageScope } : {}),
      ...catalogProjectIdentity(project.path),
      projectId: project.id,
      projectName: project.name,
      provider: summary?.provider ?? source.provider,
      updatedAt: contentUpdatedAt ?? storageUpdatedAt(),
      ...(createdAt ? { createdAt } : {}),
      ...(lastHumanTurnAt ? { lastHumanTurnAt } : {}),
      ...(title !== undefined
        ? { title: title?.slice(0, SESSION_CATALOG_TITLE_MAX_LENGTH) }
        : {}),
      fidelity: summary || title ? "head" : "identity",
      sourceVersion,
      rowFormat: FILE_ROW_FORMAT,
      location: { kind: "file", path: file.filePath },
      ...(summary?.asyncQuestions
        ? { asyncQuestions: summary.asyncQuestions }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function refreshChangedRows(
  deps: CollectionCatalogDeps,
  previousRows: readonly Readonly<SessionCatalogRow>[],
  signal: AbortSignal,
  changedPaths: ReadonlySet<string>,
  sources: readonly Pick<
    NativeSessionCatalogAdapter,
    "catalogFamily" | "storeKey"
  >[],
): Promise<NativeSessionCatalogAdapter[] | undefined> {
  const knownPaths = new Set(
    previousRows
      .filter(
        (row) =>
          row.location.kind === "file" &&
          ["claude", "codex", "gemini"].includes(row.catalogFamily),
      )
      .map((row) => (row.location.kind === "file" ? row.location.path : "")),
  );
  // A new Claude transcript joins the project its store's rows belong to; any
  // other newly observed file needs discovery to establish its membership.
  const added: [string, Readonly<SessionCatalogRow>][] = [];
  let claudeStores: ReturnType<typeof claudeStoreProjects> | undefined;
  for (const path of changedPaths) {
    if (knownPaths.has(path)) continue;
    claudeStores ??= claudeStoreProjects(previousRows);
    const name = basename(path);
    const sibling =
      name.endsWith(".jsonl") && !name.startsWith("agent-")
        ? claudeStores.get(dirname(path))
        : undefined;
    if (!sibling) return undefined;
    added.push([path, sibling]);
  }
  const rows: SessionCatalogRow[] = [];
  const needsGemini = previousRows.some(
    (row) =>
      row.catalogFamily === "gemini" &&
      row.location.kind === "file" &&
      changedPaths.has(row.location.path),
  );
  const resolution = providerResolutionDeps({
    ...deps,
    geminiScanner: needsGemini ? deps.geminiScanner : undefined,
  });
  const reread = async (
    row: Readonly<SessionCatalogRow>,
    file: { sessionId: string; filePath: string },
    old?: Readonly<SessionCatalogRow>,
  ) => {
    const project: Project = {
      id: row.projectId,
      path: row.projectPath,
      name: row.projectName ?? basename(row.projectPath),
      provider: row.provider ?? row.catalogFamily,
      sessionDir: row.storeKey,
      sessionCount: 1,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: row.updatedAt,
    };
    const source = getSessionSources(
      project,
      resolution,
      project.provider,
      undefined,
      new Set([row.catalogFamily]),
    )[0];
    if (!source) throw new Error(`No catalog reader for ${row.catalogFamily}`);
    const refreshed = await readFileRow(deps, project, source, file, old);
    if (refreshed) rows.push(refreshed);
  };
  for (const row of previousRows) {
    signal.throwIfAborted();
    if (row.location.kind !== "file" || !changedPaths.has(row.location.path)) {
      rows.push(row);
      continue;
    }
    await reread(
      row,
      { sessionId: row.sessionId, filePath: row.location.path },
      row,
    );
  }
  for (const [filePath, sibling] of added) {
    signal.throwIfAborted();
    await reread(sibling, {
      sessionId: basename(filePath).slice(0, -".jsonl".length),
      filePath,
    });
  }
  return catalogAdaptersForRows(rows, sources);
}

/**
 * Each Claude store directory with the one project all its rows agree on.
 * Discovery files a store's transcripts under that project, so a new
 * transcript there needs no rediscovery. A store whose rows disagree (two
 * project paths encoding to one directory) maps to nothing.
 */
function claudeStoreProjects(
  rows: readonly Readonly<SessionCatalogRow>[],
): Map<string, Readonly<SessionCatalogRow>> {
  const stores = new Map<string, Readonly<SessionCatalogRow> | null>();
  for (const row of rows) {
    if (
      row.catalogFamily !== "claude" ||
      row.location.kind !== "file" ||
      dirname(row.location.path) !== row.storeKey
    )
      continue;
    const seen = stores.get(row.storeKey);
    if (seen === undefined) stores.set(row.storeKey, row);
    else if (seen && seen.projectIdentityKey !== row.projectIdentityKey)
      stores.set(row.storeKey, null);
  }
  const agreed = new Map<string, Readonly<SessionCatalogRow>>();
  for (const [store, row] of stores) if (row) agreed.set(store, row);
  return agreed;
}

export async function collectionCatalogAdapters(
  deps: CollectionCatalogDeps,
  previousRows: readonly Readonly<SessionCatalogRow>[],
  signal: AbortSignal,
  changedPaths?: ReadonlySet<string>,
  sources: readonly Pick<
    NativeSessionCatalogAdapter,
    "catalogFamily" | "storeKey"
  >[] = [],
): Promise<NativeSessionCatalogAdapter[]> {
  if (changedPaths) {
    // A path inside a native store rescans that store; the rest are files.
    const native = nativeCatalogAdapters(deps.getCatalogFamilies(), deps);
    const contains = (store: NativeSessionCatalogAdapter, path: string) => {
      const child = relative(store.storeKey, path);
      return (
        child !== ".." &&
        !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        !isAbsolute(child)
      );
    };
    const filePaths = new Set(
      [...changedPaths].filter(
        (path) => !native.some((store) => contains(store, path)),
      ),
    );
    const affected = native.filter((store) =>
      [...changedPaths].some((path) => contains(store, path)),
    );
    const keys = new Set(
      affected.map((store) =>
        JSON.stringify([store.catalogFamily, store.storeKey]),
      ),
    );
    const unaffected = (
      row: Pick<NativeSessionCatalogAdapter, "catalogFamily" | "storeKey">,
    ) => !keys.has(JSON.stringify([row.catalogFamily, row.storeKey]));
    const targeted = await refreshChangedRows(
      deps,
      previousRows.filter(unaffected),
      signal,
      filePaths,
      sources.filter(unaffected),
    );
    if (targeted) return [...targeted, ...affected];
  }
  const families = new Set(deps.getCatalogFamilies());
  const fileFamilies = new Set(
    [...families].filter((family) =>
      ["claude", "codex", "gemini"].includes(family),
    ),
  );
  const projects = fileFamilies.size
    ? await deps.scanner.listFileCatalogProjects()
    : [];
  signal.throwIfAborted();
  const providerCatalog = await buildProviderProjectCatalog({ projects });
  const resolution = providerResolutionDeps({
    ...deps,
    geminiScanner: fileFamilies.has("gemini") ? deps.geminiScanner : undefined,
  });
  const previous = new Map(
    previousRows.map((row) => [sessionCatalogRowKey(row), row]),
  );
  const adapters: NativeSessionCatalogAdapter[] = [];
  const stores = new Map<
    string,
    {
      family: ProviderCatalogFamily;
      storeKey: string;
      sources: { project: Project; source: SessionSource }[];
    }
  >();
  for (const project of projects) {
    for (const source of getSessionSources(
      project,
      resolution,
      undefined,
      providerCatalog,
      fileFamilies,
    )) {
      const family = providerCatalogFamily(source.provider);
      if (
        !families.has(family) ||
        !["claude", "codex", "gemini"].includes(family)
      )
        continue;
      const key = JSON.stringify([family, source.sessionDir]);
      let store = stores.get(key);
      if (!store) {
        store = { family, storeKey: source.sessionDir, sources: [] };
        stores.set(key, store);
      }
      store.sources.push({ project, source });
      if (family === "claude") {
        for (const sessionDir of project.mergedSessionDirs ?? []) {
          const mergedKey = JSON.stringify([family, sessionDir]);
          if (!stores.has(mergedKey))
            stores.set(mergedKey, {
              family,
              storeKey: sessionDir,
              sources: [
                {
                  project,
                  source: {
                    ...source,
                    sessionDir,
                    reader: deps.readerFactory({ ...project, sessionDir }),
                  },
                },
              ],
            });
        }
      }
    }
  }
  for (const { family, storeKey, sources } of stores.values()) {
    adapters.push({
      catalogFamily: family,
      storeKey,
      scan: async (context) => ({
        sourceVersion: `reconciliation:${context.targetGeneration}`,
        rows: (async function* () {
          const seen = new Set<string>();
          for (const { project, source } of sources) {
            for (const file of await sessionFiles(source)) {
              context.signal.throwIfAborted();
              signal.throwIfAborted();
              if (seen.has(file.sessionId)) continue;
              seen.add(file.sessionId);
              const old = previous.get(
                sessionCatalogRowKey({
                  catalogFamily: family,
                  storeKey,
                  sessionId: file.sessionId,
                }),
              );
              const row = await readFileRow(deps, project, source, file, old);
              if (row) yield row;
            }
          }
        })(),
      }),
    });
  }
  adapters.push(...nativeCatalogAdapters([...families], deps));
  return adapters;
}
