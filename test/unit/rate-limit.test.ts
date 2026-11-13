import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowed, rateLimitedResponse, rateLimitKey } from '../../src/http/rate-limit';

afterEach(() => vi.restoreAllMocks());

const req = (ip?: string) => new Request('https://relay.test/x', ip ? { headers: { 'CF-Connecting-IP': ip } } : {});

describe('rateLimitKey', () => {
  it('uses the connecting IP', () => {
    expect(rateLimitKey('ingest', req('203.0.113.7'))).toBe('ingest:203.0.113.7');
  });
  it('falls back to unknown', () => {
    expect(rateLimitKey('read', req())).toBe('read:unknown');
  });
});

describe('isAllowed', () => {
  it('follows the limiter and passes the key', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    expect(await isAllowed({ limit }, 'ingest', req('1.2.3.4'))).toBe(false);
    expect(limit).toHaveBeenCalledWith({ key: 'ingest:1.2.3.4' });
    expect(await isAllowed({ limit: async () => ({ success: true }) }, 'read', req())).toBe(true);
  });
  it('fails open and logs once when the limiter throws', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const limiter = {
      limit: async () => {
        throw new Error('down 1.2.3.4');
      },
    };
    expect(await isAllowed(limiter, 'ingest', req('1.2.3.4'))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]![0] as string;
    expect(JSON.parse(line)).toEqual({ event: 'internal.error', error: 'rate_limit_unavailable' });
    expect(line).not.toMatch(/1\.2\.3\.4/);
  });
});

describe('rateLimitedResponse', () => {
  it('is a 429 with Retry-After', async () => {
    const res = rateLimitedResponse();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.text()).toBe('{"error":"rate_limited","message":"Too many requests"}');
  });
});
