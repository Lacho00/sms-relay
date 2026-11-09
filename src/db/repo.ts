import type { IngestInput } from '../ingest/schema';
import type { Destination } from '../log';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export type MessageRow = {
  id: number;
  sender: string;
  body: string;
  receivedAt: number;
  sim: number | null;
  device: string | null;
  createdAt: number;
};

export type DeliveryRow = {
  id: number;
  messageId: number;
  destination: Destination;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lockedUntil: number | null;
  lastError: string | null;
  lastStatusCode: number | null;
  deliveredAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * Inserts the message and one pending delivery per destination in a single D1 batch (one
 * transaction). The deliveries only match when this request's nonce created the message row, so
 * a duplicate never adds deliveries.
 */
export async function insertMessage(
  db: D1Database,
  input: IngestInput,
  key: string,
  destinations: Destination[],
  now: number,
): Promise<{ status: 'stored' | 'duplicate'; id: number; deliveryIds: number[] }> {
  const nonce = crypto.randomUUID();
  const statements = [
    db
      .prepare(
        `INSERT INTO messages (dedup_key, sender, body, received_at, sim, device, created_at, ingest_nonce)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedup_key) DO NOTHING`,
      )
      .bind(key, input.sender, input.body, input.receivedAt, input.sim, input.device, now, nonce),
    ...destinations.map((destination) =>
      db
        .prepare(
          `INSERT INTO deliveries (message_id, destination, status, attempts, next_attempt_at, created_at, updated_at)
           SELECT id, ?, 'pending', 0, ?, ?, ? FROM messages WHERE dedup_key = ? AND ingest_nonce = ?`,
        )
        .bind(destination, now, now, now, key, nonce),
    ),
    db.prepare('SELECT id, ingest_nonce FROM messages WHERE dedup_key = ?').bind(key),
  ];
  const results = await db.batch(statements);
  const row = results[results.length - 1]!.results[0] as { id: number; ingest_nonce: string };
  if (row.ingest_nonce !== nonce) return { status: 'duplicate', id: row.id, deliveryIds: [] };
  const deliveryIds = (await getDeliveries(db, row.id)).map((d) => d.id);
  return { status: 'stored', id: row.id, deliveryIds };
}

type MessageSql = {
  id: number;
  sender: string;
  body: string;
  received_at: number;
  sim: number | null;
  device: string | null;
  created_at: number;
};

export async function getMessage(db: D1Database, id: number): Promise<MessageRow | null> {
  const r = await db
    .prepare('SELECT id, sender, body, received_at, sim, device, created_at FROM messages WHERE id = ?')
    .bind(id)
    .first<MessageSql>();
  if (!r) return null;
  return {
    id: r.id,
    sender: r.sender,
    body: r.body,
    receivedAt: r.received_at,
    sim: r.sim,
    device: r.device,
    createdAt: r.created_at,
  };
}

type DeliverySql = {
  id: number;
  message_id: number;
  destination: Destination;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  locked_until: number | null;
  last_error: string | null;
  last_status_code: number | null;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
};

export async function getDeliveries(db: D1Database, messageId: number): Promise<DeliveryRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM deliveries WHERE message_id = ? ORDER BY id')
    .bind(messageId)
    .all<DeliverySql>();
  return results.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    destination: r.destination,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lockedUntil: r.locked_until,
    lastError: r.last_error,
    lastStatusCode: r.last_status_code,
    deliveredAt: r.delivered_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}
