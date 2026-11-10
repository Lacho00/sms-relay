import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { createApp, createScheduled } from '../../src/app';
import { parseConfig, type Config } from '../../src/config';
import { getDeliveries, insertMessage, type DeliveryRow } from '../../src/db/repo';
import worker from '../../src/index';
import { CONCURRENCY, CRON_BATCH, processDeliveries, retryDue, type OutboxDeps } from '../../src/outbox/process';

const TOKEN = (env as unknown as { INGEST_TOKEN: string }).INGEST_TOKEN;
const TG_BASE = 'https://tg.test';
const HOOK_URL = 'https://hook.test/in';
const BOT_TOKEN = '123456:bot-token-value-that-must-not-leak';
const CHAT_ID = '424242';
const HOOK_SECRET = 'webhook-secret-0123456789abcdef0123456789';

const TG_ENV = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHAT_ID: CHAT_ID, TELEGRAM_API_BASE: TG_BASE };
const HOOK_ENV = { WEBHOOK_URL: HOOK_URL, WEBHOOK_SECRET: HOOK_SECRET };

const testEnv = (overrides: Record<string, unknown> = {}): Env => ({ ...env, ...overrides }) as unknown as Env;

const configFor = (overrides: Record<string, unknown>): Config => {
  const r = parseConfig(testEnv(overrides) as unknown as Record<string, unknown>);
  if (!r.ok) throw new Error(`bad test config: ${r.variable}`);
  return r.config;
};

type Seen = { url: string; body: string; mine: boolean };
type Reply = () => Response | Promise<Response>;

/**
 * Scripted fake fetch. Requests whose body carries this test's marker are "mine" and are answered
 * by `reply`; anything else (rows other tests left pending) gets a 200 and is ignored by assertions.
 */
function fakeFetch(marker: string, reply: (url: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    const mine = body.includes(marker);
    seen.push({ url, body, mine });
    if (!mine) return new Response('{}', { status: 200 });
    return reply(url);
  }) as unknown as typeof fetch;
  return { fn, mine: () => seen.filter((s) => s.mine) };
}

const ok: Reply = () => new Response('{"ok":true}', { status: 200 });
const status = (s: number): Reply => () => new Response('{}', { status: s });

let seq = 0;
const marker = () => `m-${++seq}-${crypto.randomUUID()}`;

async function ingest(opts: {
  body: string;
  now: number;
  env: Env;
  fetch: typeof fetch;
  sender?: string;
}): Promise<{ status: number; json: { status: string; id: number } }> {
  const app = createApp({ fetch: opts.fetch, now: () => opts.now });
  const ctx = createExecutionContext();
  const req = new Request('https://relay.test/v1/sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sender: opts.sender ?? 'ACME', body: opts.body, received_at: opts.now - 1000 }),
  });
  const res = await app.fetch(req, opts.env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: (await res.json()) as { status: string; id: number } };
}

const byDest = (rows: DeliveryRow[], d: 'telegram' | 'webhook') => rows.find((r) => r.destination === d)!;

const deps = (config: Config, fetchFn: typeof fetch, at: number): OutboxDeps => ({
  db: env.DB,
  config,
  fetch: fetchFn,
  now: () => at,
});

describe('outbox constants', () => {
  it('uses a cron batch of 50 and a concurrency of 5', () => {
    expect(CRON_BATCH).toBe(50);
    expect(CONCURRENCY).toBe(5);
  });
});

describe('immediate attempt after ingest', () => {
  it('delivers to Telegram and the webhook once each', async () => {
    const now = Date.UTC(2026, 10, 9, 12);
    const m = marker();
    const f = fakeFetch(m, ok);
    const r = await ingest({ body: m, now, env: testEnv({ ...TG_ENV, ...HOOK_ENV }), fetch: f.fn });
    expect(r.json.status).toBe('stored');
    const rows = await getDeliveries(env.DB, r.json.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ status: 'delivered', attempts: 1, lastStatusCode: 200, lockedUntil: null });
    }
    expect(f.mine()).toHaveLength(2);
    expect(f.mine().map((s) => s.url).sort()).toEqual([`${TG_BASE}/bot${BOT_TOKEN}/sendMessage`, HOOK_URL].sort());
  });

  it('never logs the body, sender, token, chat id, secret or URL', async () => {
    const spy = vi.spyOn(console, 'log');
    const now = Date.UTC(2026, 10, 9, 12, 1);
    const m = marker();
    const f = fakeFetch(m, status(502));
    await ingest({ body: m, now, env: testEnv({ ...TG_ENV, ...HOOK_ENV }), fetch: f.fn, sender: 'SECRETSENDER' });
    const lines = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    const events = lines.map((l) => JSON.parse(l) as { event: string });
    expect(events.filter((e) => e.event === 'delivery.retry')).toHaveLength(2);
    for (const l of lines) {
      for (const s of [m, 'SECRETSENDER', BOT_TOKEN, CHAT_ID, HOOK_SECRET, HOOK_URL, TG_BASE]) {
        expect(l).not.toContain(s);
      }
    }
  });

  it('a duplicate ingest causes no request', async () => {
    const now = Date.UTC(2026, 10, 9, 12, 2);
    const m = marker();
    const f = fakeFetch(m, ok);
    const e = testEnv({ ...TG_ENV, ...HOOK_ENV });
    await ingest({ body: m, now, env: e, fetch: f.fn });
    expect(f.mine()).toHaveLength(2);
    const again = await ingest({ body: m, now, env: e, fetch: f.fn });
    expect(again.json.status).toBe('duplicate');
    expect(f.mine()).toHaveLength(2);
  });

  it('sends nothing when no destination is configured', async () => {
    const now = Date.UTC(2026, 10, 9, 12, 3);
    const m = marker();
    const f = fakeFetch(m, ok);
    const r = await ingest({ body: m, now, env: testEnv(), fetch: f.fn });
    expect(r.json.status).toBe('stored');
    expect(f.mine()).toHaveLength(0);
  });
});

describe('retry', () => {
  it('a 502 keeps the delivery pending, then retryDue at now + 60000 delivers it', async () => {
    const now = 7_000_000_000_000;
    const m = marker();
    const e = testEnv(TG_ENV);
    const fail = fakeFetch(m, status(502));
    const r = await ingest({ body: m, now, env: e, fetch: fail.fn });
    const [row] = await getDeliveries(env.DB, r.json.id);
    expect(row).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: now + 60_000,
      lastError: 'http_502',
      lastStatusCode: 502,
      lockedUntil: null,
    });

    const early = fakeFetch(m, ok);
    await retryDue(deps(configFor(TG_ENV), early.fn, now + 59_999));
    expect(early.mine()).toHaveLength(0);
    expect((await getDeliveries(env.DB, r.json.id))[0]!.status).toBe('pending');

    const good = fakeFetch(m, ok);
    const count = await retryDue(deps(configFor(TG_ENV), good.fn, now + 60_000));
    expect(count).toBeGreaterThanOrEqual(1);
    expect(good.mine()).toHaveLength(1);
    expect((await getDeliveries(env.DB, r.json.id))[0]).toMatchObject({
      status: 'delivered',
      attempts: 2,
      lastError: null,
      deliveredAt: now + 60_000,
    });
  });

  it('fails after MAX_ATTEMPTS and a later retryDue sends nothing', async () => {
    const now = 7_100_000_000_000;
    const m = marker();
    const over = { ...TG_ENV, MAX_ATTEMPTS: '3' };
    const f = fakeFetch(m, status(503));
    const r = await ingest({ body: m, now, env: testEnv(over), fetch: f.fn });
    const cfg = configFor(over);
    // Backoff after attempts 1 and 2: 60 s, then 120 s.
    await retryDue(deps(cfg, f.fn, now + 60_000));
    expect((await getDeliveries(env.DB, r.json.id))[0]).toMatchObject({ status: 'pending', attempts: 2 });
    await retryDue(deps(cfg, f.fn, now + 180_000));
    expect((await getDeliveries(env.DB, r.json.id))[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
      lastError: 'http_503',
      lastStatusCode: 503,
    });
    expect(f.mine()).toHaveLength(3);
    await retryDue(deps(cfg, f.fn, now + 100_000_000));
    expect(f.mine()).toHaveLength(3);
  });

  it('a 400 fails at once', async () => {
    const now = 7_200_000_000_000;
    const m = marker();
    const f = fakeFetch(m, status(400));
    const r = await ingest({ body: m, now, env: testEnv(TG_ENV), fetch: f.fn });
    expect((await getDeliveries(env.DB, r.json.id))[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'http_400',
      lastStatusCode: 400,
    });
  });

  it('a network error is retried with a null status code', async () => {
    const now = 7_250_000_000_000;
    const m = marker();
    const f = fakeFetch(m, () => {
      throw new TypeError('network down');
    });
    const r = await ingest({ body: m, now, env: testEnv(TG_ENV), fetch: f.fn });
    expect((await getDeliveries(env.DB, r.json.id))[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'network',
      lastStatusCode: null,
      nextAttemptAt: now + 60_000,
    });
  });

  it('uses a larger Retry-After from the webhook', async () => {
    const now = 7_270_000_000_000;
    const m = marker();
    const f = fakeFetch(m, () => new Response('', { status: 429, headers: { 'Retry-After': '300' } }));
    const r = await ingest({ body: m, now, env: testEnv(HOOK_ENV), fetch: f.fn });
    expect((await getDeliveries(env.DB, r.json.id))[0]).toMatchObject({
      status: 'pending',
      lastError: 'http_429',
      nextAttemptAt: now + 300_000,
    });
  });

  it('marks a delivery failed with destination_removed when its config is gone', async () => {
    const now = 7_300_000_000_000;
    const m = marker();
    const f = fakeFetch(m, status(502));
    const r = await ingest({ body: m, now, env: testEnv({ ...TG_ENV, ...HOOK_ENV }), fetch: f.fn });
    const later = fakeFetch(m, ok);
    await retryDue(deps(configFor(HOOK_ENV), later.fn, now + 60_000));
    const rows = await getDeliveries(env.DB, r.json.id);
    expect(byDest(rows, 'telegram')).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'destination_removed',
      lockedUntil: null,
    });
    expect(byDest(rows, 'webhook')).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(later.mine().map((s) => s.url)).toEqual([HOOK_URL]);
  });
});

describe('processDeliveries', () => {
  const seed = async (m: string, dests: ('telegram' | 'webhook')[], at: number) =>
    (
      await insertMessage(
        env.DB,
        { sender: 'ACME', body: m, receivedAt: at - 1000, sim: null, device: null },
        `k-${crypto.randomUUID()}`,
        dests,
        at,
      )
    ).deliveryIds;

  it('two concurrent runs for the same id send exactly once (lease)', async () => {
    const now = 7_400_000_000_000;
    const m = marker();
    const [id] = await seed(m, ['telegram'], now);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeFetch(m, async () => {
      await gate;
      return new Response('{}', { status: 200 });
    });
    const d = deps(configFor(TG_ENV), f.fn, now);
    const a = processDeliveries(d, [id!]);
    const b = processDeliveries(d, [id!]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([a, b]);
    expect(f.mine()).toHaveLength(1);
    const [row] = await getDeliveries(env.DB, (await env.DB.prepare('SELECT message_id FROM deliveries WHERE id = ?').bind(id!).first<{ message_id: number }>())!.message_id);
    expect(row).toMatchObject({ status: 'delivered', attempts: 1 });
  });

  it('a destination whose fetch throws does not stop the other delivery', async () => {
    const now = 7_500_000_000_000;
    const m = marker();
    const ids = await seed(m, ['telegram', 'webhook'], now);
    const f = fakeFetch(m, (url) => {
      if (url.startsWith(TG_BASE)) throw new Error('boom');
      return new Response('', { status: 200 });
    });
    await processDeliveries(deps(configFor({ ...TG_ENV, ...HOOK_ENV }), f.fn, now), ids);
    const msg = await env.DB.prepare('SELECT message_id FROM deliveries WHERE id = ?').bind(ids[0]!).first<{ message_id: number }>();
    const rows = await getDeliveries(env.DB, msg!.message_id);
    expect(byDest(rows, 'telegram')).toMatchObject({ status: 'pending', attempts: 1, lastError: 'network' });
    expect(byDest(rows, 'webhook')).toMatchObject({ status: 'delivered', attempts: 1 });
  });

  it('an unexpected exception after the claim is logged, leaves the row leased, and spares the others', async () => {
    const spy = vi.spyOn(console, 'log');
    const now = 7_600_000_000_000;
    const m = marker();
    const ids = await seed(m, ['telegram', 'webhook'], now);
    const f = fakeFetch(m, (url) => {
      if (url.startsWith(TG_BASE)) {
        // Breaks inside the sender, past its own error handling.
        return { status: 200, text: async () => '', headers: { get: () => { throw new Error('bad'); } } } as unknown as Response;
      }
      return new Response('', { status: 200 });
    });
    await processDeliveries(deps(configFor({ ...TG_ENV, ...HOOK_ENV }), f.fn, now), ids);
    const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    spy.mockRestore();
    const msg = await env.DB.prepare('SELECT message_id FROM deliveries WHERE id = ?').bind(ids[0]!).first<{ message_id: number }>();
    const rows = await getDeliveries(env.DB, msg!.message_id);
    const tg = byDest(rows, 'telegram');
    expect(tg).toMatchObject({ status: 'pending', attempts: 0, lockedUntil: now + 60_000 });
    expect(byDest(rows, 'webhook')).toMatchObject({ status: 'delivered' });
    expect(lines).toContainEqual({ event: 'internal.error', deliveryId: tg.id, error: 'internal' });
  });

  it('marks a delivery failed with message_missing when its message is gone', async () => {
    const now = 7_700_000_000_000;
    const m = marker();
    const [id] = await seed(m, ['telegram'], now);
    // A D1 wrapper whose message lookup finds nothing, as if retention ran between claim and read.
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes('FROM messages')) return stmt;
            return { bind: () => ({ first: async () => null }) };
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as D1Database;
    const f = fakeFetch(m, ok);
    await processDeliveries({ ...deps(configFor(TG_ENV), f.fn, now), db }, [id!]);
    expect(f.mine()).toHaveLength(0);
    const r = await env.DB.prepare('SELECT status, attempts, last_error FROM deliveries WHERE id = ?').bind(id!).first();
    expect(r).toEqual({ status: 'failed', attempts: 1, last_error: 'message_missing' });
  });

  it('processes more ids than the concurrency limit', async () => {
    const now = 7_800_000_000_000;
    const m = marker();
    const ids: number[] = [];
    for (let i = 0; i < CONCURRENCY + 3; i++) ids.push(...(await seed(`${m} ${i}`, ['webhook'], now)));
    let inFlight = 0;
    let peak = 0;
    const f = fakeFetch(m, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response('', { status: 200 });
    });
    await processDeliveries(deps(configFor(HOOK_ENV), f.fn, now), ids);
    expect(f.mine()).toHaveLength(ids.length);
    expect(peak).toBeLessThanOrEqual(CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it('does nothing for an empty list', async () => {
    const f = fakeFetch('none', ok);
    await processDeliveries(deps(configFor(TG_ENV), f.fn, 1), []);
    expect(f.fn).not.toHaveBeenCalled();
  });
});

describe('scheduled', () => {
  it('runs through the default export with the env config (no destinations)', async () => {
    const controller = createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' });
    const ctx = createExecutionContext();
    await worker.scheduled!(controller, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
  });

  it('retries due deliveries with injected fetch and clock', async () => {
    const now = 7_900_000_000_000;
    const m = marker();
    const fail = fakeFetch(m, status(500));
    const r = await ingest({ body: m, now, env: testEnv(TG_ENV), fetch: fail.fn });
    const good = fakeFetch(m, ok);
    const scheduled = createScheduled({ fetch: good.fn, now: () => now + 60_000 });
    const ctx = createExecutionContext();
    await scheduled(createScheduledController({ scheduledTime: now + 60_000, cron: '* * * * *' }), testEnv(TG_ENV), ctx);
    await waitOnExecutionContext(ctx);
    expect(good.mine()).toHaveLength(1);
    expect((await getDeliveries(env.DB, r.json.id))[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('logs config.invalid and sends nothing when the config is invalid', async () => {
    const spy = vi.spyOn(console, 'log');
    const f = fakeFetch('none', ok);
    const scheduled = createScheduled({ fetch: f.fn, now: () => 9_000_000_000_000 });
    const ctx = createExecutionContext();
    await scheduled(createScheduledController(), testEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), ctx);
    await waitOnExecutionContext(ctx);
    const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    spy.mockRestore();
    expect(lines).toContainEqual({ event: 'config.invalid', variable: 'TELEGRAM_CHAT_ID' });
    expect(f.fn).not.toHaveBeenCalled();
  });
});
