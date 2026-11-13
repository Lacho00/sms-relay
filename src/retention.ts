const DAY_MS = 86_400_000;

/**
 * Deletes messages created before `now - retentionDays`, at most `limit` per call, together with
 * their deliveries in one batch. Messages with a delivery still `pending`, or `failed` and not yet alerted, are skipped until that ends. `retentionDays` 0 keeps everything. Returns the messages deleted.
 *
 * Both statements select the same expired ids through a subquery, so each binds two values and
 * never a long `IN (...)` list (a list bound twice would exceed the SQLite variable limit at 500).
 */
export async function purgeExpired(
  db: D1Database,
  retentionDays: number,
  now: number,
  limit = 500,
): Promise<number> {
  if (retentionDays === 0) return 0;
  const cutoff = now - retentionDays * DAY_MS;
  const expired =
    'SELECT m.id FROM messages m WHERE m.created_at < ? AND NOT EXISTS ' +
    "(SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND (d.status = 'pending' OR " +
    "(d.status = 'failed' AND d.alerted_at IS NULL))) ORDER BY m.id LIMIT ?";
  const [, messages] = await db.batch([
    db.prepare(`DELETE FROM deliveries WHERE message_id IN (${expired})`).bind(cutoff, limit),
    db.prepare(`DELETE FROM messages WHERE id IN (${expired})`).bind(cutoff, limit),
  ]);
  return messages!.meta.changes;
}
