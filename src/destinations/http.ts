import { parseRetryAfter, type SendResult } from '../outbox/backoff';

const TIMEOUT_MS = 10_000;

/**
 * POSTs a JSON body without following redirects. Never throws: failures map to
 * a timeout or network result. `json` is null when the body is empty or not JSON.
 */
export async function sendJson(
  fetchFn: typeof fetch,
  url: string,
  body: string,
  headers: Record<string, string>,
  now: number,
): Promise<{ result: SendResult; json: unknown }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : (err as { name?: unknown } | null)?.name;
    return { result: { kind: name === 'TimeoutError' ? 'timeout' : 'network' }, json: null };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = null;
  }
  return {
    result: {
      kind: 'response',
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get('Retry-After'), now),
    },
    json,
  };
}
