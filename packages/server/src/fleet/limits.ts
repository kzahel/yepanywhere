import { FleetError } from "./errors.js";

/** Native work retains its slot until settlement even when a caller leaves. */
export class FleetWorkBudget {
  private count = 0;
  constructor(private readonly maximum: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.count >= this.maximum)
      throw new FleetError("capacity", "Fleet work capacity reached", 503);
    this.count++;
    try {
      return await work();
    } finally {
      this.count--;
    }
  }
}

export async function fleetWait<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(new FleetError("cancelled", "Fleet request cancelled", 503));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

interface Bucket {
  tokens: number;
  at: number;
}
/** At most 1,024 active keys, reclaimed after ten idle minutes; no sweep. */
export class FleetLimiter {
  private readonly keys = new Map<string, Bucket>();
  private readonly global: Bucket;
  constructor(
    private readonly globalRate: number,
    private readonly globalBurst: number,
    private readonly keyRate: number,
    private readonly keyBurst: number,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.global = { tokens: globalBurst, at: clock() };
  }
  private take(bucket: Bucket, rate: number, burst: number, now: number) {
    bucket.tokens = Math.min(
      burst,
      bucket.tokens + (Math.max(0, now - bucket.at) * rate) / 60_000,
    );
    bucket.at = now;
    if (bucket.tokens < 1)
      throw new FleetError("rate_limited", "Fleet request rate exceeded", 429);
    bucket.tokens--;
  }
  admit(key: string) {
    const now = this.clock();
    this.take(this.global, this.globalRate, this.globalBurst, now);
    let bucket = this.keys.get(key);
    if (!bucket) {
      if (this.keys.size >= 1024)
        for (const [id, entry] of this.keys)
          if (now - entry.at >= 600_000) this.keys.delete(id);
      if (this.keys.size >= 1024)
        throw new FleetError(
          "rate_limited",
          "Fleet limiter identity capacity reached",
          429,
        );
      bucket = { tokens: this.keyBurst, at: now };
      this.keys.set(key, bucket);
    }
    this.take(bucket, this.keyRate, this.keyBurst, now);
  }
}

export async function fleetJson(
  request: Request,
  signal: AbortSignal,
  maximum = 64 * 1024,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new FleetError("invalid_request", "A JSON request body is required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await fleetWait(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum)
        throw new FleetError(
          "invalid_request",
          "Fleet request body exceeds its byte limit",
        );
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new FleetError("invalid_request", "Invalid JSON request body");
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
