import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config';

const T32 = 'a'.repeat(32);
const base = { INGEST_TOKEN: T32 };
const ok = (env: Record<string, unknown>) => {
  const r = parseConfig({ ...base, ...env });
  if (!r.ok) throw new Error(`expected ok, got ${r.variable}`);
  return r.config;
};
const failing = (env: Record<string, unknown>) => {
  const r = parseConfig({ ...base, ...env });
  return r.ok ? null : r.variable;
};

describe('parseConfig', () => {
  it('parses a minimal env with defaults', () => {
    const c = ok({});
    expect(c.telegram).toBeNull();
    expect(c.webhook).toBeNull();
    expect(c.retentionDays).toBe(30);
    expect(c.maxAttempts).toBe(10);
    expect(c.displayTimeZone).toBe('UTC');
    expect(c.telegramApiBase).toBe('https://api.telegram.org');
    expect(c.ingestToken).toBe(T32);
    expect(c.readToken).toBeNull();
  });

  it('treats empty strings as not set and trims values', () => {
    const c = ok({ RETENTION_DAYS: '', TELEGRAM_BOT_TOKEN: '  ', DISPLAY_TIMEZONE: ' Europe/Madrid ' });
    expect(c.retentionDays).toBe(30);
    expect(c.telegram).toBeNull();
    expect(c.displayTimeZone).toBe('Europe/Madrid');
  });

  it('treats non-string values as not set', () => {
    expect(ok({ RETENTION_DAYS: 5, INGEST_TOKEN: undefined }).retentionDays).toBe(30);
  });

  it('gives a null ingest token when it is 31 chars or missing', () => {
    expect(ok({ INGEST_TOKEN: 'a'.repeat(31) }).ingestToken).toBeNull();
    expect(parseConfig({}).ok).toBe(true);
  });

  it('gives a null read token when it equals the ingest token', () => {
    expect(ok({ READ_TOKEN: T32 }).readToken).toBeNull();
  });

  it('gives a null read token when it is short, and keeps a valid distinct one', () => {
    expect(ok({ READ_TOKEN: 'b'.repeat(31) }).readToken).toBeNull();
    expect(ok({ READ_TOKEN: 'b'.repeat(32) }).readToken).toBe('b'.repeat(32));
  });

  it('errors when only the bot token is set', () => {
    expect(failing({ TELEGRAM_BOT_TOKEN: '123:abc' })).toBe('TELEGRAM_CHAT_ID');
  });

  it('errors when only the chat id is set', () => {
    expect(failing({ TELEGRAM_CHAT_ID: '12345' })).toBe('TELEGRAM_BOT_TOKEN');
  });

  it.each(['-1001234567890', '12345', '@my_channel'])('accepts chat id %s', (id) => {
    const c = ok({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: id });
    expect(c.telegram?.chatId).toBe(id);
    expect(c.telegram?.botToken).toBe('123:abc');
  });

  it('rejects an invalid chat id', () => {
    expect(failing({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: 'abc' })).toBe('TELEGRAM_CHAT_ID');
  });

  it('rejects an http webhook url on a remote host', () => {
    expect(failing({ WEBHOOK_URL: 'http://example.com/h', WEBHOOK_SECRET: T32 })).toBe('WEBHOOK_URL');
  });

  it('accepts localhost http and https webhook urls', () => {
    expect(ok({ WEBHOOK_URL: 'http://localhost:8787/h', WEBHOOK_SECRET: T32 }).webhook?.url).toBe(
      'http://localhost:8787/h',
    );
    expect(ok({ WEBHOOK_URL: 'http://127.0.0.1/h', WEBHOOK_SECRET: T32 }).webhook).not.toBeNull();
    expect(ok({ WEBHOOK_URL: 'https://example.com/h', WEBHOOK_SECRET: T32 }).webhook?.secret).toBe(T32);
  });

  it('rejects an unparseable or non-http webhook url', () => {
    expect(failing({ WEBHOOK_URL: 'not a url', WEBHOOK_SECRET: T32 })).toBe('WEBHOOK_URL');
    expect(failing({ WEBHOOK_URL: 'ftp://localhost/h', WEBHOOK_SECRET: T32 })).toBe('WEBHOOK_URL');
  });

  it('rejects a 31 char webhook secret', () => {
    expect(failing({ WEBHOOK_URL: 'https://example.com/h', WEBHOOK_SECRET: 'a'.repeat(31) })).toBe('WEBHOOK_SECRET');
  });

  it('errors naming the missing webhook variable', () => {
    expect(failing({ WEBHOOK_URL: 'https://example.com/h' })).toBe('WEBHOOK_SECRET');
    expect(failing({ WEBHOOK_SECRET: T32 })).toBe('WEBHOOK_URL');
  });

  it('rejects an invalid sender regex', () => {
    expect(failing({ TELEGRAM_SENDER_REGEX: '(' })).toBe('TELEGRAM_SENDER_REGEX');
    expect(failing({ WEBHOOK_SENDER_REGEX: '(' })).toBe('WEBHOOK_SENDER_REGEX');
  });

  it('builds a case-insensitive regex filter', () => {
    const c = ok({ TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_CHAT_ID: '12345', TELEGRAM_SENDER_REGEX: '^bank' });
    expect(c.telegram?.filter.regex?.test('BankOne')).toBe(true);
    expect(c.telegram?.filter.senders).toEqual([]);
  });

  it('normalizes the senders list and drops empty entries', () => {
    const c = ok({
      TELEGRAM_BOT_TOKEN: '1:a',
      TELEGRAM_CHAT_ID: '12345',
      TELEGRAM_SENDERS: ' bank , +1 555 0100 ,',
    });
    expect(c.telegram?.filter.senders).toEqual(['BANK', '+15550100']);
    expect(c.telegram?.filter.regex).toBeNull();
  });

  it('applies the webhook filter independently', () => {
    const c = ok({
      WEBHOOK_URL: 'https://example.com/h',
      WEBHOOK_SECRET: T32,
      WEBHOOK_SENDERS: 'a,b',
    });
    expect(c.webhook?.filter.senders).toEqual(['A', 'B']);
  });

  it.each(['-1', 'x', '1.5'])('rejects RETENTION_DAYS %s', (v) => {
    expect(failing({ RETENTION_DAYS: v })).toBe('RETENTION_DAYS');
  });

  it('accepts RETENTION_DAYS 0', () => {
    expect(ok({ RETENTION_DAYS: '0' }).retentionDays).toBe(0);
  });

  it.each(['0', '51', 'x'])('rejects MAX_ATTEMPTS %s', (v) => {
    expect(failing({ MAX_ATTEMPTS: v })).toBe('MAX_ATTEMPTS');
  });

  it('accepts MAX_ATTEMPTS in range', () => {
    expect(ok({ MAX_ATTEMPTS: '1' }).maxAttempts).toBe(1);
    expect(ok({ MAX_ATTEMPTS: '50' }).maxAttempts).toBe(50);
  });

  it('rejects an unknown time zone and accepts a real one', () => {
    expect(failing({ DISPLAY_TIMEZONE: 'Mars/Base' })).toBe('DISPLAY_TIMEZONE');
    expect(ok({ DISPLAY_TIMEZONE: 'Europe/Madrid' }).displayTimeZone).toBe('Europe/Madrid');
  });

  it('validates TELEGRAM_API_BASE and strips a trailing slash', () => {
    expect(ok({ TELEGRAM_API_BASE: 'http://localhost:9999/' }).telegramApiBase).toBe('http://localhost:9999');
    expect(failing({ TELEGRAM_API_BASE: 'nope' })).toBe('TELEGRAM_API_BASE');
    expect(failing({ TELEGRAM_API_BASE: 'ftp://x.com' })).toBe('TELEGRAM_API_BASE');
  });

  it('never leaks the bad value in the error result', () => {
    const bad = 'secret-bad-value-zzz';
    for (const env of [
      { RETENTION_DAYS: bad },
      { MAX_ATTEMPTS: bad },
      { DISPLAY_TIMEZONE: bad },
      { TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_CHAT_ID: bad },
      { WEBHOOK_URL: bad, WEBHOOK_SECRET: T32 },
      { TELEGRAM_SENDER_REGEX: `(${bad}` },
    ]) {
      const r = parseConfig({ ...base, ...env });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(bad);
    }
  });
});
