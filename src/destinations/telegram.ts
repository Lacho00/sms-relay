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

/** Plain-text message with the full body; splitting into parts is done by splitTelegramText. */
export function formatTelegramText(m: MessageRow, timeZone: string): string {
  return `SMS from ${m.sender}\n${formatDate(m.receivedAt, timeZone)} ${timeZone}\n\n${m.body}`;
}

const SPLIT_LOOKBACK = 512;

/** Cuts text greedily into windows of `width` units, preferring a newline, then a space, near the end. */
function cutWindows(text: string, width: number): string[] {
  const windows: string[] = [];
  let pos = 0;
  while (text.length - pos > width) {
    const end = pos + width;
    const from = Math.max(pos, end - SPLIT_LOOKBACK);
    const window = text.slice(from, end);
    let at = window.lastIndexOf('\n');
    if (at < 0) at = window.lastIndexOf(' ');
    if (at >= 0) {
      windows.push(text.slice(pos, from + at));
      pos = from + at + 1;
      continue;
    }
    let cut = end;
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff && cut - 1 > pos) cut -= 1;
    windows.push(text.slice(pos, cut));
    pos = cut;
  }
  windows.push(text.slice(pos));
  return windows;
}

/**
 * Splits text into parts of at most `max` UTF-16 units, each prefixed `(k/n)\n`. Text that already
 * fits is returned unchanged as a single part.
 */
export function splitTelegramText(text: string, max: number = TELEGRAM_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  let n = 1;
  for (;;) {
    const markerWidth = `(${n}/${n})\n`.length;
    const windows = cutWindows(text, max - markerWidth);
    if (windows.length === n) return windows.map((w, i) => `(${i + 1}/${n})\n${w}`);
    n = windows.length;
  }
}

export function telegramParts(m: MessageRow, timeZone: string): string[] {
  return splitTelegramText(formatTelegramText(m, timeZone));
}

export async function sendTelegramText(
  fetchFn: typeof fetch,
  cfg: TelegramConfig,
  apiBase: string,
  text: string,
  now: number,
): Promise<SendResult> {
  const body = JSON.stringify({
    chat_id: cfg.chatId,
    text,
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
