import { Hono } from 'hono';
import { errorBody } from './http/errors';
import { handleIngest } from './ingest/handler';
import { log } from './log';

export type AppDeps = {
  fetch: typeof fetch;
  now: () => number;
  /** Runs after a new message is stored, through `waitUntil`, with its new delivery ids. */
  onStored: (env: Env, ids: number[]) => Promise<void>;
};

export function createApp(deps: Partial<AppDeps> = {}): Hono<{ Bindings: Env }> {
  const resolved: AppDeps = {
    fetch: globalThis.fetch.bind(globalThis),
    now: Date.now,
    onStored: async () => {},
    ...deps,
  };

  const app = new Hono<{ Bindings: Env }>();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.post('/v1/sms', (c) => handleIngest(c, resolved));

  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));

  // The error itself is never logged: its message could carry request data.
  app.onError((_err, c) => {
    log('internal.error', { error: 'internal' });
    return c.json(errorBody('internal', 'Internal error'), 500);
  });

  return app;
}
