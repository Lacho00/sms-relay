import { describe, expect, it } from 'vitest';
import { sendJson } from '../../src/destinations/http';
import { TELEGRAM_MAX_CHARS, formatTelegramText, sendTelegram } from '../../src/destinations/telegram';
import type { TelegramConfig } from '../../src/config';
import type { MessageRow } from '../../src/db/repo';

const cfg: TelegramConfig = { botToken: 'TOKEN', chatId: '42', filter: { senders: [], regex: null } };
const msg = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 1, sender: 'ACME', body: 'hello', receivedAt: 1762697001000, sim: null, device: null, createdAt: 0, ...over,
});

type Call = { url: string; init: RequestInit };
function fake(res: Response | (() => Response) | Error) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (res instanceof Error) throw res;
    return typeof res === 'function' ? res() : res;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('formatTelegramText', () => {
  it('formats in UTC', () => {
    expect(formatTelegramText(msg(), 'UTC')).toBe('SMS from ACME\n2025-11-09 14:03 UTC\n\nhello');
  });
  it('formats in a zone', () => {
    expect(formatTelegramText(msg(), 'Europe/Madrid').split('\n')[1]).toBe('2025-11-09 15:03 Europe/Madrid');
  });
  it('cuts long text with an ellipsis', () => {
    const t = formatTelegramText(msg({ body: 'x'.repeat(5000) }), 'UTC');
    expect(t.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(t.endsWith('…')).toBe(true);
  });
  it('does not leave a lone surrogate', () => {
    const t = formatTelegramText(msg({ body: '😀'.repeat(3000) }), 'UTC');
    expect(t.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(t.endsWith('…')).toBe(true);
    expect(t.slice(0, -1)).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it('does not cut text that fits exactly', () => {
    const head = formatTelegramText(msg({ body: '' }), 'UTC').length;
    const t = formatTelegramText(msg({ body: 'x'.repeat(TELEGRAM_MAX_CHARS - head) }), 'UTC');
    expect(t.length).toBe(TELEGRAM_MAX_CHARS);
    expect(t.endsWith('…')).toBe(false);
  });
});

describe('sendTelegram', () => {
  it('posts the expected request', async () => {
    const f = fake(new Response('{"ok":true}', { status: 200 }));
    const r = await sendTelegram(f.fn, cfg, 'https://api.example', 'UTC', msg(), 0);
    expect(r).toEqual({ kind: 'response', status: 200, retryAfterMs: null });
    expect(f.calls[0]!.url).toBe('https://api.example/botTOKEN/sendMessage');
    expect(f.calls[0]!.init.method).toBe('POST');
    expect(f.calls[0]!.init.redirect).toBe('manual');
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({
      chat_id: '42',
      text: 'SMS from ACME\n2025-11-09 14:03 UTC\n\nhello',
      link_preview_options: { is_disabled: true },
    });
  });
  it('reads retry_after from the 429 body', async () => {
    const f = fake(new Response('{"parameters":{"retry_after":30}}', { status: 429 }));
    expect(await sendTelegram(f.fn, cfg, 'https://a', 'UTC', msg(), 0)).toEqual({
      kind: 'response', status: 429, retryAfterMs: 30000,
    });
  });
  it('maps TimeoutError to timeout and others to network', async () => {
    const t = fake(new DOMException('t', 'TimeoutError'));
    expect(await sendTelegram(t.fn, cfg, 'https://a', 'UTC', msg(), 0)).toEqual({ kind: 'timeout' });
    const n = fake(new TypeError('x'));
    expect(await sendTelegram(n.fn, cfg, 'https://a', 'UTC', msg(), 0)).toEqual({ kind: 'network' });
  });
  it('reports a 302 without following', async () => {
    const f = fake(new Response(null, { status: 302, headers: { location: 'https://evil' } }));
    expect(await sendTelegram(f.fn, cfg, 'https://a', 'UTC', msg(), 0)).toEqual({
      kind: 'response', status: 302, retryAfterMs: null,
    });
    expect(f.calls[0]!.init.redirect).toBe('manual');
  });
  it('falls back to the header when the body has no retry_after', async () => {
    const f = fake(new Response('{"ok":false}', { status: 429, headers: { 'Retry-After': '7' } }));
    expect(await sendTelegram(f.fn, cfg, 'https://a', 'UTC', msg(), 0)).toEqual({
      kind: 'response', status: 429, retryAfterMs: 7000,
    });
  });
});

describe('sendJson', () => {
  it('reads Retry-After header and tolerates a non-JSON body', async () => {
    const f = fake(new Response('<html>', { status: 503, headers: { 'Retry-After': '5' } }));
    const r = await sendJson(f.fn, 'https://a', '{}', { 'X-A': '1' }, 0);
    expect(r).toEqual({ result: { kind: 'response', status: 503, retryAfterMs: 5000 }, json: null });
    const h = f.calls[0]!.init.headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/json; charset=utf-8');
    expect(h['X-A']).toBe('1');
  });
  it('tolerates an empty body', async () => {
    const f = fake(new Response(null, { status: 204 }));
    expect((await sendJson(f.fn, 'https://a', '{}', {}, 0)).json).toBeNull();
  });
});
