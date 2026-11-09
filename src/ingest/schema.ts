import { z } from 'zod';
import { normalizeSender } from './identity';

export const MAX_BODY_CHARS = 10_000;
export const MAX_SENDER_CHARS = 64;
export const MAX_DEVICE_CHARS = 64;
export const MIN_RECEIVED_AT = Date.UTC(2000, 0, 1);
export const MAX_FUTURE_MS = 86_400_000;

export type IngestInput = {
  sender: string;
  body: string;
  receivedAt: number;
  sim: number | null;
  device: string | null;
};

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const DIGITS = /^\d+$/;
const SIM_DIGITS = /^\d{1,2}$/;

/** Epoch ms from a number, a digit string or an ISO 8601 string with a zone; null otherwise. */
export function parseReceivedAt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  if (DIGITS.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (!ISO_WITH_ZONE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

const FORMAT_MESSAGE = 'expected epoch milliseconds or ISO 8601 with zone';

function schemaFor(now: number) {
  return z.object({
    sender: z.unknown().transform((v, ctx) => {
      if (typeof v !== 'string') {
        ctx.issues.push({ code: 'custom', message: 'required string', input: undefined });
        return z.NEVER;
      }
      const trimmed = v.trim();
      if (normalizeSender(trimmed).length === 0 || trimmed.length > MAX_SENDER_CHARS) {
        ctx.issues.push({
          code: 'custom',
          message: `expected 1-${MAX_SENDER_CHARS} characters`,
          input: undefined,
        });
        return z.NEVER;
      }
      return trimmed;
    }),
    body: z.unknown().transform((v, ctx) => {
      if (typeof v !== 'string' || v.length === 0 || v.length > MAX_BODY_CHARS) {
        ctx.issues.push({
          code: 'custom',
          message: `expected a string of 1-${MAX_BODY_CHARS} characters`,
          input: undefined,
        });
        return z.NEVER;
      }
      return v;
    }),
    received_at: z.unknown().transform((v, ctx) => {
      const ms = parseReceivedAt(v);
      if (ms === null || ms < MIN_RECEIVED_AT) {
        ctx.issues.push({ code: 'custom', message: FORMAT_MESSAGE, input: undefined });
        return z.NEVER;
      }
      if (ms > now + MAX_FUTURE_MS) {
        ctx.issues.push({
          code: 'custom',
          message: 'must not be more than 24 hours in the future',
          input: undefined,
        });
        return z.NEVER;
      }
      return ms;
    }),
    sim: z.unknown().transform((v, ctx): number | null => {
      if (v === undefined || v === null || v === '') return null;
      const n = typeof v === 'string' && SIM_DIGITS.test(v) ? Number(v) : v;
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 15) return n;
      ctx.issues.push({
        code: 'custom',
        message: 'expected an integer 0-15 (or digit string), null or empty string',
        input: undefined,
      });
      return z.NEVER;
    }),
    device: z.unknown().transform((v, ctx): string | null => {
      if (v === undefined || v === null) return null;
      if (typeof v === 'string' && v.length <= MAX_DEVICE_CHARS) return v;
      ctx.issues.push({
        code: 'custom',
        message: `expected a string of at most ${MAX_DEVICE_CHARS} characters`,
        input: undefined,
      });
      return z.NEVER;
    }),
  });
}

/** Validates an ingest payload. Messages carry field paths and fixed text, never submitted values. */
export function parseIngest(
  raw: unknown,
  now: number,
): { ok: true; value: IngestInput } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'payload: expected a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  // Pick the known keys explicitly so absent ones are validated too and unknown ones are dropped.
  const picked = { sender: r.sender, body: r.body, received_at: r.received_at, sim: r.sim, device: r.device };
  const result = schemaFor(now).safeParse(picked);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.map(String).join('.') || 'payload'}: ${i.message}`)
      .join('; ');
    return { ok: false, message };
  }
  const d = result.data;
  return {
    ok: true,
    value: { sender: d.sender, body: d.body, receivedAt: d.received_at, sim: d.sim, device: d.device },
  };
}
