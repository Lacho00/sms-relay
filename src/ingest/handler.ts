import type { Context } from 'hono';
import { parseConfig } from '../config';
import { insertMessage } from '../db/repo';
import { selectDestinations } from '../destinations/filter';
import { bearerToken, tokensEqual } from '../http/auth';
import { errorResponse, type ErrorCode } from '../http/errors';
import { isAllowed, rateLimitedResponse, type Limiter } from '../http/rate-limit';
import { log } from '../log';
import { dedupKey } from './identity';
import { parseIngest } from './schema';

export const MAX_BODY_BYTES = 64 * 1024;

export type IngestDeps = {
  now: () => number;
  onStored: (env: Env, ids: number[]) => Promise<void>;
  limiters: (env: Env) => { ingest: Limiter };
};

type Rejection = { status: 400 | 401 | 503; code: ErrorCode; message: string };

function reject({ status, code, message }: Rejection): Response {
  log('ingest.rejected', { status, error: code });
  return errorResponse(status, code, message);
}

/**
 * Reads the body as UTF-8 text, counting the bytes actually read. Returns null as soon as the
 * count passes `limit`, so a body without (or with a false) Content-Length cannot exceed it.
 */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * POST /v1/sms. Order: config → rate limit → auth → size → JSON → schema → dedup → store. Only 200, 400, 401,
 * 429 and 503 come out of here; anything thrown becomes 500 in the app's error handler.
 */
export async function handleIngest(c: Context<{ Bindings: Env }>, deps: IngestDeps): Promise<Response> {
  const parsed = parseConfig(c.env as unknown as Record<string, unknown>);
  if (!parsed.ok) {
    log('config.invalid', { variable: parsed.variable });
    return reject({ status: 503, code: 'config_invalid', message: 'Server configuration is invalid' });
  }
  const config = parsed.config;
  if (config.ingestToken === null) {
    return reject({ status: 503, code: 'not_configured', message: 'Ingest is not configured' });
  }

  if (!(await isAllowed(deps.limiters(c.env).ingest, 'ingest', c.req.raw))) {
    log('ingest.rejected', { status: 429, error: 'rate_limited' });
    return rateLimitedResponse();
  }

  const presented = bearerToken(c.req.header('Authorization'));
  if (presented === null || !(await tokensEqual(presented, config.ingestToken))) {
    return reject({ status: 401, code: 'unauthorized', message: 'Missing or invalid bearer token' });
  }

  const text = await readLimited(c.req.raw, MAX_BODY_BYTES);
  if (text === null) {
    return reject({
      status: 400,
      code: 'payload_too_large',
      message: `Body exceeds ${MAX_BODY_BYTES} bytes`,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reject({ status: 400, code: 'invalid_json', message: 'Body is not valid JSON' });
  }

  const now = deps.now();
  const result = parseIngest(raw, now);
  if (!result.ok) {
    return reject({ status: 400, code: 'validation_failed', message: result.message });
  }
  const input = result.value;

  const key = await dedupKey(input.sender, input.receivedAt, input.body);
  const destinations = selectDestinations(config, input.sender);
  const stored = await insertMessage(c.env.DB, input, key, destinations, now);

  if (stored.status === 'duplicate') {
    log('ingest.duplicate', { id: stored.id });
    return c.json({ status: 'duplicate', id: stored.id }, 200);
  }

  log('ingest.stored', { id: stored.id, count: stored.deliveryIds.length });
  c.executionCtx.waitUntil(
    deps.onStored(c.env, stored.deliveryIds).catch(() => {
      log('internal.error', { error: 'internal' });
    }),
  );
  return c.json({ status: 'stored', id: stored.id }, 200);
}
