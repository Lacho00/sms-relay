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
    await markDelivered(env.DB, id!, 1, 200, 1000);
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
    await claimDelivery(env.DB, id!, 1000);
    await markDelivered(env.DB, id!, 2, 200, 3000);
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
    await claimDelivery(env.DB, id!, 1000);
    await markRetry(env.DB, id!, 1, 9000, 'http_502', 502, 3000);
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
    await claimDelivery(env.DB, id!, 1000);
    await markFailed(env.DB, id!, 3, 'timeout', null, 3000);
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
    await markDelivered(env.DB, id!, 1, 200, 2000);
    await markRetry(env.DB, id!, 5, 9999, 'http_500', 500, 3000);
    await markFailed(env.DB, id!, 6, 'x', 500, 3000);
    expect(await row(id!)).toMatchObject({ status: 'delivered', attempts: 1, updatedAt: 2000, lastError: null });
  });
});
