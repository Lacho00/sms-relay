import { describe, expect, it } from 'vitest';
import {
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  classify,
  errorCode,
  nextDelayMs,
  parseRetryAfter,
  type SendResult,
} from '../../src/outbox/backoff';

const resp = (status: number, retryAfterMs: number | null = null): SendResult => ({
  kind: 'response',
  status,
  retryAfterMs,
});

describe('constants', () => {
  it('uses 60 s base and 1 h cap', () => {
    expect(BASE_DELAY_MS).toBe(60_000);
    expect(MAX_DELAY_MS).toBe(3_600_000);
  });
});

describe('classify', () => {
  it.each([200, 204])('marks %i as delivered', (status) => {
    expect(classify(resp(status))).toBe('delivered');
  });

  it.each([408, 425, 429, 500, 503])('retries %i', (status) => {
    expect(classify(resp(status))).toBe('retry');
  });

  it('retries timeouts and network errors', () => {
    expect(classify({ kind: 'timeout' })).toBe('retry');
    expect(classify({ kind: 'network' })).toBe('retry');
  });

  it.each([301, 302])('fails redirect %i', (status) => {
    expect(classify(resp(status))).toBe('failed');
  });

  it.each([400, 401, 403, 404])('fails client error %i', (status) => {
    expect(classify(resp(status))).toBe('failed');
  });

  it.each([100, 199, 600])('fails unusual status %i', (status) => {
    expect(classify(resp(status))).toBe('failed');
  });
});

describe('errorCode', () => {
  it('returns redirect for 3xx', () => {
    expect(errorCode(resp(302))).toBe('redirect');
  });

  it('returns http_<status> for other failures', () => {
    expect(errorCode(resp(502))).toBe('http_502');
    expect(errorCode(resp(404))).toBe('http_404');
    expect(errorCode(resp(100))).toBe('http_100');
  });

  it('returns timeout and network for those kinds', () => {
    expect(errorCode({ kind: 'timeout' })).toBe('timeout');
    expect(errorCode({ kind: 'network' })).toBe('network');
  });

  it('returns null for 2xx', () => {
    expect(errorCode(resp(200))).toBeNull();
    expect(errorCode(resp(204))).toBeNull();
  });
});

describe('nextDelayMs', () => {
  it.each([
    [1, null, 60_000],
    [2, null, 120_000],
    [6, null, 1_920_000],
    [7, null, 3_600_000],
    [20, null, 3_600_000],
    [1, 300_000, 300_000],
    [3, 10_000, 240_000],
    [1, 7_200_000, 3_600_000],
  ])('attempt %i, retryAfter %s -> %i', (attempt, retryAfterMs, expected) => {
    expect(nextDelayMs(attempt, retryAfterMs)).toBe(expected);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0);

  it('reads non-negative integer seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('0', now)).toBe(0);
  });

  it('reads an HTTP date relative to now', () => {
    const date = new Date(now + 90_000).toUTCString();
    expect(parseRetryAfter(date, now)).toBe(90_000);
  });

  it('returns 0 for an HTTP date in the past', () => {
    const date = new Date(now - 90_000).toUTCString();
    expect(parseRetryAfter(date, now)).toBe(0);
  });

  it('returns null for garbage, empty and missing values', () => {
    expect(parseRetryAfter('x', now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('returns null for negative seconds', () => {
    expect(parseRetryAfter('-5', now)).toBeNull();
  });

  it('returns null for signed or fractional seconds', () => {
    expect(parseRetryAfter('+5', now)).toBeNull();
    expect(parseRetryAfter('1.5', now)).toBeNull();
  });
});
