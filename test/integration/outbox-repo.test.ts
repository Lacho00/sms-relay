import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  LEASE_MS,
  claimDelivery,
  dueDeliveryIds,
  getDeliveries,
  insertMessage,
  markDelivered,
  markFailed,
  markRetry,
} from '../../src/db/repo';

const seed = async (dests: ('telegram' | 'webhook')[], at: number) => {
  const r = await insertMessage(
    env.DB,
    { sender: 'ACME', body: 'hi', receivedAt: 1, sim: null, device: null },
    `k-${crypto.randomUUID()}`,
    dests,
    at,
  );
  return r.deliveryIds;
};
const row = async (id: number) => {
  const r = await env.DB.prepare('SELECT message_id FROM deliveries WHERE id = ?').bind(id).first<{ message_id: number }>();
  return (await getDeliveries(env.DB, r!.message_id)).find((d) => d.id === id)!;
};

describe('claimDelivery', () => {
  it('claims a due pending row and sets the lease', async () => {
    const [id] = await seed(['telegram'], 1000);
    const claimed = await claimDelivery(env.DB, id!, 1000);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(id);
    expect(claimed!.lockedUntil).toBe(1000 + LEASE_MS);
    expect(LEASE_MS).toBe(60_000);
  });

  it('counts the attempt at claim time', async () => {
    const [id] = await seed(['telegram'], 1000);
    expect((await claimDelivery(env.DB, id!, 1000))!.attempts).toBe(1);
    const again = await claimDelivery(env.DB, id!, 1000 + 60_001);
    expect(again!.attempts).toBe(2);
    expect((await row(id!)).attempts).toBe(2);
  });

  it('refuses a second claim while leased, then allows it after expiry', async () => {
    const [id] = await seed(['telegram'], 1000);
    expect(await claimDelivery(env.DB, id!, 1000)).not.toBeNull();
    expect(await claimDelivery(env.DB, id!, 1000)).toBeNull();
    const again = await claimDelivery(env.DB, id!, 1000 + 60_001);
    expect(again).not.toBeNull();
    expect(again!.lockedUntil).toBe(1000 + 60_001 + LEASE_MS);
  });

  it('refuses a row that is not yet due', async () => {
    const [id] = await seed(['telegram'], 5000);
    expect(await claimDelivery(env.DB, id!, 4999)).toBeNull();
  });

  it('refuses a delivered row', async () => {
    const [id] = await seed(['telegram'], 1000);
    const c = await claimDelivery(env.DB, id!, 1000);
    expect(await markDelivered(env.DB, id!, c!.lockedUntil!, 1, 200, 1000)).toBe(true);
    expect(await claimDelivery(env.DB, id!, 2000)).toBeNull();
  });
});

describe('dueDeliveryIds', () => {
  it('returns due, unleased, pending ids oldest first and respects the limit', async () => {
    const base = 9_000_000_000_000;
    const [late] = await seed(['telegram'], base + 20);
    const [early] = await seed(['telegram'], base + 10);
    const [leased] = await seed(['telegram'], base + 5);
    const [future] = await seed(['telegram'], base + 1000);
    await claimDelivery(env.DB, leased!, base + 100);
    const now = base + 200;
    const ids = await dueDeliveryIds(env.DB, now, 1000);
    const mine = ids.filter((i) => [late, early, leased, future].includes(i));
    expect(mine).toEqual([early, late]);
    const first = await dueDeliveryIds(env.DB, now, 1);
    expect(first).toHaveLength(1);
    expect(first[0]).toBe(ids[0]);
  });
});

describe('mark*', () => {
  it('markDelivered sets the terminal state', async () => {
    const [id] = await seed(['telegram'], 1000);
    const c = await claimDelivery(env.DB, id!, 1000);
    expect(await markDelivered(env.DB, id!, c!.lockedUntil!, 2, 200, 3000)).toBe(true);
    expect(await row(id!)).toMatchObject({
      status: 'delivered',
      attempts: 2,
      lastStatusCode: 200,
      lastError: null,
      deliveredAt: 3000,
      lockedUntil: null,
      updatedAt: 3000,
    });
  });

  it('markRetry keeps the row pending and schedules the next attempt', async () => {
    const [id] = await seed(['telegram'], 1000);
    const c = await claimDelivery(env.DB, id!, 1000);
    expect(await markRetry(env.DB, id!, c!.lockedUntil!, 1, 9000, 'http_502', 502, 3000)).toBe(true);
    expect(await row(id!)).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 9000,
      lastError: 'http_502',
      lastStatusCode: 502,
      lockedUntil: null,
      updatedAt: 3000,
    });
  });

  it('markFailed sets the failed state', async () => {
    const [id] = await seed(['telegram'], 1000);
    const c = await claimDelivery(env.DB, id!, 1000);
    expect(await markFailed(env.DB, id!, c!.lockedUntil!, 3, 'timeout', null, 3000)).toBe(true);
    expect(await row(id!)).toMatchObject({
      status: 'failed',
      attempts: 3,
      lastError: 'timeout',
      lastStatusCode: null,
      lockedUntil: null,
      updatedAt: 3000,
    });
  });

  it('never rewrites a terminal row', async () => {
    const [id] = await seed(['telegram'], 1000);
    const c = await claimDelivery(env.DB, id!, 1000);
    const lease = c!.lockedUntil!;
    await markDelivered(env.DB, id!, lease, 1, 200, 2000);
    expect(await markRetry(env.DB, id!, lease, 5, 9999, 'http_500', 500, 3000)).toBe(false);
    expect(await markFailed(env.DB, id!, lease, 6, 'x', 500, 3000)).toBe(false);
    expect(await row(id!)).toMatchObject({ status: 'delivered', attempts: 1, updatedAt: 2000, lastError: null });
  });

  it('a stale lease token changes nothing and returns false', async () => {
    const [id] = await seed(['telegram'], 1000);
    const stale = (await claimDelivery(env.DB, id!, 1000))!.lockedUntil!;
    // The lease expires and another worker claims the row.
    const fresh = (await claimDelivery(env.DB, id!, 1000 + 60_001))!;
    expect(await markDelivered(env.DB, id!, stale, 1, 200, 70_000)).toBe(false);
    expect(await markRetry(env.DB, id!, stale, 1, 99_000, 'http_502', 502, 70_000)).toBe(false);
    expect(await markFailed(env.DB, id!, stale, 1, 'http_400', 400, 70_000)).toBe(false);
    expect(await markFailed(env.DB, id!, stale + 1, 1, 'http_400', 400, 70_000)).toBe(false);
    expect(await row(id!)).toMatchObject({ status: 'pending', attempts: 2, lockedUntil: fresh.lockedUntil, lastError: null });
    expect(await markDelivered(env.DB, id!, fresh.lockedUntil!, 2, 200, 70_000)).toBe(true);
  });
});
