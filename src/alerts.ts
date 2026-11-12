import type { AlertRow } from './db/repo';

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
