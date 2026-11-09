import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_CHARS,
  MAX_FUTURE_MS,
  MAX_SENDER_CHARS,
  MIN_RECEIVED_AT,
  parseIngest,
  parseReceivedAt,
} from '../../src/ingest/schema';

const NOW = 1762697001000;
const valid = { sender: '+34600111222', body: 'hello', received_at: NOW };

function fail(raw: unknown): string {
  const r = parseIngest(raw, NOW);
  if (r.ok) throw new Error('expected failure');
  return r.message;
}

function ok(raw: unknown) {
  const r = parseIngest(raw, NOW);
  if (!r.ok) throw new Error(`expected success: ${r.message}`);
  return r.value;
}

describe('constants', () => {
  it('match the spec', () => {
    expect(MAX_BODY_CHARS).toBe(10_000);
    expect(MAX_SENDER_CHARS).toBe(64);
    expect(MIN_RECEIVED_AT).toBe(Date.UTC(2000, 0, 1));
    expect(MAX_FUTURE_MS).toBe(86_400_000);
  });
});

describe('parseReceivedAt', () => {
  it('accepts epoch ms as a number or digit string', () => {
    expect(parseReceivedAt(1762697001000)).toBe(1762697001000);
    expect(parseReceivedAt('1762697001000')).toBe(1762697001000);
  });

  it('accepts ISO 8601 with a zone', () => {
    expect(parseReceivedAt('2025-11-09T14:03:21Z')).toBe(1762697001000);
    expect(parseReceivedAt('2025-11-09T15:03:21+01:00')).toBe(1762697001000);
    expect(parseReceivedAt('2025-11-09T14:03:21.000+00:00')).toBe(1762697001000);
  });

  it('rejects ISO without a zone', () => {
    expect(parseReceivedAt('2025-11-09T14:03:21')).toBeNull();
  });

  it('rejects other values', () => {
    for (const v of [1.5, -1, 'abc', true, null, undefined, {}, '', '12345678901234567890', '2025-13-45T99:99:99Z']) {
      expect(parseReceivedAt(v)).toBeNull();
    }
  });
});

describe('parseIngest', () => {
  it('fails on {} naming sender, body and received_at', () => {
    const m = fail({});
    expect(m).toContain('sender');
    expect(m).toContain('body');
    expect(m).toContain('received_at');
  });

  it('fails on non-objects', () => {
    for (const v of [null, 'x', 1, [], undefined]) expect(fail(v)).toContain('payload');
  });

  it('accepts a valid payload with null sim and device', () => {
    expect(ok(valid)).toEqual({
      sender: '+34600111222',
      body: 'hello',
      receivedAt: NOW,
      sim: null,
      device: null,
    });
  });

  describe('sender', () => {
    it('trims', () => expect(ok({ ...valid, sender: '  x  ' }).sender).toBe('x'));
    it('allows 64 chars, rejects 65', () => {
      expect(ok({ ...valid, sender: 'x'.repeat(64) }).sender).toHaveLength(64);
      expect(fail({ ...valid, sender: 'x'.repeat(65) })).toContain('sender');
    });
    it('rejects blank and empty', () => {
      expect(fail({ ...valid, sender: '   ' })).toContain('sender');
      expect(fail({ ...valid, sender: ' ' })).toContain('sender');
      expect(fail({ ...valid, sender: '' })).toContain('sender');
    });
    it('rejects non-strings', () => expect(fail({ ...valid, sender: 5 })).toContain('sender'));
  });

  describe('body', () => {
    it('boundaries', () => {
      expect(ok({ ...valid, body: 'a'.repeat(10_000) }).body).toHaveLength(10_000);
      expect(fail({ ...valid, body: 'a'.repeat(10_001) })).toContain('body');
      expect(fail({ ...valid, body: '' })).toContain('body');
      expect(fail({ ...valid, body: 7 })).toContain('body');
    });
    it('counts UTF-16 units', () => {
      expect(ok({ ...valid, body: '😀'.repeat(5000) }).body).toHaveLength(10_000);
    });
  });

  describe('received_at', () => {
    it('rejects seconds with a hint', () => {
      expect(fail({ ...valid, received_at: 1762697001 })).toBe(
        'received_at: expected epoch milliseconds or ISO 8601 with zone',
      );
    });
    it('rejects bad formats', () => {
      expect(fail({ ...valid, received_at: 'nope' })).toContain('received_at');
    });
    it('enforces the future limit', () => {
      expect(ok({ ...valid, received_at: NOW + MAX_FUTURE_MS }).receivedAt).toBe(NOW + MAX_FUTURE_MS);
      expect(fail({ ...valid, received_at: NOW + 86_400_001 })).toContain('received_at');
    });
    it('accepts ISO strings', () => {
      expect(ok({ ...valid, received_at: '2025-11-09T15:03:21+01:00' }).receivedAt).toBe(NOW);
    });
  });

  describe('sim', () => {
    it('accepts 0-15, empty string, null, missing', () => {
      expect(ok({ ...valid, sim: 1 }).sim).toBe(1);
      expect(ok({ ...valid, sim: 0 }).sim).toBe(0);
      expect(ok({ ...valid, sim: 15 }).sim).toBe(15);
      expect(ok({ ...valid, sim: '' }).sim).toBeNull();
      expect(ok({ ...valid, sim: null }).sim).toBeNull();
      expect(ok(valid).sim).toBeNull();
    });
    it('rejects 16, -1, 1.5 and strings', () => {
      for (const sim of [16, -1, 1.5, '1']) expect(fail({ ...valid, sim })).toContain('sim');
    });
  });

  describe('device', () => {
    it('accepts up to 64 chars, null and empty', () => {
      expect(ok({ ...valid, device: 'pixel' }).device).toBe('pixel');
      expect(ok({ ...valid, device: 'd'.repeat(64) }).device).toHaveLength(64);
      expect(ok({ ...valid, device: null }).device).toBeNull();
    });
    it('rejects 65 chars and non-strings', () => {
      expect(fail({ ...valid, device: 'd'.repeat(65) })).toContain('device');
      expect(fail({ ...valid, device: 3 })).toContain('device');
    });
  });

  it('drops unknown keys', () => {
    expect('extra' in ok({ ...valid, extra: 1 })).toBe(false);
  });

  it('never echoes submitted values', () => {
    const msg = fail({ sender: 'SECRET-SENDER'.repeat(10), body: 'SECRET-BODY'.repeat(1000), received_at: 'SECRET-TIME', sim: 'SECRET-SIM', device: 'SECRET-DEV'.repeat(10) });
    expect(msg).not.toMatch(/SECRET/);
    expect(msg).toContain('sender');
    expect(msg).toContain('body');
  });
});
