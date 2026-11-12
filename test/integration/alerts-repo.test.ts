import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { claimAlerts, insertMessage, releaseAlerts } from '../../src/db/repo';

const seed = async (status: string, alertedAt: number | null) => {
  const r = await insertMessage(
    env.DB,
    { sender: 'ACME', body: 'hi', receivedAt: 1, sim: null, device: null },
    `k-${crypto.randomUUID()}`,
    ['telegram'],
    1000,
  );
  const id = r.deliveryIds[0]!;
  await env.DB.prepare('UPDATE deliveries SET status = ?, alerted_at = ?, last_error = ? WHERE id = ?')
    .bind(status, alertedAt, status === 'failed' ? 'http_404' : null, id)
    .run();
  return id;
};
const alertedAt = async (id: number) =>
  (await env.DB.prepare('SELECT alerted_at FROM deliveries WHERE id = ?').bind(id).first<{ alerted_at: number | null }>())!
    .alerted_at;

describe('claimAlerts', () => {
  it('returns failed, unalerted rows oldest first', async () => {
    await env.DB.prepare('DELETE FROM deliveries').run();
    const a = await seed('failed', null);
    await seed('failed', 10);
    await seed('pending', null);
    await seed('delivered', null);
    const b = await seed('failed', null);
    const rows = await claimAlerts(env.DB, 5000, 20);
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    expect(rows[0]).toMatchObject({ destination: 'telegram', lastError: 'http_404', attempts: 0 });
    expect(typeof rows[0]!.messageId).toBe('number');
    expect(await alertedAt(a)).toBe(5000);
    expect(await alertedAt(b)).toBe(5000);
  });

  it('respects the limit', async () => {
    await env.DB.prepare('DELETE FROM deliveries').run();
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) ids.push(await seed('failed', null));
    const first = await claimAlerts(env.DB, 5000, 20);
    expect(first.map((r) => r.id)).toEqual(ids.slice(0, 20));
    const second = await claimAlerts(env.DB, 5001, 20);
    expect(second.map((r) => r.id)).toEqual(ids.slice(20));
    expect(await claimAlerts(env.DB, 5002, 20)).toEqual([]);
  });
});

describe('releaseAlerts', () => {
  it('resets only its own claim', async () => {
    await env.DB.prepare('DELETE FROM deliveries').run();
    const a = await seed('failed', null);
    const b = await seed('failed', null);
    const rows = await claimAlerts(env.DB, 5000, 20);
    await env.DB.prepare('UPDATE deliveries SET alerted_at = 6000 WHERE id = ?').bind(b).run();
    await releaseAlerts(env.DB, rows.map((r) => r.id), 5000);
    expect(await alertedAt(a)).toBeNull();
    expect(await alertedAt(b)).toBe(6000);
  });

  it('does nothing for an empty list', async () => {
    await expect(releaseAlerts(env.DB, [], 5000)).resolves.toBeUndefined();
  });
});
