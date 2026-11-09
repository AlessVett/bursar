import { isIP } from "node:net";

interface Window {
  count: number;
  startedAt: number;
}

/** Expands a valid IPv6 address (optionally ending in dotted IPv4) to its eight groups. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (part: string | undefined): number[] =>
    part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const [head, tail] = text.split("::");
  const left = parse(head);
  if (tail === undefined) return left;
  const right = parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * Maps a client address to the key the login limiter counts against. An IPv6
 * client usually controls a whole /64, so IPv6 addresses collapse to their /64
 * prefix; IPv4-mapped IPv6 addresses become plain IPv4; IPv4 addresses and
 * anything that is not an IP address are returned unchanged.
 */
export function rateLimitKey(address: string): string {
  const bare = address.replace(/^\[(.*)\]$/, "$1").split("%")[0] ?? "";
  const version = isIP(bare);
  if (version === 4) return bare;
  if (version !== 6) return address;
  const groups = ipv6Groups(bare);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high, low] = [groups[6] ?? 0, groups[7] ?? 0];
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

export class FailureLimiter {
  private readonly failures = new Map<string, Window>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(key: string): boolean {
    const entry = this.current(key);
    return entry !== undefined && entry.count >= this.maxFailures;
  }

  /**
   * Atomically charges one attempt against the key (synchronous, so it cannot
   * interleave with other requests). Returns false when the cap is already
   * reached. Call it before any async verification and reset() on success.
   */
  tryConsume(key: string): boolean {
    const entry = this.current(key);
    if (!entry) {
      this.failures.set(key, { count: 1, startedAt: this.now() });
      return true;
    }
    if (entry.count >= this.maxFailures) return false;
    entry.count += 1;
    return true;
  }

  recordFailure(key: string): void {
    const entry = this.current(key);
    if (entry) entry.count += 1;
    else this.failures.set(key, { count: 1, startedAt: this.now() });
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private current(key: string): Window | undefined {
    const entry = this.failures.get(key);
    if (entry && this.now() - entry.startedAt >= this.windowMs) {
      this.failures.delete(key);
      return undefined;
    }
    return entry;
  }
}
