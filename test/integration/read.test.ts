import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { insertMessage, listMessages } from '../../src/db/repo';
import { decodeCursor, encodeCursor } from '../../src/read/handler';

const READ = (env as unknown as { READ_TOKEN: string }).READ_TOKEN;
const INGEST = (env as unknown as { INGEST_TOKEN: string }).INGEST_TOKEN;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

const testEnv = (overrides: Record<string, unknown> = {}): Env => ({ ...env, ...overrides }) as unknown as Env;

async function get(path: string, opts: { token?: string | null; env?: Env } = {}) {
  const token = opts.token === undefined ? READ : opts.token;
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const app = createApp({ now: () => NOW });
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://relay.test${path}`, { headers }), opts.env ?? testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

let n = 0;
async function seed(count: number, destinations: ('telegram' | 'webhook')[] = ['telegram']): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    n++;
    const r = await insertMessage(
      env.DB,
      { sender: 'ACME', body: `body ${n}`, receivedAt: NOW - 1000 * n, sim: 1, device: 'phone' },
      `read-key-${n}-${crypto.randomUUID()}`,
      destinations,
      NOW + n,
    );
    ids.push(r.id);
  }
  return ids;
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM deliveries'), env.DB.prepare('DELETE FROM messages')]);
});

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    for (const bad of ['!!!', '', btoa('abc'), btoa('0'), btoa('-3'), btoa('1.5'), btoa('007')]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});

describe('read auth', () => {
  it('503 not_configured when READ_TOKEN is unset or equals INGEST_TOKEN', async () => {
    for (const READ_TOKEN of [undefined, INGEST]) {
      const r = await get('/v1/messages', { env: testEnv({ READ_TOKEN }) });
      expect(r.status).toBe(503);
      expect(r.json.error).toBe('not_configured');
      const d = await get('/v1/messages/1', { env: testEnv({ READ_TOKEN }) });
      expect(d.status).toBe(503);
    }
  });

  it('401 with the ingest token, a wrong token or none', async () => {
    for (const token of [INGEST, 'x'.repeat(40), null]) {
      const r = await get('/v1/messages', { token });
      expect(r.status).toBe(401);
      expect(r.json.error).toBe('unauthorized');
    }
    expect((await get('/v1/messages/1', { token: INGEST })).status).toBe(401);
  });

  it('503 config_invalid when the config is invalid', async () => {
    const r = await get('/v1/messages', { env: testEnv({ WEBHOOK_URL: 'http://example.com' }) });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('config_invalid');
  });
});

describe('GET /v1/messages', () => {
  it('paginates newest first with cursors', async () => {
    const ids = await seed(5);
    const p1 = await get('/v1/messages?limit=2');
    expect(p1.status).toBe(200);
    expect(p1.json.messages.map((m: any) => m.id)).toEqual([ids[4], ids[3]]);
    expect(typeof p1.json.next_cursor).toBe('string');
    const p2 = await get(`/v1/messages?limit=2&cursor=${p1.json.next_cursor}`);
    expect(p2.json.messages.map((m: any) => m.id)).toEqual([ids[2], ids[1]]);
    const p3 = await get(`/v1/messages?limit=2&cursor=${p2.json.next_cursor}`);
    expect(p3.json.messages.map((m: any) => m.id)).toEqual([ids[0]]);
    expect(p3.json.next_cursor).toBeNull();
  });

  it('has next_cursor null when the page is exactly the rest', async () => {
    await seed(2);
    const r = await get('/v1/messages?limit=2');
    expect(r.json.messages).toHaveLength(2);
    expect(r.json.next_cursor).toBeNull();
  });

  it('defaults to 50 and returns an empty list', async () => {
    expect((await get('/v1/messages')).json).toEqual({ messages: [], next_cursor: null });
    await seed(51);
    const r = await get('/v1/messages');
    expect(r.json.messages).toHaveLength(50);
    expect(r.json.next_cursor).not.toBeNull();
  });

  it('400 validation_failed on bad limit or cursor', async () => {
    for (const q of ['limit=0', 'limit=101', 'limit=x', 'limit=', 'limit=1.5', 'cursor=!!!', 'cursor=']) {
      const r = await get(`/v1/messages?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json.error).toBe('validation_failed');
    }
  });

  it('shapes items with ISO dates and a delivery summary', async () => {
    const [id] = await seed(1, ['telegram', 'webhook']);
    const r = await get('/v1/messages');
    const m = r.json.messages[0];
    expect(m).toMatchObject({ id, sender: 'ACME', sim: 1, device: 'phone' });
    expect(m.received_at).toBe(new Date(m.received_at).toISOString());
    expect(m.created_at).toBe(new Date(m.created_at).toISOString());
    expect(m.deliveries).toEqual([
      { destination: 'telegram', status: 'pending' },
      { destination: 'webhook', status: 'pending' },
    ]);
  });

  it('lists a message without deliveries', async () => {
    await seed(1, []);
    expect((await get('/v1/messages')).json.messages[0].deliveries).toEqual([]);
  });
});

describe('listMessages', () => {
  it('loads a page of deliveries with one IN query', async () => {
    const ids = await seed(3, ['telegram', 'webhook']);
    const r = await listMessages(env.DB, null, 2);
    expect(r.rows.map((m) => m.id)).toEqual([ids[2], ids[1]]);
    expect(r.deliveries.get(ids[2]!)).toHaveLength(2);
    expect(r.deliveries.has(ids[0]!)).toBe(false);
  });
});

describe('GET /v1/messages/:id', () => {
  it('returns the message with full deliveries and no lease column', async () => {
    const [id] = await seed(1, ['telegram', 'webhook']);
    await env.DB.prepare('UPDATE deliveries SET locked_until = 99, last_error = ? WHERE message_id = ?')
      .bind('http_500', id)
      .run();
    const r = await get(`/v1/messages/${id}`);
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(id);
    expect(r.json.body).toMatch(/^body /);
    expect(r.json.deliveries).toHaveLength(2);
    expect(Object.keys(r.json.deliveries[0]).sort()).toEqual(
      [
        'attempts',
        'delivered_at',
        'destination',
        'last_error',
        'last_status_code',
        'next_attempt_at',
        'status',
      ].sort(),
    );
    expect(r.json.deliveries[0].last_error).toBe('http_500');
    expect(r.json.deliveries[0].delivered_at).toBeNull();
    expect(r.json.deliveries[0].next_attempt_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.stringify(r.json)).not.toContain('locked');
  });

  it('renders delivered_at as ISO when set', async () => {
    const [id] = await seed(1);
    await env.DB.prepare('UPDATE deliveries SET status = ?, delivered_at = ? WHERE message_id = ?')
      .bind('delivered', NOW, id)
      .run();
    const r = await get(`/v1/messages/${id}`);
    expect(r.json.deliveries[0].delivered_at).toBe(new Date(NOW).toISOString());
  });

  it('404 not_found for unknown and non-numeric ids', async () => {
    for (const p of ['999', 'abc', '1.5', '0', '-1', '99999999999999999999']) {
      const r = await get(`/v1/messages/${p}`);
      expect(r.status, p).toBe(404);
      expect(r.json.error).toBe('not_found');
    }
  });
});
