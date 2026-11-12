import {
  collectionView,
  diffCollectionView,
  type CollectionView,
  type CollectionUpdate,
} from "@yep-anywhere/shared/collection-updates";
import type { EventBus } from "../watcher/index.js";
import { busEventChangesSessionCollection } from "../sessions/sessionCollectionGeneration.js";
import {
  projectCollectionEvent,
  projectQueueTransition,
} from "./project-collection-updates.js";
import { runOutsideRequestContext } from "../lib/outsideRequestContext.js";

export interface CollectionUpdatesListener {
  send(update: CollectionUpdate, snapshot: CollectionView): void;
  fail(error: unknown): void;
}
type CollectionRead = (signal: AbortSignal) => Promise<Record<string, unknown>>;
interface View {
  key: string;
  query: string;
  listeners: Map<
    CollectionUpdatesListener,
    {
      initialized: boolean;
      read: CollectionRead;
      controller: AbortController;
      metadataFields: boolean;
    }
  >;
  snapshot?: CollectionView;
  revision: number;
  bytes: number;
  deadline?: number;
  dirty: boolean;
  running: boolean;
}
/** Active query views only: <=64 views,32MiB snapshots; one event owner and wake. */
export class CollectionUpdates {
  private readonly views = new Map<string, View>();
  private bytes = 0;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private due = Infinity;
  private closed = false;
  constructor(
    private readonly bus: EventBus,
    signal?: AbortSignal,
  ) {
    signal?.addEventListener("abort", () => this.close(), { once: true });
  }
  retain(
    audience: string,
    query: string,
    read: CollectionRead,
    listener: CollectionUpdatesListener,
    metadataFields = false,
  ): () => void {
    if (this.closed) throw new Error("Collection update owner is closed");
    const key = JSON.stringify([audience, query]);
    let view = this.views.get(key);
    if (!view) {
      if (this.views.size >= 64)
        throw new Error("Collection update view limit");
      view = {
        key,
        query,
        listeners: new Map(),
        revision: 0,
        bytes: 0,
        dirty: true,
        running: false,
      };
      this.views.set(key, view);
    }
    const retained = view;
    const state = {
      initialized: false,
      metadataFields,
      read,
      controller: new AbortController(),
    };
    retained.listeners.set(listener, state);
    // A join/explicit refresh validates canonical overlays, even without a bus event.
    retained.dirty = true;
    this.unsubscribe ??= this.bus.subscribe((event) => {
      let changed = false;
      for (const current of this.views.values()) {
        const relevant =
          projectCollectionEvent(current.query, event) ??
          (busEventChangesSessionCollection(event) ||
            event.type === "session-provider-phase-changed");
        if (relevant) {
          current.dirty = true;
          changed = true;
        }
      }
      if (changed) this.wake(100);
    });
    this.wake(0);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.controller.abort();
      retained.listeners.delete(listener);
      if (retained.listeners.size) {
        retained.dirty = true;
        return;
      }
      this.views.delete(key);
      this.bytes -= retained.bytes;
      if (!this.views.size) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.due = Infinity;
      }
    };
  }
  /** Admission and retain are synchronous, so no partial stream need open. */
  admission(
    audience: string,
    queries: string[],
  ): "closed" | "full" | undefined {
    if (this.closed) return "closed";
    const additional = queries.filter(
      (query) => !this.views.has(JSON.stringify([audience, query])),
    ).length;
    if (this.views.size + additional > 64) return "full";
  }
  private wake(delay: number) {
    const due = Date.now() + Math.max(0, delay);
    if (this.closed || (this.timer && this.due <= due)) return;
    if (this.timer) clearTimeout(this.timer);
    this.due = due;
    this.timer = runOutsideRequestContext(() =>
      setTimeout(
        () => {
          this.timer = undefined;
          this.due = Infinity;
          const now = Date.now();
          for (const view of this.views.values()) {
            if (view.deadline !== undefined && view.deadline <= now)
              view.dirty = true;
            if (view.dirty && !view.running) void this.refresh(view);
          }
          this.armNext();
        },
        Math.min(Math.max(0, delay), 2_147_483_647),
      ),
    );
  }
  private armNext() {
    let due = Infinity;
    for (const view of this.views.values()) {
      if (view.running) continue;
      if (view.dirty) due = Math.min(due, Date.now() + 100);
      else due = Math.min(due, view.deadline ?? Infinity);
    }
    if (Number.isFinite(due)) this.wake(Math.max(100, due - Date.now()));
  }
  private async refresh(view: View) {
    view.running = true;
    view.dirty = false;
    const selected = view.listeners.entries().next().value;
    if (!selected) {
      view.running = false;
      return;
    }
    const [reader, acquisition] = selected;
    try {
      const readStartedAt = Date.now();
      const body = await acquisition.read(acquisition.controller.signal);
      if (this.views.get(view.key) !== view) return;
      if (
        view.listeners.get(reader) !== acquisition ||
        acquisition.controller.signal.aborted
      ) {
        view.dirty = true;
        return;
      }
      const next = collectionView(body, view.query);
      const bytes = Buffer.byteLength(JSON.stringify(next));
      if (
        bytes > 2 * 1024 ** 2 ||
        this.bytes - view.bytes + bytes > 32 * 1024 ** 2
      )
        throw new Error("Collection update snapshot budget");
      const change = diffCollectionView(
        view.query,
        view.revision + 1,
        view.snapshot,
        next,
      );
      const fieldChange =
        change &&
        [...view.listeners.values()].some((state) => state.metadataFields) &&
        diffCollectionView(
          view.query,
          view.revision + 1,
          view.snapshot,
          next,
          true,
        );
      if (change) view.revision++;
      this.bytes += bytes - view.bytes;
      view.bytes = bytes;
      view.snapshot = next;
      const deadline =
        body.nextTransitionAt ??
        projectQueueTransition(view.query, body, readStartedAt);
      view.deadline =
        typeof deadline === "number" && deadline > Date.now()
          ? deadline
          : undefined;
      if (typeof deadline === "number" && deadline <= Date.now())
        view.dirty = true;
      for (const [listener, state] of [...view.listeners]) {
        const frame = state.initialized
          ? state.metadataFields
            ? fieldChange
            : change
          : diffCollectionView(view.query, view.revision, undefined, next);
        if (frame) {
          try {
            listener.send(frame, next);
            if (view.listeners.get(listener) === state)
              state.initialized = true;
          } catch (error) {
            listener.fail(error);
          }
        }
      }
    } catch (error) {
      if (acquisition.controller.signal.aborted) view.dirty = true;
      else
        for (const listener of [...view.listeners.keys()]) listener.fail(error);
    } finally {
      view.running = false;
      if (this.views.get(view.key) === view && view.listeners.size) {
        this.armNext();
      }
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const view of this.views.values()) {
      for (const [listener, state] of view.listeners) {
        state.controller.abort();
        listener.fail(new Error("Collection update owner retired"));
      }
    }
    this.views.clear();
    this.bytes = 0;
  }
  getStats() {
    return {
      views: this.views.size,
      bytes: this.bytes,
      listening: !!this.unsubscribe,
      timer: !!this.timer,
    };
  }
}
