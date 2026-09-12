import {
  readWorkflowSchema,
  workflowSchemaReference,
  type WorkflowSchemaFiles,
} from "@yep-anywhere/shared/transcript/workflowTags";

export const WORKFLOW_SCHEMA_TTL_MS = 5 * 60 * 1000;

interface CachedSchema {
  content: string | null;
  checkedAt: number;
  etag?: string;
}

/** One session's file cache, separate from its immutable source messages. */
export class WorkflowSchemaFileStore {
  private snapshot: WorkflowSchemaFiles = {};
  private cache = new Map<string, CachedSchema>();
  private listeners = new Set<() => void>();
  private queue = new Set<string>();
  private current: string | null = null;
  private abort: AbortController | null = null;
  private generation = 0;

  constructor(
    private readonly readFile: (
      path: string,
      init: RequestInit,
    ) => Promise<Response>,
    private readonly storageKey: string,
    private readonly storage: Storage | null,
  ) {}

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  request = (references: Iterable<string>) => {
    for (const reference of references) {
      if (!workflowSchemaReference(reference) || reference === this.current)
        continue;
      const cached = this.getCached(reference);
      const age = cached ? Date.now() - cached.checkedAt : Infinity;
      if (cached && age >= 0 && age < WORKFLOW_SCHEMA_TTL_MS) {
        this.publish(reference, cached.content);
      } else {
        this.queue.add(reference);
      }
    }
    if (!this.current) void this.drain();
  };

  dispose = () => {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.current = null;
    this.queue.clear();
  };

  private getCached(reference: string): CachedSchema | undefined {
    const cached = this.cache.get(reference);
    if (cached) return cached;
    try {
      const serialized = this.storage?.getItem(
        `${this.storageKey}:${reference}`,
      );
      if (!serialized) return;
      const value = JSON.parse(serialized) as CachedSchema;
      if (
        value &&
        typeof value.content === "string" &&
        Number.isFinite(value.checkedAt) &&
        (value.etag === undefined || typeof value.etag === "string") &&
        readWorkflowSchema(value.content, reference)
      ) {
        this.cache.set(reference, value);
        return value;
      }
    } catch {
      // Missing/invalid browser persistence is a cache miss, not a schema.
    }
  }

  private publish(reference: string, content: string | null) {
    if (this.snapshot[reference] === content) return;
    this.snapshot = { ...this.snapshot, [reference]: content };
    for (const listener of this.listeners) listener();
  }

  private async drain() {
    const generation = this.generation;
    // Serial demand reads only. Expiration itself schedules no background work.
    for (const reference of this.queue) {
      this.queue.delete(reference);
      this.current = reference;
      const storageKey = `${this.storageKey}:${reference}`;
      const cached = this.getCached(reference);
      let next: CachedSchema = { content: null, checkedAt: Date.now() };
      this.abort = new AbortController();
      try {
        const result = await this.readFile(
          workflowSchemaReference(reference)!.path,
          {
            signal: this.abort.signal,
            cache: "no-store",
            headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
          },
        );
        if (result.status === 304 && cached?.content) {
          next = { ...cached, checkedAt: Date.now() };
        } else if (result.status === 200) {
          const content = await result.text();
          if (
            content.length <= 1024 * 1024 &&
            readWorkflowSchema(content, reference)
          ) {
            next = {
              content,
              checkedAt: Date.now(),
              etag: result.headers.get("ETag") ?? undefined,
            };
          }
        }
      } catch {
        // Missing, denied, and disconnected files stay visibly unresolved.
      }
      if (generation !== this.generation) return;
      next.checkedAt = Date.now();
      this.cache.set(reference, next);
      try {
        if (next.content !== null)
          this.storage?.setItem(storageKey, JSON.stringify(next));
        else this.storage?.removeItem(storageKey);
      } catch {
        // Quota/private-mode failure leaves an in-memory cache only.
      }
      this.publish(reference, next.content);
    }
    if (generation === this.generation) {
      this.current = null;
      this.abort = null;
    }
  }
}
