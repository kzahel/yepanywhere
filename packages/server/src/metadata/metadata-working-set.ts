import type { SessionMetadata } from "./SessionMetadataService.js";

/** Clean objects/misses are LRU-bounded; dirty mutations stay pinned until commit.
 * Returned objects are read-only projections. Callers mutate through the service.
 */
export class MetadataWorkingSet {
  private readonly entries = new Map<
    string,
    { value: SessionMetadata | undefined; bytes: number }
  >();
  private bytes = 0;
  constructor(
    private readonly read: (id: string) => {
      value: SessionMetadata | undefined;
      bytes: number;
    },
    private readonly dirty: ReadonlySet<string>,
    private readonly maximumEntries = 256,
    private readonly maximumBytes = 8 * 1024 * 1024,
  ) {}
  get(id: string): SessionMetadata | undefined {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = this.read(id);
      this.entries.set(id, entry);
      this.bytes += entry.bytes;
    } else {
      this.entries.delete(id);
      this.entries.set(id, entry);
    }
    this.trim();
    return entry.value;
  }
  batch(
    ids: readonly string[],
    read: (
      ids: readonly string[],
    ) => ReadonlyMap<
      string,
      { value: SessionMetadata | undefined; bytes: number }
    >,
  ) {
    const missing = [...new Set(ids)].filter((id) => !this.entries.has(id));
    const loaded = missing.length ? read(missing) : undefined;
    const result = new Map<string, SessionMetadata | undefined>();
    for (const id of ids) {
      let entry = this.entries.get(id);
      if (entry) this.entries.delete(id);
      else {
        entry = loaded?.get(id) ?? {
          value: undefined,
          bytes: id.length * 2 + 512,
        };
        this.bytes += entry.bytes;
      }
      this.entries.set(id, entry);
      result.set(id, entry.value);
    }
    this.trim();
    return result;
  }
  set(id: string, value: SessionMetadata | undefined, bytes = 0): void {
    const old = this.entries.get(id);
    this.bytes -= old?.bytes ?? 0;
    this.entries.delete(id);
    // New objects are pinned while dirty. Charge their persisted size on commit.
    this.entries.set(id, { value, bytes });
    this.bytes += bytes;
    this.trim();
  }
  committed(sizes: ReadonlyMap<string, number>): void {
    for (const [id, bytes] of sizes) {
      const entry = this.entries.get(id);
      if (entry) {
        this.bytes += bytes - entry.bytes;
        entry.bytes = bytes;
      }
    }
    this.trim();
  }
  private trim() {
    if (
      this.entries.size <= this.maximumEntries &&
      this.bytes <= this.maximumBytes
    )
      return;
    for (const [id, entry] of this.entries) {
      if (this.dirty.has(id)) continue;
      this.entries.delete(id);
      this.bytes -= entry.bytes;
      if (
        this.entries.size <= this.maximumEntries &&
        this.bytes <= this.maximumBytes
      )
        break;
    }
  }
  metrics() {
    return {
      entries: this.entries.size,
      estimatedPayloadBytes: this.bytes,
      pinnedEntries: this.dirty.size,
      entryBudget: this.maximumEntries,
      payloadByteBudget: this.maximumBytes,
    };
  }
  pending(): ReadonlyMap<string, SessionMetadata | undefined> {
    return new Map([...this.dirty].map((id) => [id, this.get(id)]));
  }
}
