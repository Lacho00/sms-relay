import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dedupKey: text('dedup_key').notNull(),
    sender: text('sender').notNull(),
    body: text('body').notNull(),
    receivedAt: integer('received_at').notNull(),
    sim: integer('sim'),
    device: text('device'),
    createdAt: integer('created_at').notNull(),
    ingestNonce: text('ingest_nonce').notNull(),
  },
  (t) => [
    uniqueIndex('messages_dedup_key_unique').on(t.dedupKey),
    index('messages_created_at_idx').on(t.createdAt),
  ],
);

export const deliveries = sqliteTable(
  'deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    destination: text('destination', { enum: ['telegram', 'webhook'] }).notNull(),
    status: text('status', { enum: ['pending', 'delivered', 'failed'] }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    lockedUntil: integer('locked_until'),
    lastError: text('last_error'),
    lastStatusCode: integer('last_status_code'),
    deliveredAt: integer('delivered_at'),
    alertedAt: integer('alerted_at'),
    partsSent: integer('parts_sent').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('deliveries_status_next_attempt_idx').on(t.status, t.nextAttemptAt),
    index('deliveries_status_alerted_idx').on(t.status, t.alertedAt),
    uniqueIndex('deliveries_message_destination_unique').on(t.messageId, t.destination),
  ],
);

