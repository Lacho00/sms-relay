import { claimAlerts, releaseAlerts, type AlertRow } from './db/repo';
import { sendJson } from './destinations/http';
import { log, type LogError } from './log';
import { classify, errorCode } from './outbox/backoff';
import type { OutboxDeps } from './outbox/process';

export const ALERT_BATCH = 20;

/** Plain-text alert: no sender, no body, only ids and failure reasons. */
export function formatAlertText(rows: AlertRow[]): string {
  const header = `sms-relay: ${rows.length} ${rows.length === 1 ? 'delivery' : 'deliveries'} failed`;
  const lines = rows.map(
    (r) =>
      `message ${r.messageId} · ${r.destination} · ${r.lastError ?? 'unknown'} · ${r.attempts} ${r.attempts === 1 ? 'attempt' : 'attempts'}`,
  );
  return [header, '', ...lines, '', 'GET /v1/messages/<id> for details.'].join('\n');
}

/**
 * Claims up to ALERT_BATCH failed deliveries and sends one Telegram alert for them. Alerts off or
 * Telegram missing: the claim stands and nothing is sent. A retryable send error gives the claim back.
 */
export async function sendAlerts(deps: OutboxDeps): Promise<void> {
  const claimedAt = deps.now();
  const rows = await claimAlerts(deps.db, claimedAt, ALERT_BATCH);
  if (rows.length === 0) return;
  const { config } = deps;
  if (!config.alertsEnabled || config.telegram === null) {
    log('alert.suppressed', { count: rows.length });
    return;
  }
  const body = JSON.stringify({
    chat_id: config.telegram.chatId,
    text: formatAlertText(rows),
    link_preview_options: { is_disabled: true },
  });
  const { result } = await sendJson(
    deps.fetch,
    `${config.telegramApiBase}/bot${config.telegram.botToken}/sendMessage`,
    body,
    {},
    claimedAt,
  );
  const verdict = classify(result);
  const count = rows.length;
  if (verdict === 'delivered') {
    log('alert.sent', { count });
    return;
  }
  const error = errorCode(result) as LogError;
  if (verdict === 'retry') {
    try {
      await releaseAlerts(deps.db, rows.map((r) => r.id), claimedAt);
    } catch {
      // The claim stays set, so these rows are not alerted again. The error itself is not logged.
      log('alert.failed', { count, error: 'internal' });
      return;
    }
    log('alert.retry', { count, error });
    return;
  }
  log('alert.failed', result.kind === 'response' ? { count, error, status: result.status } : { count, error });
}
