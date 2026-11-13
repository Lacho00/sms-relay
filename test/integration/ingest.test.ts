import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { getDeliveries } from '../../src/db/repo';

const TOKEN = (env as unknown as { INGEST_TOKEN: string }).INGEST_TOKEN;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const URL_ = 'https://relay.test/v1/sms';
const ALLOWED_STATUSES = [200, 400, 401, 503];

const ALLOW = { ingest: { limit: async () => ({ success: true }) }, read: { limit: async () => ({ success: true }) } };

type Overrides = Record<string, unknown>;

const testEnv = (overrides: Overrides = {}): Env => ({ ...env, ...overrides }) as unknown as Env;

let seq = 0;
const payload = (over: Record<string, unknown> = {}) => ({
  sender: 'ACME',
  body: `hello ${++seq} ${crypto.randomUUID()}`,
  received_at: NOW - 60_000 - seq,
  ...over,
});

type CallOptions = {
  body?: BodyInit | null;
  headers?: Record<string, string>;
  env?: Env;
  deps?: Partial<AppDeps>;
  auth?: string | null;
};

async function call(opts: CallOptions = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  const auth = opts.auth === undefined ? `Bearer ${TOKEN}` : opts.auth;
  if (auth !== null) headers.Authorization = auth;
  Object.assign(headers, opts.headers);
  const init: RequestInit & { duplex?: 'half' } = {
    method: 'POST',
    headers,
    body: opts.body === undefined ? '{}' : opts.body,
  };
  if (opts.body instanceof ReadableStream) init.duplex = 'half';
  const req = new Request(URL_, init);
  const onStored = vi.fn(async (_env: Env, _ids: number[]) => {});
  const app = createApp({ now: () => NOW, onStored, limiters: () => ALLOW, ...opts.deps });
  const ctx = createExecutionContext();
  const res = await app.fetch(req, opts.env ?? testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { res, status: res.status, json: JSON.parse(text) as Record<string, unknown>, onStored };
}

function expectError(r: { status: number; json: Record<string, unknown> }, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(r.json.error).toBe(code);
  expect(typeof r.json.message).toBe('string');
}

const statuses: number[] = [];
afterEach(() => {
  for (const s of statuses.splice(0)) expect(ALLOWED_STATUSES).toContain(s);
});
const track = async (p: ReturnType<typeof call>) => {
  const r = await p;
  statuses.push(r.status);
  return r;
};

describe('POST /v1/sms — connection test and auth', () => {
  it('answers 400 validation_failed to {} with a good token (connection test)', async () => {
    expectError(await track(call()), 400, 'validation_failed');
  });

  it('answers 401 unauthorized to {} with a bad token', async () => {
    expectError(await track(call({ auth: `Bearer ${TOKEN}x` })), 401, 'unauthorized');
  });

  it('answers 401 without an Authorization header', async () => {
    expectError(await track(call({ auth: null })), 401, 'unauthorized');
  });

  it('answers 401 to a Basic scheme', async () => {
    expectError(await track(call({ auth: `Basic ${TOKEN}` })), 401, 'unauthorized');
  });

  it('accepts a lowercase scheme with extra spaces', async () => {
    expectError(await track(call({ auth: `bearer   ${TOKEN}  ` })), 400, 'validation_failed');
  });
});

describe('POST /v1/sms — configuration', () => {
  it('answers 503 not_configured when INGEST_TOKEN is unset, even with a matching header', async () => {
    expectError(await track(call({ env: testEnv({ INGEST_TOKEN: undefined }) })), 503, 'not_configured');
  });

  it('answers 503 not_configured when INGEST_TOKEN has 31 characters, even with a matching header', async () => {
    const short = 'a'.repeat(31);
    const r = await track(call({ env: testEnv({ INGEST_TOKEN: short }), auth: `Bearer ${short}` }));
    expectError(r, 503, 'not_configured');
  });

  it('answers 503 config_invalid for a half-configured Telegram and logs only the variable name', async () => {
    const spy = vi.spyOn(console, 'log');
    const secretValue = 'bot-token-value-that-must-not-leak';
    const r = await track(call({ env: testEnv({ TELEGRAM_BOT_TOKEN: secretValue }) }));
    expectError(r, 503, 'config_invalid');
    const lines = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    const line = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'config.invalid');
    expect(line).toEqual({ event: 'config.invalid', variable: 'TELEGRAM_CHAT_ID' });
    for (const l of lines) expect(l).not.toContain(secretValue);
  });
});

describe('POST /v1/sms — store and dedup', () => {
  it('stores a valid standard payload, then answers duplicate with the same id', async () => {
    const p = payload();
    const first = await track(call({ body: JSON.stringify(p) }));
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ status: 'stored', id: expect.any(Number) });
    const again = await track(call({ body: JSON.stringify(p) }));
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ status: 'duplicate', id: first.json.id });
  });

  it('treats the same instant as ISO 8601 as a duplicate', async () => {
    const p = payload();
    const first = await track(call({ body: JSON.stringify(p) }));
    expect(first.json.status).toBe('stored');
    const iso = { ...p, received_at: new Date(p.received_at).toISOString() };
    const again = await track(call({ body: JSON.stringify(iso) }));
    expect(again.json).toEqual({ status: 'duplicate', id: first.json.id });
  });

  it('accepts JSON sent as text/plain', async () => {
    const r = await track(
      call({ body: JSON.stringify(payload()), headers: { 'Content-Type': 'text/plain' } }),
    );
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('stored');
  });

  it('answers 200 with exactly status and id, and never a redirect', async () => {
    const r = await track(call({ body: JSON.stringify(payload()) }));
    expect(r.status).toBe(200);
    expect(r.res.headers.get('Location')).toBeNull();
    expect(Object.keys(r.json).sort()).toEqual(['id', 'status']);
  });
});

describe('POST /v1/sms — body parsing', () => {
  it('answers 400 invalid_json to a body that is not JSON', async () => {
    expectError(await track(call({ body: 'not json' })), 400, 'invalid_json');
  });

  it('answers 400 invalid_json to an empty body', async () => {
    expectError(await track(call({ body: '' })), 400, 'invalid_json');
  });

  for (const raw of ['[]', '"x"', 'null', '42']) {
    it(`answers 400 validation_failed to valid JSON that is not an object: ${raw}`, async () => {
      expectError(await track(call({ body: raw })), 400, 'validation_failed');
    });
  }

  it('answers validation_failed with a field message for seconds instead of ms', async () => {
    const r = await track(call({ body: JSON.stringify(payload({ received_at: 1762697001 })) }));
    expectError(r, 400, 'validation_failed');
    expect(r.json.message).toBe('received_at: expected epoch milliseconds or ISO 8601 with zone');
  });

  it('answers 400 payload_too_large to a 64 KiB + 1 byte body', async () => {
    const r = await track(call({ body: 'x'.repeat(64 * 1024 + 1) }));
    expectError(r, 400, 'payload_too_large');
  });

  it('accepts a body of exactly 64 KiB as far as size goes', async () => {
    const r = await track(call({ body: ' '.repeat(64 * 1024 - 2) + '{}' }));
    expectError(r, 400, 'validation_failed');
  });

  it('answers 400 payload_too_large to a 64 KiB + 1 byte stream without Content-Length', async () => {
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < 4) {
          controller.enqueue(chunk);
          sent++;
        } else {
          controller.enqueue(new Uint8Array([0x20]));
          controller.close();
        }
      },
    });
    const r = await track(call({ body: stream }));
    expect(r.res.status).toBe(400);
    expectError(r, 400, 'payload_too_large');
  });

  it('reads a JSON stream without Content-Length', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload()));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 5));
        controller.enqueue(bytes.slice(5));
        controller.close();
      },
    });
    const r = await track(call({ body: stream }));
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('stored');
  });
});

describe('POST /v1/sms — destinations and onStored', () => {
  const telegramEnv = () =>
    testEnv({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '-1001234567890', TELEGRAM_SENDERS: 'BANK' });

  it('creates one Telegram delivery for a sender in TELEGRAM_SENDERS', async () => {
    const r = await track(call({ env: telegramEnv(), body: JSON.stringify(payload({ sender: 'bank' })) }));
    expect(r.json.status).toBe('stored');
    const rows = await getDeliveries(env.DB, r.json.id as number);
    expect(rows.map((d) => [d.destination, d.status])).toEqual([['telegram', 'pending']]);
    expect(r.onStored).toHaveBeenCalledTimes(1);
    expect(r.onStored.mock.calls[0]![1]).toEqual(rows.map((d) => d.id));
  });

  it('creates no delivery for a sender outside TELEGRAM_SENDERS', async () => {
    const r = await track(call({ env: telegramEnv(), body: JSON.stringify(payload({ sender: 'other' })) }));
    expect(r.json.status).toBe('stored');
    expect(await getDeliveries(env.DB, r.json.id as number)).toEqual([]);
  });

  it('calls onStored with the env and new delivery ids for stored, and not for duplicate', async () => {
    const e = testEnv({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42' });
    const p = payload();
    const first = await track(call({ env: e, body: JSON.stringify(p) }));
    expect(first.onStored).toHaveBeenCalledTimes(1);
    const [calledEnv, ids] = first.onStored.mock.calls[0]!;
    expect(calledEnv).toBe(e);
    const rows = await getDeliveries(env.DB, first.json.id as number);
    expect(ids).toEqual(rows.map((d) => d.id));
    expect(ids).toHaveLength(1);

    const again = await track(call({ env: e, body: JSON.stringify(p) }));
    expect(again.json.status).toBe('duplicate');
    expect(again.onStored).not.toHaveBeenCalled();
    expect(await getDeliveries(env.DB, first.json.id as number)).toHaveLength(1);
  });

  it('keeps the 200 and logs internal.error when onStored rejects', async () => {
    const spy = vi.spyOn(console, 'log');
    const onStored = vi.fn(async () => {
      throw new Error('outbox exploded with secret detail');
    });
    const r = await track(call({ body: JSON.stringify(payload()), deps: { onStored } }));
    const lines = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(r.status).toBe(200);
    expect(onStored).toHaveBeenCalledTimes(1);
    expect(lines.map((l) => JSON.parse(l))).toContainEqual({ event: 'internal.error', error: 'internal' });
    for (const l of lines) expect(l).not.toContain('secret detail');
  });

  it('works with the default no-op onStored', async () => {
    const app = createApp({ now: () => NOW });
    const ctx = createExecutionContext();
    const req = new Request(URL_, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(payload()),
    });
    const res = await app.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/sms — failures and logging', () => {
  it('answers 500 internal when D1 fails, and logs internal.error without the message', async () => {
    const spy = vi.spyOn(console, 'log');
    const brokenDb = {
      prepare: (q: string) => env.DB.prepare(q),
      batch: async () => {
        throw new Error('D1 is down: secret detail');
      },
    };
    const r = await call({ env: testEnv({ DB: brokenDb }), body: JSON.stringify(payload()) });
    const lines = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expectError(r, 500, 'internal');
    expect(lines.map((l) => JSON.parse(l))).toContainEqual({ event: 'internal.error', error: 'internal' });
    for (const l of lines) expect(l).not.toContain('secret detail');
    expect(r.onStored).not.toHaveBeenCalled();
  });

  it('never logs the sender, the body or the token', async () => {
    const spy = vi.spyOn(console, 'log');
    const sender = 'SENDER-XYZZY';
    const body = 'BODY-PLUGH-42';
    const p = payload({ sender, body });
    await call({ body: JSON.stringify(p) });
    await call({ body: JSON.stringify(p) });
    await call({ body: JSON.stringify({ sender, body, received_at: 1 }) });
    await call({ body: '{}', auth: 'Bearer wrong-token-qwerty' });
    const lines = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    const events = lines.map((l) => JSON.parse(l).event);
    expect(events).toEqual(['ingest.stored', 'ingest.duplicate', 'ingest.rejected', 'ingest.rejected']);
    for (const l of lines) {
      for (const secret of [sender, body, TOKEN, 'wrong-token-qwerty']) expect(l).not.toContain(secret);
    }
  });

  it('logs the error code and status on a rejection', async () => {
    const spy = vi.spyOn(console, 'log');
    await call({ body: 'not json' });
    const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])));
    spy.mockRestore();
    expect(lines).toEqual([{ event: 'ingest.rejected', status: 400, error: 'invalid_json' }]);
  });
});

describe('rate limit', () => {
  const deny = { limit: vi.fn(async (_o: { key: string }) => ({ success: false })) };
  const denyDeps = (): Partial<AppDeps> => ({ limiters: () => ({ ingest: deny, read: deny }) });

  afterEach(() => deny.limit.mockClear());

  it('over the limit returns 429 and stores nothing', async () => {
    const spy = vi.spyOn(console, 'log');
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    const r = await call({ body: JSON.stringify(payload()), deps: denyDeps(), headers: { 'CF-Connecting-IP': '203.0.113.7' } });
    expect(r.status).toBe(429);
    expect(r.res.headers.get('Retry-After')).toBe('60');
    expect(r.json.error).toBe('rate_limited');
    expect(deny.limit).toHaveBeenCalledWith({ key: 'ingest:203.0.113.7' });
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect(r.onStored).not.toHaveBeenCalled();
    const lines = spy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(lines).toContainEqual({ event: 'ingest.rejected', status: 429, error: 'rate_limited' });
    expect(JSON.stringify(lines)).not.toContain('203.0.113.7');
  });

  it('the limit runs before auth', async () => {
    const r = await call({ auth: 'Bearer wrong', deps: denyDeps() });
    expect(r.status).toBe(429);
  });

  it('the limit beats validation', async () => {
    for (const body of ['{}', 'not json']) {
      expect((await call({ body, deps: denyDeps() })).status).toBe(429);
    }
  });

  it('an unconfigured Worker still answers 503', async () => {
    const r = await call({ env: testEnv({ INGEST_TOKEN: undefined }), deps: denyDeps() });
    expect(r.status).toBe(503);
    expect(deny.limit).not.toHaveBeenCalled();
  });

  it('a limiter outage lets ingest through', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const throwing = {
      limit: async () => {
        throw new Error('down');
      },
    };
    const r = await call({ body: JSON.stringify(payload()), deps: { limiters: () => ({ ingest: throwing, read: throwing }) } });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('stored');
  });
});
