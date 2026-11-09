import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getDeliveries, getMessage, insertMessage } from '../../src/db/repo';
import type { IngestInput } from '../../src/ingest/schema';

let n = 0;
const input = (): IngestInput => ({
  sender: 'ACME',
  body: 'hello',
  receivedAt: 1_700_000_000_000,
  sim: 1,
  device: 'phone',
});
const freshKey = () => `key-${++n}-${crypto.randomUUID()}`;
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>())!.c;

describe('insertMessage', () => {
  it('stores a message with one pending delivery per destination', async () => {
    const key = freshKey();
    const r = await insertMessage(env.DB, input(), key, ['telegram', 'webhook'], 5000);
    expect(r.status).toBe('stored');
    expect(r.deliveryIds).toHaveLength(2);
    const rows = await getDeliveries(env.DB, r.id);
    expect(rows.map((d) => d.destination)).toEqual(['telegram', 'webhook']);
    for (const d of rows) {
      expect(d.status).toBe('pending');
      expect(d.attempts).toBe(0);
      expect(d.nextAttemptAt).toBe(5000);
      expect(d.lockedUntil).toBeNull();
      expect(d.createdAt).toBe(5000);
    }
    expect(rows.map((d) => d.id)).toEqual(r.deliveryIds);
    const m = await getMessage(env.DB, r.id);
    expect(m).toEqual({
      id: r.id,
      sender: 'ACME',
      body: 'hello',
      receivedAt: 1_700_000_000_000,
      sim: 1,
      device: 'phone',
      createdAt: 5000,
    });
  });

  it('reports a duplicate without adding deliveries', async () => {
    const key = freshKey();
    const a = await insertMessage(env.DB, input(), key, ['telegram', 'webhook'], 1);
    const b = await insertMessage(env.DB, input(), key, ['telegram', 'webhook'], 2);
    expect(b).toEqual({ status: 'duplicate', id: a.id, deliveryIds: [] });
    expect(await getDeliveries(env.DB, a.id)).toHaveLength(2);
  });

  it('never adds deliveries to a message stored with none', async () => {
    const key = freshKey();
    const a = await insertMessage(env.DB, input(), key, [], 1);
    expect(a.deliveryIds).toEqual([]);
    const b = await insertMessage(env.DB, input(), key, ['telegram'], 2);
    expect(b.status).toBe('duplicate');
    expect(await getDeliveries(env.DB, a.id)).toHaveLength(0);
  });

  it('keeps nullable fields null', async () => {
    const r = await insertMessage(
      env.DB,
      { ...input(), sim: null, device: null },
      freshKey(),
      [],
      1,
    );
    const m = await getMessage(env.DB, r.id);
    expect(m?.sim).toBeNull();
    expect(m?.device).toBeNull();
  });

  it('lets exactly one of two concurrent inserts win', async () => {
    const key = freshKey();
    const before = await count('messages');
    const [a, b] = await Promise.all([
      insertMessage(env.DB, input(), key, ['telegram'], 1),
      insertMessage(env.DB, input(), key, ['telegram'], 1),
    ]);
    expect([a.status, b.status].sort()).toEqual(['duplicate', 'stored']);
    expect(a.id).toBe(b.id);
    expect((await count('messages')) - before).toBe(1);
    expect(await getDeliveries(env.DB, a.id)).toHaveLength(1);
  });
});

describe('getMessage', () => {
  it('returns null for an unknown id', async () => {
    expect(await getMessage(env.DB, 999_999)).toBeNull();
  });
});
