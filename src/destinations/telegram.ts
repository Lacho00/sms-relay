import type { TelegramConfig } from '../config';
import type { MessageRow } from '../db/repo';
import type { SendResult } from '../outbox/backoff';
import { sendJson } from './http';

export const TELEGRAM_MAX_CHARS = 4096;

function formatDate(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** Plain-text message; cut to TELEGRAM_MAX_CHARS UTF-16 units on a code point boundary. */
export function formatTelegramText(m: MessageRow, timeZone: string): string {
  const text = `SMS from ${m.sender}\n${formatDate(m.receivedAt, timeZone)} ${timeZone}\n\n${m.body}`;
  if (text.length <= TELEGRAM_MAX_CHARS) return text;
  let out = '';
  for (const ch of Array.from(text)) {
    if (out.length + ch.length > TELEGRAM_MAX_CHARS - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export async function sendTelegram(
  fetchFn: typeof fetch,
  cfg: TelegramConfig,
  apiBase: string,
  timeZone: string,
  m: MessageRow,
  now: number,
): Promise<SendResult> {
  const body = JSON.stringify({
    chat_id: cfg.chatId,
    text: formatTelegramText(m, timeZone),
    link_preview_options: { is_disabled: true },
  });
  const { result, json } = await sendJson(fetchFn, `${apiBase}/bot${cfg.botToken}/sendMessage`, body, {}, now);
  if (result.kind === 'response' && result.status === 429) {
    const seconds = (json as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
      return { ...result, retryAfterMs: seconds * 1000 };
    }
  }
  return result;
}
