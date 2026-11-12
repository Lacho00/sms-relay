import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { deliveries, messages } from '../../src/db/schema';

describe('db schema', () => {
  it('declares the spec tables, indexes and cascade foreign key', () => {
    const m = getTableConfig(messages);
    const d = getTableConfig(deliveries);
    expect(m.name).toBe('messages');
    expect(m.indexes.map((i) => i.config.name).sort()).toEqual([
      'messages_created_at_idx',
      'messages_dedup_key_unique',
    ]);
    expect(d.name).toBe('deliveries');
    expect(d.indexes.map((i) => i.config.name).sort()).toEqual([
      'deliveries_message_destination_unique',
      'deliveries_status_alerted_idx',
      'deliveries_status_next_attempt_idx',
    ]);
    const fk = d.foreignKeys[0]!.reference();
    expect(fk.foreignTable).toBe(messages);
    expect(d.foreignKeys[0]!.onDelete).toBe('cascade');
  });
});
