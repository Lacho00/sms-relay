export type SendResult =
  | { kind: 'response'; status: number; retryAfterMs: number | null }
  | { kind: 'timeout' }
  | { kind: 'network' };

export type Verdict = 'delivered' | 'retry' | 'failed';

export const BASE_DELAY_MS = 60_000;
export const MAX_DELAY_MS = 3_600_000;

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

/** Decides what the outbox does with a send result. */
export function classify(r: SendResult): Verdict {
  if (r.kind === 'timeout' || r.kind === 'network') return 'retry';
  if (r.status >= 200 && r.status <= 299) return 'delivered';
  if (RETRYABLE_STATUSES.has(r.status) || (r.status >= 500 && r.status <= 599)) return 'retry';
  return 'failed';
}

/** Stable error label for a failed or retried send; null when delivered. */
export function errorCode(r: SendResult): string | null {
  if (r.kind === 'timeout') return 'timeout';
  if (r.kind === 'network') return 'network';
  if (r.status >= 200 && r.status <= 299) return null;
  if (r.status >= 300 && r.status <= 399) return 'redirect';
  return `http_${r.status}`;
}

/**
 * Delay before the next attempt. `attempt` is 1-based and is the attempt that
 * just failed. Exponential from BASE_DELAY_MS, raised to Retry-After when that
 * is larger, capped at MAX_DELAY_MS. No jitter.
 */
export function nextDelayMs(attempt: number, retryAfterMs: number | null): number {
  const exponential = BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(Math.max(exponential, retryAfterMs ?? 0), MAX_DELAY_MS);
}

/**
 * Parses a Retry-After header into milliseconds from `now`. Accepts
 * non-negative integer seconds or an HTTP date. Returns null when the value
 * is missing or unusable, and 0 for a date already in the past.
 */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // Date.parse accepts signed numbers such as "-5" as years, so require a letter first.
  if (!/^[A-Za-z]/.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}
