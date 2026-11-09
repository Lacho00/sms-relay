import { Hono } from 'hono';

export type AppDeps = { fetch: typeof fetch; now: () => number };

export function createApp(deps: Partial<AppDeps> = {}): Hono<{ Bindings: Env }> {
  const resolved: AppDeps = {
    fetch: globalThis.fetch.bind(globalThis),
    now: Date.now,
    ...deps,
  };

  const app = new Hono<{ Bindings: Env }>();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.notFound((c) => c.json({ error: 'not_found', message: 'Not found' }, 404));

  return app;
}
