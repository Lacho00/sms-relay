import { describe, expect, it } from 'vitest';
import { sendJson } from '../../src/destinations/http';
import {
  TELEGRAM_MAX_CHARS,
  formatTelegramText,
  sendTelegramText,
  splitTelegramText,
  telegramParts,
} from '../../src/destinations/telegram';
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
  it('keeps the full body', () => {
    const body = 'x'.repeat(10_000);
    const t = formatTelegramText(msg({ body }), 'UTC');
    expect(t.endsWith(body)).toBe(true);
    expect(t).not.toContain('…');
  });
});

const unmark = (parts: string[]) => parts.map((p) => p.replace(/^\(\d+\/\d+\)\n/, ''));

describe('splitTelegramText', () => {
  it('short text is one part, unchanged', () => {
    const t = 'z'.repeat(TELEGRAM_MAX_CHARS);
    expect(splitTelegramText(t)).toEqual([t]);
  });
  it('a 10 000-char body gives 3 parts', () => {
    const body = ('a'.repeat(79) + ' ').repeat(125);
    const parts = telegramParts(msg({ body }), 'UTC');
    expect(parts).toHaveLength(3);
    parts.forEach((p, i) => {
      expect(p.startsWith(`(${i + 1}/3)\n`)).toBe(true);
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    });
    expect(parts[0]).toContain('SMS from ');
    expect(parts[1]).not.toContain('SMS from ');
    expect(parts[2]).not.toContain('SMS from ');
  });
  it('prefers a newline near the end', () => {
    const win = TELEGRAM_MAX_CHARS - '(1/2)\n'.length;
    const text = ('abcdefghi ').repeat(Math.ceil(9000 / 10)).slice(0, 9000).split('');
    text[win - 100] = '\n';
    const parts = splitTelegramText(text.join(''));
    expect(parts[0]).toBe(`(1/${parts.length})\n${text.slice(0, win - 100).join('')}`);
    expect(unmark(parts)[1]).toMatch(/^\S/);
  });
  it('no whitespace hard-cuts', () => {
    const parts = splitTelegramText('x'.repeat(9000));
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS));
    expect(unmark(parts).join('')).toBe('x'.repeat(9000));
  });
  it('never splits a surrogate pair', () => {
    const input = '😀'.repeat(3000);
    const parts = splitTelegramText(input);
    for (const p of parts) {
      expect(p).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    }
    expect(unmark(parts).join('')).toBe(input);
  });
  it('marker width is stable past 9 parts', () => {
    const parts = splitTelegramText('y'.repeat(50_000));
    expect(parts).toHaveLength(13);
    expect(parts[12]!.startsWith('(13/13)\n')).toBe(true);
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS));
  });
  it('honours a custom max', () => {
    const parts = splitTelegramText('ab cd ef gh ij kl', 12);
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(12));
  });
});

describe('sendTelegramText', () => {
  it('posts the expected request', async () => {
    const f = fake(new Response('{"ok":true}', { status: 200 }));
    const r = await sendTelegramText(f.fn, cfg, 'https://api.example', formatTelegramText(msg(), 'UTC'), 0);
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
    expect(await sendTelegramText(f.fn, cfg, 'https://a', 'hi', 0)).toEqual({
      kind: 'response', status: 429, retryAfterMs: 30000,
    });
  });
  it('maps TimeoutError to timeout and others to network', async () => {
    const t = fake(new DOMException('t', 'TimeoutError'));
    expect(await sendTelegramText(t.fn, cfg, 'https://a', 'hi', 0)).toEqual({ kind: 'timeout' });
    const n = fake(new TypeError('x'));
    expect(await sendTelegramText(n.fn, cfg, 'https://a', 'hi', 0)).toEqual({ kind: 'network' });
  });
  it('reports a 302 without following', async () => {
    const f = fake(new Response(null, { status: 302, headers: { location: 'https://evil' } }));
    expect(await sendTelegramText(f.fn, cfg, 'https://a', 'hi', 0)).toEqual({
      kind: 'response', status: 302, retryAfterMs: null,
    });
    expect(f.calls[0]!.init.redirect).toBe('manual');
  });
  it('falls back to the header when the body has no retry_after', async () => {
    const f = fake(new Response('{"ok":false}', { status: 429, headers: { 'Retry-After': '7' } }));
    expect(await sendTelegramText(f.fn, cfg, 'https://a', 'hi', 0)).toEqual({
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
