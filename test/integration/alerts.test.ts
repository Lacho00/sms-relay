import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendAlerts } from '../../src/alerts';
import { createScheduled, runCronSteps } from '../../src/app';
import { parseConfig, type Config } from '../../src/config';
import { insertMessage } from '../../src/db/repo';
import type { OutboxDeps } from '../../src/outbox/process';

const TG_BASE = 'https://tg.test';
const HOOK_URL = 'https://hook.test/in';
const TG_ENV = { TELEGRAM_BOT_TOKEN: '123456:alert-bot-token', TELEGRAM_CHAT_ID: '777', TELEGRAM_API_BASE: TG_BASE };
const HOOK_ENV = { WEBHOOK_URL: HOOK_URL, WEBHOOK_SECRET: 'webhook-secret-0123456789abcdef0123456789' };

const testEnv = (overrides: Record<string, unknown> = {}): Env => ({ ...env, ...overrides }) as unknown as Env;
const configFor = (overrides: Record<string, unknown>): Config => {
  const r = parseConfig(testEnv(overrides) as unknown as Record<string, unknown>);
  if (!r.ok) throw new Error(`bad test config: ${r.variable}`);
  return r.config;
};
const deps = (config: Config, fetchFn: typeof fetch, at: number): OutboxDeps => ({
  db: env.DB,
  config,
  fetch: fetchFn,
  now: () => at,
});

type Seen = { url: string; text: string };
/** Alert requests are the ones whose text starts with `sms-relay:`; anything else is a delivery. */
function fakeFetch(opts: { alert?: () => Response | Promise<Response>; delivery?: () => Response } = {}) {
  const alerts: Seen[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const payload = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
    if (payload.text?.startsWith('sms-relay:')) {
      alerts.push({ url, text: payload.text });
      return opts.alert ? opts.alert() : new Response('{"ok":true}', { status: 200 });
    }
    return opts.delivery ? opts.delivery() : new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, alerts };
}

const lines = (text: string) => text.split('\n').filter((l) => l.startsWith('message '));

async function seedFailed(n: number, at: number, alertedAt: number | null = null): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await insertMessage(
      env.DB,
      { sender: 'ACME', body: `b-${i}`, receivedAt: at - 1000, sim: null, device: null },
      `k-${crypto.randomUUID()}`,
      ['webhook'],
      at,
    );
    ids.push(r.deliveryIds[0]!);
  }
  const marks = ids.map(() => '?').join(', ');
  await env.DB
    .prepare(
      `UPDATE deliveries SET status = 'failed', attempts = 1, last_error = 'http_404', alerted_at = ? WHERE id IN (${marks})`,
    )
    .bind(alertedAt, ...ids)
    .run();
  return ids;
}

const alertedAts = async (ids: number[]) =>
  (
    await env.DB
      .prepare(`SELECT alerted_at FROM deliveries WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`)
      .bind(...ids)
      .all<{ alerted_at: number | null }>()
  ).results.map((r) => r.alerted_at);

async function cron(fetchFn: typeof fetch, at: number, e: Env) {
  const ctx = createExecutionContext();
  await createScheduled({ fetch: fetchFn, now: () => at })(createScheduledController({ scheduledTime: at, cron: '* * * * *' }), e, ctx);
  await waitOnExecutionContext(ctx);
}

const logged = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])) as Record<string, unknown>);

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM deliveries').run();
  await env.DB.prepare('DELETE FROM messages').run();
});

describe('failure alerts', () => {
  it('a delivery that fails in this run is alerted in the same run', async () => {
    const at = 8_100_000_000_000;
    const r = await insertMessage(
      env.DB,
      { sender: 'ACME', body: 'x', receivedAt: at - 1000, sim: null, device: null },
      `k-${crypto.randomUUID()}`,
      ['webhook'],
      at,
    );
    const f = fakeFetch({ delivery: () => new Response('{}', { status: 404 }) });
    await cron(f.fn, at + 1, testEnv({ ...TG_ENV, ...HOOK_ENV }));
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]!.url).toBe(`${TG_BASE}/bot${TG_ENV.TELEGRAM_BOT_TOKEN}/sendMessage`);
    expect(f.alerts[0]!.text).toContain(`message ${r.id} · webhook · http_404 · 1 attempt`);
  });

  it('batches of 20, one message per run', async () => {
    const at = 8_110_000_000_000;
    await seedFailed(25, at);
    const f = fakeFetch();
    const e = testEnv(TG_ENV);
    await cron(f.fn, at + 1, e);
    await cron(f.fn, at + 2, e);
    await cron(f.fn, at + 3, e);
    expect(f.alerts.map((a) => lines(a.text).length)).toEqual([20, 5]);
  });

  it('a retryable Telegram error releases the claim', async () => {
    const at = 8_120_000_000_000;
    const ids = await seedFailed(2, at);
    const spy = vi.spyOn(console, 'log');
    const bad = fakeFetch({ alert: () => new Response('{}', { status: 502 }) });
    await sendAlerts(deps(configFor(TG_ENV), bad.fn, at + 1));
    const events = logged(spy);
    spy.mockRestore();
    expect(await alertedAts(ids)).toEqual([null, null]);
    expect(events).toContainEqual({ event: 'alert.retry', count: 2, error: 'http_502' });
    const good = fakeFetch();
    await sendAlerts(deps(configFor(TG_ENV), good.fn, at + 2));
    expect(good.alerts).toHaveLength(1);
  });

  it('a permanent Telegram error gives up', async () => {
    const at = 8_130_000_000_000;
    const ids = await seedFailed(2, at);
    const spy = vi.spyOn(console, 'log');
    const bad = fakeFetch({ alert: () => new Response('{}', { status: 403 }) });
    await sendAlerts(deps(configFor(TG_ENV), bad.fn, at + 1));
    const events = logged(spy);
    spy.mockRestore();
    expect(await alertedAts(ids)).toEqual([at + 1, at + 1]);
    expect(events).toContainEqual({ event: 'alert.failed', count: 2, error: 'http_403', status: 403 });
    const next = fakeFetch();
    await sendAlerts(deps(configFor(TG_ENV), next.fn, at + 2));
    expect(next.alerts).toHaveLength(0);
  });

  it('a failed release is traced as alert.failed and does not throw', async () => {
    const at = 8_131_000_000_000;
    await seedFailed(2, at);
    const spy = vi.spyOn(console, 'log');
    const bad = fakeFetch({ alert: () => new Response('{}', { status: 502 }) });
    const d = deps(configFor(TG_ENV), bad.fn, at + 1);
    const db = {
      prepare: (sql: string) => {
        if (sql.includes('alerted_at = NULL')) throw new Error('d1 down');
        return env.DB.prepare(sql);
      },
    } as unknown as D1Database;
    await expect(sendAlerts({ ...d, db })).resolves.toBeUndefined();
    const events = logged(spy);
    spy.mockRestore();
    expect(events.filter((e: Record<string, unknown>) => e.event === 'alert.failed')).toEqual([{ event: 'alert.failed', count: 2, error: 'internal' }]);
    expect(events.some((e: Record<string, unknown>) => e.event === 'alert.retry')).toBe(false);
  });

  it('a network failure releases the claim and logs without a status', async () => {
    const at = 8_135_000_000_000;
    const ids = await seedFailed(1, at);
    const spy = vi.spyOn(console, 'log');
    const f = fakeFetch({
      alert: () => {
        throw new TypeError('boom');
      },
    });
    await sendAlerts(deps(configFor(TG_ENV), f.fn, at + 1));
    const events = logged(spy);
    spy.mockRestore();
    expect(await alertedAts(ids)).toEqual([null]);
    expect(events).toContainEqual({ event: 'alert.retry', count: 1, error: 'network' });
  });

  it('a redirect answer is a permanent failure', async () => {
    const at = 8_136_000_000_000;
    await seedFailed(1, at);
    const spy = vi.spyOn(console, 'log');
    const f = fakeFetch({ alert: () => new Response('{}', { status: 302 }) });
    await sendAlerts(deps(configFor(TG_ENV), f.fn, at + 1));
    const events = logged(spy);
    spy.mockRestore();
    expect(events).toContainEqual({ event: 'alert.failed', count: 1, error: 'redirect', status: 302 });
  });

  it('alerts off suppress without sending', async () => {
    const at = 8_140_000_000_000;
    const ids = await seedFailed(3, at);
    const spy = vi.spyOn(console, 'log');
    const f = fakeFetch();
    await sendAlerts(deps(configFor({ ...TG_ENV, ALERTS_ENABLED: 'false' }), f.fn, at + 1));
    const events = logged(spy);
    spy.mockRestore();
    expect(f.fn).not.toHaveBeenCalled();
    expect(await alertedAts(ids)).toEqual([at + 1, at + 1, at + 1]);
    expect(events).toContainEqual({ event: 'alert.suppressed', count: 3 });
  });

  it('no Telegram suppresses without sending', async () => {
    const at = 8_150_000_000_000;
    const ids = await seedFailed(2, at);
    const spy = vi.spyOn(console, 'log');
    const f = fakeFetch();
    await sendAlerts(deps(configFor(HOOK_ENV), f.fn, at + 1));
    const events = logged(spy);
    spy.mockRestore();
    expect(f.fn).not.toHaveBeenCalled();
    expect(await alertedAts(ids)).toEqual([at + 1, at + 1]);
    expect(events).toContainEqual({ event: 'alert.suppressed', count: 2 });
  });

  it('overlapping runs send one alert', async () => {
    const at = 8_160_000_000_000;
    await seedFailed(3, at);
    const f = fakeFetch({ alert: async () => (await Promise.resolve(), new Response('{"ok":true}', { status: 200 })) });
    const d = deps(configFor(TG_ENV), f.fn, at + 1);
    await Promise.all([sendAlerts(d), sendAlerts(d)]);
    expect(f.alerts).toHaveLength(1);
  });

  it('backfilled failures are not alerted', async () => {
    const at = 8_170_000_000_000;
    await seedFailed(2, at, at);
    const f = fakeFetch();
    await sendAlerts(deps(configFor(TG_ENV), f.fn, at + 1));
    expect(f.alerts).toHaveLength(0);
  });
});

describe('runCronSteps', () => {
  it('a failing step does not stop the next one', async () => {
    const spy = vi.spyOn(console, 'log');
    const order: string[] = [];
    await runCronSteps([
      async () => void order.push('a'),
      async () => {
        throw new Error('secret detail');
      },
      async () => void order.push('c'),
    ]);
    const events = logged(spy);
    spy.mockRestore();
    expect(order).toEqual(['a', 'c']);
    expect(events).toEqual([{ event: 'internal.error', error: 'internal' }]);
  });
});
