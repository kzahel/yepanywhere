import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReviewInboxItem, ReviewStoreFile } from "@yep-anywhere/shared";

export type ReviewProject = { id: string; path: string; name: string };
const RECHECK_EMPTY_MS = 10 * 60_000;
const PROBE_BATCH_SIZE = 16;

/** Empty projects need only an expiring presence check across Inbox mounts. */
export class ReviewInboxSources {
  private readonly probes = new Map<string, { nextCheck: number }>();
  private generation = 0;

  constructor(
    private readonly readStore: (path: string) => Promise<ReviewStoreFile>,
    private readonly paths: (project: string) => readonly string[],
    private readonly loaded: (project: string) => boolean,
    private readonly now = Date.now,
  ) {}

  get revision() {
    return this.generation;
  }

  changed(projectPath: string) {
    this.probes.delete(resolve(projectPath));
    this.generation++;
  }

  reset() {
    this.probes.clear();
    this.generation++;
  }

  private async hasSource(project: string) {
    if (this.loaded(project)) return true;
    for (const path of this.paths(project)) {
      try {
        await stat(path);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return true;
      }
    }
    return false;
  }

  async read(projects: readonly ReviewProject[]): Promise<ReviewInboxItem[]> {
    const now = this.now();
    const visible = new Set<string>();
    const candidates = [];
    for (const project of projects) {
      const key = resolve(project.path);
      visible.add(key);
      let probe = this.probes.get(key);
      if (!probe) {
        probe = { nextCheck: 0 };
        this.probes.set(key, probe);
      }
      if (probe.nextCheck <= now) candidates.push({ project, probe });
    }
    for (const path of this.probes.keys()) {
      if (!visible.has(path)) this.probes.delete(path);
    }

    const items: ReviewInboxItem[] = [];
    for (let start = 0; start < candidates.length; start += PROBE_BATCH_SIZE) {
      const batch = candidates.slice(start, start + PROBE_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async ({ project, probe }) => {
          const store =
            (await this.hasSource(project.path)) &&
            (await this.readStore(project.path));
          const unread = store ? unreadItems(project, store) : [];
          // A mutation or reset detaches this probe. Finishing an obsolete
          // read cannot mark the replacement generation empty.
          if (!unread.length) {
            probe.nextCheck =
              now + RECHECK_EMPTY_MS * (0.8 + Math.random() * 0.2);
          }
          return unread;
        }),
      );
      for (const result of results) {
        for (const item of result) items.push(item);
      }
    }
    return items.sort((a, b) => b.responseRevision - a.responseRevision);
  }
}

function unreadItems(
  project: ReviewProject,
  store: ReviewStoreFile,
): ReviewInboxItem[] {
  const items: ReviewInboxItem[] = [];
  for (const submission of store.submissions) {
    if (submission.responseRevision <= submission.acknowledgedRevision)
      continue;
    const outcomes = submission.entryRefs.flatMap((ref) => {
      const site = store.sites.find((item) => item.id === ref.siteId);
      const outcome = site?.outcomes
        .filter((item) => item.entryId === ref.entryId)
        .at(-1);
      return site && outcome
        ? [{ ...outcome, siteId: site.id, path: site.path }]
        : [];
    });
    items.push({
      projectId: project.id,
      projectName: project.name,
      submissionId: submission.id,
      name: submission.name,
      targetSessionId: submission.targetSessionId,
      responseRevision: submission.responseRevision,
      outcomes,
    });
  }
  return items;
}
