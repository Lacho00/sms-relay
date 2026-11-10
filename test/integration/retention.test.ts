import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduled } from '../../src/app';
import { getDeliveries, getMessage, insertMessage } from '../../src/db/repo';
import { purgeExpired } from '../../src/retention';
import type { Destination } from '../../src/log';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const TG_BASE = 'https://tg.test';
const BOT_TOKEN = '123456:retention-bot-token-value';
const CHAT_ID = '515151';

const testEnv = (overrides: Record<string, unknown> = {}): Env => ({ ...env, ...overrides }) as unknown as Env;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM deliveries'), env.DB.prepare('DELETE FROM messages')]);
});

/** Stores a message as if it were created at `createdAt`, with one pending delivery per destination. */
async function store(key: string, createdAt: number, destinations: Destination[] = ['telegram', 'webhook']) {
  const r = await insertMessage(
    env.DB,
    { sender: 'ACME', body: `body ${key}`, receivedAt: createdAt, sim: null, device: null },
    key,
    destinations,
    createdAt,
  );
  expect(r.status).toBe('stored');
  return r.id;
}

async function countRows(table: 'messages' | 'deliveries'): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return r!.n;
}

describe('purgeExpired', () => {
  it('deletes messages older than the retention window, with their deliveries, and keeps newer ones', async () => {
    const old = await store('old', NOW - 31 * DAY);
    const recent = await store('recent', NOW - 29 * DAY);

    const count = await purgeExpired(env.DB, 30, NOW);

    expect(count).toBe(1);
    expect(await getMessage(env.DB, old)).toBeNull();
    expect(await getDeliveries(env.DB, old)).toEqual([]);
    expect(await getMessage(env.DB, recent)).not.toBeNull();
    expect((await getDeliveries(env.DB, recent)).length).toBe(2);
  });

  it('keeps a message created exactly at the cutoff (the comparison is strict)', async () => {
    const edge = await store('edge', NOW - 30 * DAY);
    expect(await purgeExpired(env.DB, 30, NOW)).toBe(0);
    expect(await getMessage(env.DB, edge)).not.toBeNull();
  });

  it('deletes nothing when retentionDays is 0 (keep forever)', async () => {
    const ancient = await store('ancient', NOW - 3650 * DAY);
    expect(await purgeExpired(env.DB, 0, NOW)).toBe(0);
    expect(await getMessage(env.DB, ancient)).not.toBeNull();
    expect((await getDeliveries(env.DB, ancient)).length).toBe(2);
  });

  it('deletes at most 500 per call, then the rest on the next call', async () => {
    const createdAt = NOW - 40 * DAY;
    // Chunked so each D1 batch stays small; 600 expired messages in total.
    for (let start = 0; start < 600; start += 100) {
      const stmts = [];
      for (let i = start; i < start + 100; i++) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO messages (dedup_key, sender, body, received_at, sim, device, created_at, ingest_nonce)
             VALUES (?, 'ACME', 'b', ?, NULL, NULL, ?, 'n')`,
          ).bind(`bulk-${i}`, createdAt, createdAt),
        );
      }
      await env.DB.batch(stmts);
    }
    expect(await countRows('messages')).toBe(600);

    expect(await purgeExpired(env.DB, 30, NOW)).toBe(500);
    expect(await countRows('messages')).toBe(100);

    expect(await purgeExpired(env.DB, 30, NOW)).toBe(100);
    expect(await countRows('messages')).toBe(0);
  });

  it('stores the same SMS again after it was purged (known limit: the dedup key goes with the message)', async () => {
    const key = 'repeat-after-purge';
    await store(key, NOW - 40 * DAY);
    expect(await purgeExpired(env.DB, 30, NOW)).toBe(1);

    const again = await insertMessage(
      env.DB,
      { sender: 'ACME', body: 'body again', receivedAt: NOW, sim: null, device: null },
      key,
      ['telegram', 'webhook'],
      NOW,
    );
    expect(again.status).toBe('stored');
    expect((await getDeliveries(env.DB, again.id)).length).toBe(2);
  });
});

describe('createScheduled retention', () => {
  it('purges before retrying: an expired message with a due delivery is not sent', async () => {
    const expired = await store('expired-due', NOW - 40 * DAY, ['telegram']);
    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const scheduled = createScheduled({ fetch: fetchFn as unknown as typeof fetch, now: () => NOW });
    const cfg = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHAT_ID: CHAT_ID, TELEGRAM_API_BASE: TG_BASE };
    const ctx = createExecutionContext();

    await scheduled(createScheduledController({ scheduledTime: NOW, cron: '* * * * *' }), testEnv(cfg), ctx);
    await waitOnExecutionContext(ctx);

    expect(await getMessage(env.DB, expired)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('logs retention.purged with the count when something was purged', async () => {
    await store('log-a', NOW - 40 * DAY);
    await store('log-b', NOW - 41 * DAY);
    const spy = vi.spyOn(console, 'log');
    const scheduled = createScheduled({ fetch: vi.fn() as unknown as typeof fetch, now: () => NOW });
    const ctx = createExecutionContext();

    await scheduled(createScheduledController({ scheduledTime: NOW, cron: '* * * * *' }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    spy.mockRestore();

    expect(lines).toContainEqual({ event: 'retention.purged', count: 2 });
  });

  it('does not log retention.purged when nothing was purged', async () => {
    await store('fresh', NOW - 1 * DAY);
    const spy = vi.spyOn(console, 'log');
    const scheduled = createScheduled({ fetch: vi.fn() as unknown as typeof fetch, now: () => NOW });
    const ctx = createExecutionContext();

    await scheduled(createScheduledController({ scheduledTime: NOW, cron: '* * * * *' }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    const events = spy.mock.calls.map((c) => (JSON.parse(String(c[0])) as { event: string }).event);
    spy.mockRestore();

    expect(events).not.toContain('retention.purged');
  });
});

describe('createScheduled when the purge fails', () => {
  it('logs retention.failed and still retries the due delivery', async () => {
    const m = `fail-purge-${crypto.randomUUID()}`;
    const id = await store(m, NOW, ['telegram']);
    // Every batch rejects, so purgeExpired throws; other calls go to the real DB.
    const failingDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') return () => Promise.reject(new Error('purge boom'));
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const spy = vi.spyOn(console, 'log');
    const scheduled = createScheduled({ fetch: fetchFn as unknown as typeof fetch, now: () => NOW });
    const ctx = createExecutionContext();
    const cfg = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHAT_ID: CHAT_ID, TELEGRAM_API_BASE: TG_BASE, DB: failingDb };

    await scheduled(createScheduledController({ scheduledTime: NOW, cron: '* * * * *' }), testEnv(cfg), ctx);
    await waitOnExecutionContext(ctx);
    const lines = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();

    expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toContain('retention.failed');
    expect(lines.join('\n')).not.toContain('purge boom');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await getDeliveries(env.DB, id))[0]).toMatchObject({ status: 'delivered' });
  });
});
