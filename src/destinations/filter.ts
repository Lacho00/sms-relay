import type { Config, SenderFilter } from '../config';
import { normalizeSender } from '../ingest/identity';
import type { Destination } from '../log';

/**
 * Neither list nor regex set: everything passes. Otherwise the sender passes when its normalized
 * form is in the list (exact match) or the regex matches the sender as received.
 */
export function senderAllowed(sender: string, filter: SenderFilter): boolean {
  if (filter.senders.length === 0 && filter.regex === null) return true;
  const normalized = normalizeSender(sender);
  if (normalized !== '' && filter.senders.includes(normalized)) return true;
  return filter.regex !== null && filter.regex.test(sender);
}

/** The configured destinations whose filter lets this sender through, in a fixed order. */
export function selectDestinations(config: Config, sender: string): Destination[] {
  const out: Destination[] = [];
  if (config.telegram && senderAllowed(sender, config.telegram.filter)) out.push('telegram');
  if (config.webhook && senderAllowed(sender, config.webhook.filter)) out.push('webhook');
  return out;
}
