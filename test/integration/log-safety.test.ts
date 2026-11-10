import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, createScheduled } from '../../src/app';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const TG_BASE = 'https://tg.test';

const SENDER = 'SENDER-7f3a';
const BODY = 'BODY-91c2';
const INGEST = 'INGESTSECRET-5d1e-0123456789abcdef0123456789';
const READ = 'READSECRET-8b44-0123456789abcdef0123456789ab';
const BOT_TOKEN = '987654:BOTSECRET-c0de-bot-token-value';
const CHAT_ID = '-100777313';
const HOOK_URL = 'https://hook.test/in/HOOKURLSECRET-3e9a';
const HOOK_SECRET = 'HOOKSECRET-a7c5-0123456789abcdef0123456789';
const MARKERS = [SENDER, BODY, INGEST, READ, BOT_TOKEN, CHAT_ID, HOOK_URL, HOOK_SECRET, 'SECRET-', 'BOT-TOKEN', 'HOOKURL'];

const testEnv = (): Env =>
  ({
    ...env,
    INGEST_TOKEN: INGEST,
    READ_TOKEN: READ,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_CHAT_ID: CHAT_ID,
    TELEGRAM_API_BASE: TG_BASE,
    WEBHOOK_URL: HOOK_URL,
    WEBHOOK_SECRET: HOOK_SECRET,
  }) as unknown as Env;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM deliveries'), env.DB.prepare('DELETE FROM messages')]);
});
afterEach(() => vi.restoreAllMocks());

describe('log safety', () => {
  it('never logs sms content, tokens, secrets, chat id or webhook url across a full cycle', async () => {
    const captured: string[] = [];
    const grab = (...args: unknown[]) =>
      captured.push(args.map((a) => (typeof a === 'string' ? a : (JSON.stringify(a) ?? String(a)))).join(' '));
    vi.spyOn(console, 'log').mockImplementation(grab);
    vi.spyOn(console, 'warn').mockImplementation(grab);
    vi.spyOn(console, 'error').mockImplementation(grab);
    vi.spyOn(console, 'info').mockImplementation(grab);
    vi.spyOn(console, 'debug').mockImplementation(grab);

    let telegramFails = true;
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(TG_BASE) && telegramFails) return new Response('{}', { status: 502 });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    let now = NOW;
    const app = createApp({ fetch: fetchFn, now: () => now });
    const scheduled = createScheduled({ fetch: fetchFn, now: () => now });
    const e = testEnv();

    const call = async (path: string, init: RequestInit) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`https://relay.test${path}`, init), e, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const post = (token: string, payload: unknown) =>
      call('/v1/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
    const sms = { sender: SENDER, body: BODY, received_at: NOW - 1000 };
    const cron = async () => {
      const ctx = createExecutionContext();
      await scheduled(createScheduledController({ scheduledTime: now, cron: '* * * * *' }), e, ctx);
      await waitOnExecutionContext(ctx);
    };

    expect((await post(`${INGEST}-wrong`, sms)).status).toBe(401);
    expect((await post(INGEST, { sender: SENDER })).status).toBe(400);
    expect((await post(INGEST, sms)).status).toBe(200);
    expect((await post(INGEST, sms)).status).toBe(200);

    now = NOW + DAY;
    telegramFails = false;
    await cron();

    const list = await call('/v1/messages', { headers: { Authorization: `Bearer ${READ}` } });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain(BODY);
    expect((await call('/v1/messages', { headers: { Authorization: `Bearer ${READ}-wrong` } })).status).toBe(401);

    now = NOW + 31 * DAY;
    await cron();

    const events = captured.map((l) => (JSON.parse(l) as { event: string }).event);
    for (const ev of [
      'ingest.rejected',
      'ingest.stored',
      'ingest.duplicate',
      'delivery.retry',
      'delivery.delivered',
      'retention.purged',
    ]) {
      expect(events, ev).toContain(ev);
    }
    for (const line of captured) {
      for (const marker of MARKERS) expect(line, marker).not.toContain(marker);
    }
  });
});
