import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const seedMessage = async () => {
  const r = await env.DB.prepare(
    `INSERT INTO messages (dedup_key, sender, body, received_at, created_at, ingest_nonce)
     VALUES (?, 'ACME', 'hi', 1, 1, 'n') RETURNING id`,
  )
    .bind(`k-${crypto.randomUUID()}`)
    .first<{ id: number }>();
  return r!.id;
};

const insertDelivery = async (messageId: number, dest: string, status: string, updatedAt: number) => {
  const r = await env.DB.prepare(
    `INSERT INTO deliveries (message_id, destination, status, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?) RETURNING id`,
  )
    .bind(messageId, dest, status, updatedAt)
    .first<{ id: number }>();
  return r!.id;
};

describe('migration 0001', () => {
  it('backfills alerted_at for failed deliveries', async () => {
    const m1 = await seedMessage();
    const m2 = await seedMessage();
    const failed = await insertDelivery(m1, 'telegram', 'failed', 1000);
    const pending = await insertDelivery(m1, 'webhook', 'pending', 1000);
    const delivered = await insertDelivery(m2, 'telegram', 'delivered', 1000);

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0001'));
    expect(migration).toBeDefined();
    // The reader leaves the `--> statement-breakpoint` marker at the head of each query.
    const update = migration!.queries
      .map((q) => q.replace('--> statement-breakpoint', '').trim())
      .find((q) => q.startsWith('UPDATE'));
    expect(update).toBeDefined();
    await env.DB.prepare(update!).run();

    const alerted = async (id: number) =>
      (await env.DB.prepare('SELECT alerted_at FROM deliveries WHERE id = ?').bind(id).first<{ alerted_at: number | null }>())!
        .alerted_at;
    expect(await alerted(failed)).toBe(1000);
    expect(await alerted(pending)).toBeNull();
    expect(await alerted(delivered)).toBeNull();
  });

  it('parts_sent defaults to 0', async () => {
    const m = await seedMessage();
    const id = await insertDelivery(m, 'telegram', 'pending', 1);
    const r = await env.DB.prepare('SELECT parts_sent FROM deliveries WHERE id = ?').bind(id).first<{ parts_sent: number }>();
    expect(r!.parts_sent).toBe(0);
  });
});
