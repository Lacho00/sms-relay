export type Destination = 'telegram' | 'webhook';

export type LogEvent =
  | 'ingest.stored'
  | 'ingest.duplicate'
  | 'ingest.rejected'
  | 'delivery.delivered'
  | 'delivery.retry'
  | 'delivery.failed'
  | 'retention.purged'
  | 'config.invalid'
  | 'internal.error';

/**
 * Closed set of safe fields: no free text, so a sender or body cannot be logged.
 * `error` takes only codes made here (ErrorCode, `http_<n>`, `timeout`, `network`,
 * `redirect`); `variable` takes only config variable names.
 */
export type LogFields = {
  id?: number;
  deliveryId?: number;
  destination?: Destination;
  status?: number;
  error?: string;
  attempt?: number;
  count?: number;
  ms?: number;
  variable?: string;
};

export function log(event: LogEvent, fields?: LogFields): void {
  console.log(JSON.stringify({ event, ...fields }));
}
