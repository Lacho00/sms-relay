import type { Context } from 'hono';
import { parseConfig } from '../config';
import { getDeliveries, getMessage, listMessages, type DeliveryRow, type MessageRow } from '../db/repo';
import { bearerToken, tokensEqual } from '../http/auth';
import { errorResponse } from '../http/errors';
import { isAllowed, rateLimitedResponse, type Limiter } from '../http/rate-limit';
import { log } from '../log';

type Ctx = Context<{ Bindings: Env }>;

export type ReadDeps = { limiters: (env: Env) => { read: Limiter } };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Cursor = base64url of the decimal id of the last message on the page. */
export function encodeCursor(id: number): string {
  return btoa(String(id)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(s: string): number | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  let decoded: string;
  try {
    decoded = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  return parseId(decoded);
}

/** A positive safe integer written in plain decimal, or null. */
function parseId(s: string): number | null {
  if (!/^[1-9]\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

const iso = (ms: number) => new Date(ms).toISOString();

function messageJson(m: MessageRow) {
  return {
    id: m.id,
    sender: m.sender,
    body: m.body,
    received_at: iso(m.receivedAt),
    sim: m.sim,
    device: m.device,
    created_at: iso(m.createdAt),
  };
}

function deliveryJson(d: DeliveryRow) {
  return {
    destination: d.destination,
    status: d.status,
    attempts: d.attempts,
    last_error: d.lastError,
    last_status_code: d.lastStatusCode,
    next_attempt_at: iso(d.nextAttemptAt),
    delivered_at: d.deliveredAt === null ? null : iso(d.deliveredAt),
  };
}

/** Config, rate limit and auth for the read routes; returns a Response to send when the request is refused. */
async function guard(c: Ctx, deps: ReadDeps): Promise<Response | null> {
  const parsed = parseConfig(c.env as unknown as Record<string, unknown>);
  if (!parsed.ok) {
    log('config.invalid', { variable: parsed.variable });
    return errorResponse(503, 'config_invalid', 'Server configuration is invalid');
  }
  const token = parsed.config.readToken;
  if (token === null) return errorResponse(503, 'not_configured', 'Read API is not configured');
  if (!(await isAllowed(deps.limiters(c.env).read, 'read', c.req.raw))) {
    log('read.rejected', { status: 429, error: 'rate_limited' });
    return rateLimitedResponse();
  }
  const presented = bearerToken(c.req.header('Authorization'));
  if (presented === null || !(await tokensEqual(presented, token))) {
    return errorResponse(401, 'unauthorized', 'Missing or invalid bearer token');
  }
  return null;
}

const bad = (message: string) => errorResponse(400, 'validation_failed', message);

/** GET /v1/messages?limit=&cursor= */
export async function handleList(c: Ctx, deps: ReadDeps): Promise<Response> {
  const refused = await guard(c, deps);
  if (refused) return refused;

  const q = new URL(c.req.url).searchParams;
  let limit = DEFAULT_LIMIT;
  const rawLimit = q.get('limit');
  if (rawLimit !== null) {
    const n = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!(n >= 1 && n <= MAX_LIMIT)) return bad(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    limit = n;
  }
  let before: number | null = null;
  const rawCursor = q.get('cursor');
  if (rawCursor !== null) {
    before = decodeCursor(rawCursor);
    if (before === null) return bad('cursor is invalid');
  }

  // One extra row tells whether another page exists.
  const page = await listMessages(c.env.DB, before, limit + 1);
  const rows = page.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  const messages = rows.map((m) => ({
    ...messageJson(m),
    deliveries: (page.deliveries.get(m.id) ?? []).map((d) => ({ destination: d.destination, status: d.status })),
  }));
  return c.json({
    messages,
    next_cursor: page.rows.length > limit && last ? encodeCursor(last.id) : null,
  });
}

/** GET /v1/messages/:id */
export async function handleDetail(c: Ctx, deps: ReadDeps): Promise<Response> {
  const refused = await guard(c, deps);
  if (refused) return refused;

  const id = parseId(c.req.param('id') ?? '');
  const message = id === null ? null : await getMessage(c.env.DB, id);
  if (id === null || message === null) return errorResponse(404, 'not_found', 'Not found');
  const deliveries = await getDeliveries(c.env.DB, id);
  return c.json({ ...messageJson(message), deliveries: deliveries.map(deliveryJson) });
}
