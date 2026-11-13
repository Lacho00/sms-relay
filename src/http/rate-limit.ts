import { log } from '../log';
import { errorBody } from './errors';

export type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type RouteFamily = 'ingest' | 'read';

/** One counter per route family and client IP. The IP only ever lives inside this key. */
export function rateLimitKey(family: RouteFamily, request: Request): string {
  return `${family}:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`;
}

/** Fails open: a limiter outage must not drop an SMS, so a throwing limiter allows the request. */
export async function isAllowed(limiter: Limiter, family: RouteFamily, request: Request): Promise<boolean> {
  try {
    const { success } = await limiter.limit({ key: rateLimitKey(family, request) });
    return success;
  } catch {
    log('internal.error', { error: 'rate_limit_unavailable' });
    return true;
  }
}

export function rateLimitedResponse(): Response {
  return Response.json(errorBody('rate_limited', 'Too many requests'), {
    status: 429,
    headers: { 'Retry-After': '60' },
  });
}
