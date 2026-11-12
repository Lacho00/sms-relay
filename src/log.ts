import type { ConfigVariable } from './config';
import type { ErrorCode } from './http/errors';

export type Destination = 'telegram' | 'webhook';

export type LogEvent =
  | 'ingest.stored'
  | 'ingest.duplicate'
  | 'ingest.rejected'
  | 'delivery.delivered'
  | 'delivery.retry'
  | 'delivery.failed'
  | 'retention.purged'
  | 'retention.failed'
  | 'alert.sent'
  | 'alert.retry'
  | 'alert.failed'
  | 'alert.suppressed'
  | 'read.rejected'
  | 'config.invalid'
  | 'internal.error';

/**
 * Closed set of safe fields: no free text, so a sender or body cannot be logged.
 * `error` takes only codes made here (ErrorCode, `http_<n>`, `timeout`, `network`,
 * `redirect`, `destination_removed`, `message_missing`,
 * `attempts_exhausted`, `lease_lost`, `rate_limit_unavailable`); `variable` takes only config variable names.
 */
export type LogError =
  | ErrorCode
  | `http_${number}`
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'destination_removed'
  | 'message_missing'
  | 'attempts_exhausted'
  | 'lease_lost'
  | 'rate_limit_unavailable';

export type LogFields = {
  id?: number;
  deliveryId?: number;
  destination?: Destination;
  status?: number;
  error?: LogError;
  attempt?: number;
  count?: number;
  ms?: number;
  variable?: ConfigVariable;
};

const ALLOWED = [
  'id',
  'deliveryId',
  'destination',
  'status',
  'error',
  'attempt',
  'count',
  'ms',
  'variable',
] as const satisfies readonly (keyof LogFields)[];

/** Copies only whitelisted keys, so extra properties on a wider object are never serialized. */
export function log(event: LogEvent, fields: LogFields = {}): void {
  const out: Record<string, unknown> = { event };
  for (const key of ALLOWED) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  console.log(JSON.stringify(out));
}
