import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /health', () => {
  it('answers 200 with status ok', async () => {
    const res = await SELF.fetch('https://x/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers 404 JSON for an unknown path', async () => {
    const res = await SELF.fetch('https://x/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: 'Not found' });
  });

  it('answers 404 (not 405 or 3xx) for POST /health', async () => {
    const res = await SELF.fetch('https://x/health', { method: 'POST', redirect: 'manual' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: 'Not found' });
  });
});
