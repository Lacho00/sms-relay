import type { Config } from '../config';
import {
  claimDelivery,
  dueDeliveryIds,
  getMessage,
  markDelivered,
  markFailed,
  markRetry,
  type DeliveryRow,
  type MessageRow,
} from '../db/repo';
import { formatTelegramText, sendTelegramText } from '../destinations/telegram';
import { sendWebhook } from '../destinations/webhook';
import { log, type LogError } from '../log';
import { classify, errorCode, nextDelayMs, type SendResult } from './backoff';

export type OutboxDeps = { db: D1Database; config: Config; fetch: typeof fetch; now: () => number };

export const CRON_BATCH = 50;
export const CONCURRENCY = 5;

/** Sends one delivery to its destination; null when that destination is no longer configured. */
function send(deps: OutboxDeps, row: DeliveryRow, m: MessageRow, now: number): Promise<SendResult> | null {
  const { config } = deps;
  if (row.destination === 'telegram') {
    if (!config.telegram) return null;
    return sendTelegramText(
      deps.fetch,
      config.telegram,
      config.telegramApiBase,
      formatTelegramText(m, config.displayTimeZone),
      now,
    );
  }
  if (!config.webhook) return null;
  return sendWebhook(deps.fetch, config.webhook, m, row.id, now);
}

/**
 * claim (counts the attempt) → message → send → classify → mark. Every mark carries the lease
 * token from the claim; when the lease was lost meanwhile, nothing is written and no delivery.*
 * event is logged.
 */
async function processOne(deps: OutboxDeps, id: number): Promise<void> {
  const { db } = deps;
  const claimedAt = deps.now();
  const row = await claimDelivery(db, id, claimedAt);
  if (!row) return;
  const attempt = row.attempts;
  const lease = row.lockedUntil!;
  const base = { deliveryId: id, destination: row.destination, attempt };

  const settled = (changed: boolean, event: () => void) => {
    if (changed) event();
    else log('internal.error', { deliveryId: id, error: 'lease_lost' });
  };
  const fail = async (error: LogError, status: number | null, now: number, ms?: number) => {
    const changed = await markFailed(db, id, lease, attempt, error, status, now);
    settled(changed, () => log('delivery.failed', { ...base, error, status: status ?? undefined, ms }));
  };

  // Earlier claims used every attempt without settling the row (crashed workers): stop here.
  if (attempt > deps.config.maxAttempts) return fail('attempts_exhausted', null, claimedAt);

  const m = await getMessage(db, row.messageId);
  if (!m) return fail('message_missing', null, claimedAt);

  const pending = send(deps, row, m, claimedAt);
  if (!pending) return fail('destination_removed', null, claimedAt);
  const result = await pending;
  const now = deps.now();
  const ms = now - claimedAt;
  const status = result.kind === 'response' ? result.status : null;
  const verdict = classify(result);

  if (verdict === 'delivered') {
    const changed = await markDelivered(db, id, lease, attempt, status!, now);
    settled(changed, () => log('delivery.delivered', { ...base, status: status!, ms }));
    return;
  }
  // Non-null for every non-2xx result.
  const error = errorCode(result) as LogError;
  if (verdict === 'failed' || attempt >= deps.config.maxAttempts) return fail(error, status, now, ms);
  const retryAfterMs = result.kind === 'response' ? result.retryAfterMs : null;
  const changed = await markRetry(db, id, lease, attempt, now + nextDelayMs(attempt, retryAfterMs), error, status, now);
  settled(changed, () => log('delivery.retry', { ...base, error, status: status ?? undefined, ms }));
}

/**
 * Processes the given deliveries with at most CONCURRENCY in flight. An error in one never stops
 * the others; a row that throws after its claim keeps its lease, so the cron retries it later.
 */
export async function processDeliveries(deps: OutboxDeps, ids: number[]): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      try {
        await processOne(deps, id);
      } catch {
        // The error itself is never logged: it could carry request data.
        log('internal.error', { deliveryId: id, error: 'internal' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
}

/** Cron step: processes up to CRON_BATCH due deliveries, oldest first. Returns how many were due. */
export async function retryDue(deps: OutboxDeps): Promise<number> {
  const ids = await dueDeliveryIds(deps.db, deps.now(), CRON_BATCH);
  await processDeliveries(deps, ids);
  return ids.length;
}
