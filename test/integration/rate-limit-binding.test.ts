import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app';

it('the real ingest binding returns 429 within 121 requests from one IP', async () => {
  const app = createApp();
  const statuses: number[] = [];
  for (let i = 0; i < 130; i++) {
    const res = await app.request(
      'https://relay.test/v1/sms',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong',
          'CF-Connecting-IP': '198.51.100.9',
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
      env,
    );
    statuses.push(res.status);
    if (res.status === 429) break;
  }
  const first = statuses.indexOf(429);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(first + 1).toBeLessThanOrEqual(121);
});
