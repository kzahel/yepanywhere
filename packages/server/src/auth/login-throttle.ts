/**
 * Failed-password throttling for `POST /api/auth/login`.
 *
 * Each attempt reserves a token from its client address's bucket and from a
 * shared global bucket before any password is checked, and gets both back
 * unless the password is rejected. So only failures are charged, someone
 * who knows the password is never slowed by their own logins, and parallel
 * requests cannot all pass the check before the first failure lands. With
 * either bucket empty the attempt is refused with a retry time. The client
 * address is the TCP peer; forwarded headers are never trusted, so clients
 * behind one reverse proxy share a bucket.
 */

interface Bucket {
  tokens: number;
  at: number;
}

interface Rate {
  perMinute: number;
  burst: number;
}

/** Failed attempts one client address may sustain. */
const PER_ADDRESS: Rate = { perMinute: 5, burst: 5 };
/** Failed attempts across all addresses. */
const GLOBAL: Rate = { perMinute: 30, burst: 30 };
/** Address buckets kept; refilled ones are dropped first, then the oldest. */
const MAX_ADDRESSES = 1024;

export class LoginThrottle {
  private readonly addresses = new Map<string, Bucket>();
  private readonly global: Bucket;

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.global = { tokens: GLOBAL.burst, at: clock() };
  }

  /**
   * Reserve one attempt for this address. Returns 0 when admitted, else the
   * whole seconds to wait, with nothing reserved.
   */
  reserve(address: string): number {
    const now = this.clock();
    const bucket = this.addressBucket(address, now);
    const waitMs = Math.max(
      this.waitMs(this.global, GLOBAL, now),
      this.waitMs(bucket, PER_ADDRESS, now),
    );
    if (waitMs > 0) return Math.ceil(waitMs / 1000);
    this.global.tokens--;
    bucket.tokens--;
    return 0;
  }

  /** Return a reservation whose attempt did not reject a password. */
  release(address: string): void {
    const now = this.clock();
    this.refill(this.global, GLOBAL, now);
    this.global.tokens = Math.min(GLOBAL.burst, this.global.tokens + 1);
    const bucket = this.addresses.get(address);
    if (!bucket) return;
    this.refill(bucket, PER_ADDRESS, now);
    bucket.tokens = Math.min(PER_ADDRESS.burst, bucket.tokens + 1);
  }

  private addressBucket(address: string, now: number): Bucket {
    let bucket = this.addresses.get(address);
    if (!bucket) {
      if (this.addresses.size >= MAX_ADDRESSES) this.makeRoom(now);
      bucket = { tokens: PER_ADDRESS.burst, at: now };
      this.addresses.set(address, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket, rate: Rate, now: number) {
    bucket.tokens = Math.min(
      rate.burst,
      bucket.tokens + (Math.max(0, now - bucket.at) * rate.perMinute) / 60_000,
    );
    bucket.at = now;
  }

  private waitMs(bucket: Bucket, rate: Rate, now: number): number {
    this.refill(bucket, rate, now);
    return bucket.tokens >= 1
      ? 0
      : ((1 - bucket.tokens) * 60_000) / rate.perMinute;
  }

  private makeRoom(now: number) {
    for (const [address, bucket] of this.addresses) {
      this.refill(bucket, PER_ADDRESS, now);
      if (bucket.tokens >= PER_ADDRESS.burst) this.addresses.delete(address);
    }
    const oldest = this.addresses.keys().next();
    if (this.addresses.size >= MAX_ADDRESSES && !oldest.done)
      this.addresses.delete(oldest.value);
  }
}

/** The TCP peer address of a direct request, else one shared key. */
export function loginClientAddress(c: { env: unknown }): string {
  const incoming = (
    c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}
