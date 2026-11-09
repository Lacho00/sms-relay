import { z } from 'zod';
import { normalizeSender } from './ingest/identity';

export type SenderFilter = { senders: string[]; regex: RegExp | null };
export type TelegramConfig = { botToken: string; chatId: string; filter: SenderFilter };
export type WebhookConfig = { url: string; secret: string; filter: SenderFilter };
export type Config = {
  ingestToken: string | null;
  readToken: string | null;
  telegram: TelegramConfig | null;
  webhook: WebhookConfig | null;
  retentionDays: number;
  maxAttempts: number;
  displayTimeZone: string;
  telegramApiBase: string;
};
export type ConfigVariable =
  | 'INGEST_TOKEN'
  | 'READ_TOKEN'
  | 'TELEGRAM_BOT_TOKEN'
  | 'TELEGRAM_CHAT_ID'
  | 'TELEGRAM_SENDERS'
  | 'TELEGRAM_SENDER_REGEX'
  | 'WEBHOOK_URL'
  | 'WEBHOOK_SECRET'
  | 'WEBHOOK_SENDERS'
  | 'WEBHOOK_SENDER_REGEX'
  | 'RETENTION_DAYS'
  | 'MAX_ATTEMPTS'
  | 'DISPLAY_TIMEZONE'
  | 'TELEGRAM_API_BASE';
export type ConfigResult = { ok: true; config: Config } | { ok: false; variable: ConfigVariable };

const MIN_SECRET_LENGTH = 32;

/** Thrown internally so the first invalid variable wins; only the name is kept. */
class ConfigError extends Error {
  constructor(readonly variable: ConfigVariable) {
    super(variable);
  }
}

const isLoopback = (u: URL) => u.hostname === 'localhost' || u.hostname === '127.0.0.1';

const chatId = z.string().regex(/^(-?\d+|@[A-Za-z0-9_]{5,32})$/);
const secret = z.string().min(MIN_SECRET_LENGTH);
const parseUrl = (s: string): URL | null => (URL.canParse(s) ? new URL(s) : null);
const webhookUrl = z.string().refine((s) => {
  const u = parseUrl(s);
  return u !== null && (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u)));
});
const httpUrl = z.string().refine((s) => {
  const u = parseUrl(s);
  return u !== null && (u.protocol === 'http:' || u.protocol === 'https:');
});
const nonNegativeInt = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0));
const attempts = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(50));
const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
});

/** Reads a trimmed string; absent, non-string and empty values mean "not set". */
function read(env: Record<string, unknown>, name: ConfigVariable): string | undefined {
  const v = env[name];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Validates `value` with `schema`; throws ConfigError naming `name` on failure. */
function check<T extends z.ZodType>(schema: T, name: ConfigVariable, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ConfigError(name);
  return r.data;
}

function parseFilter(env: Record<string, unknown>, prefix: 'TELEGRAM' | 'WEBHOOK'): SenderFilter {
  const list = read(env, `${prefix}_SENDERS`);
  const senders = (list ?? '')
    .split(',')
    .map(normalizeSender)
    .filter((s) => s !== '');
  const name: ConfigVariable = `${prefix}_SENDER_REGEX`;
  const src = read(env, name);
  let regex: RegExp | null = null;
  if (src !== undefined) {
    try {
      regex = new RegExp(src, 'i');
    } catch {
      throw new ConfigError(name);
    }
  }
  return { senders, regex };
}

/** Both set → value pair; neither → null; one → error naming the missing one. */
function pair(
  env: Record<string, unknown>,
  a: ConfigVariable,
  b: ConfigVariable,
): [string, string] | null {
  const va = read(env, a);
  const vb = read(env, b);
  if (va === undefined && vb === undefined) return null;
  if (va === undefined) throw new ConfigError(a);
  if (vb === undefined) throw new ConfigError(b);
  return [va, vb];
}

function build(env: Record<string, unknown>): Config {
  const ingest = read(env, 'INGEST_TOKEN');
  const ingestToken = ingest !== undefined && ingest.length >= MIN_SECRET_LENGTH ? ingest : null;
  const read_ = read(env, 'READ_TOKEN');
  const readToken =
    read_ !== undefined && read_.length >= MIN_SECRET_LENGTH && read_ !== ingestToken ? read_ : null;

  const tg = pair(env, 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID');
  const telegramFilter = parseFilter(env, 'TELEGRAM');
  const telegram: TelegramConfig | null = tg && {
    botToken: tg[0],
    chatId: check(chatId, 'TELEGRAM_CHAT_ID', tg[1]),
    filter: telegramFilter,
  };

  const wh = pair(env, 'WEBHOOK_URL', 'WEBHOOK_SECRET');
  const webhookFilter = parseFilter(env, 'WEBHOOK');
  const webhook: WebhookConfig | null = wh && {
    url: check(webhookUrl, 'WEBHOOK_URL', wh[0]),
    secret: check(secret, 'WEBHOOK_SECRET', wh[1]),
    filter: webhookFilter,
  };

  return {
    ingestToken,
    readToken,
    telegram,
    webhook,
    retentionDays: check(nonNegativeInt, 'RETENTION_DAYS', read(env, 'RETENTION_DAYS') ?? '30'),
    maxAttempts: check(attempts, 'MAX_ATTEMPTS', read(env, 'MAX_ATTEMPTS') ?? '10'),
    displayTimeZone: check(timeZone, 'DISPLAY_TIMEZONE', read(env, 'DISPLAY_TIMEZONE') ?? 'UTC'),
    telegramApiBase: check(
      httpUrl,
      'TELEGRAM_API_BASE',
      read(env, 'TELEGRAM_API_BASE') ?? 'https://api.telegram.org',
    ).replace(/\/+$/, ''),
  };
}

/** Parses the Worker env into a typed Config. On error only the variable name is returned. */
export function parseConfig(env: Record<string, unknown>): ConfigResult {
  try {
    return { ok: true, config: build(env) };
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, variable: e.variable };
    throw e;
  }
}
