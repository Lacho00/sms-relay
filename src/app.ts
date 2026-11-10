import { Hono } from 'hono';
import { parseConfig } from './config';
import { errorBody } from './http/errors';
import { handleIngest } from './ingest/handler';
import { log } from './log';
import { handleDetail, handleList } from './read/handler';
import { processDeliveries, retryDue, type OutboxDeps } from './outbox/process';
import { purgeExpired } from './retention';

export type Runtime = {
  fetch: typeof fetch;
  now: () => number;
};

export type AppDeps = Runtime & {
  /** Runs after a new message is stored, through `waitUntil`, with its new delivery ids. */
  onStored: (env: Env, ids: number[]) => Promise<void>;
};

function resolveRuntime(deps: Partial<Runtime>): Runtime {
  return { fetch: deps.fetch ?? globalThis.fetch.bind(globalThis), now: deps.now ?? Date.now };
}

/** Parses the config from env and runs `job` with outbox deps. Invalid config: logs and runs nothing. */
async function withOutbox(env: Env, runtime: Runtime, job: (deps: OutboxDeps) => Promise<unknown>): Promise<void> {
  const parsed = parseConfig(env as unknown as Record<string, unknown>);
  if (!parsed.ok) {
    log('config.invalid', { variable: parsed.variable });
    return;
  }
  await job({ db: env.DB, config: parsed.config, fetch: runtime.fetch, now: runtime.now });
}

export function createApp(deps: Partial<AppDeps> = {}): Hono<{ Bindings: Env }> {
  const runtime = resolveRuntime(deps);
  const resolved: AppDeps = {
    ...runtime,
    onStored: (env, ids) => withOutbox(env, runtime, (d) => processDeliveries(d, ids)),
    ...(deps.onStored ? { onStored: deps.onStored } : {}),
  };

  const app = new Hono<{ Bindings: Env }>();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.post('/v1/sms', (c) => handleIngest(c, resolved));

  app.get('/v1/messages', handleList);
  app.get('/v1/messages/:id', handleDetail);

  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));

  // The error itself is never logged: its message could carry request data.
  app.onError((_err, c) => {
    log('internal.error', { error: 'internal' });
    return c.json(errorBody('internal', 'Internal error'), 500);
  });

  return app;
}

/** The cron handler: purges expired messages, then retries due deliveries, through `waitUntil`. */
export function createScheduled(
  deps: Partial<Runtime> = {},
): (controller: ScheduledController, env: Env, ctx: ExecutionContext) => Promise<void> {
  const runtime = resolveRuntime(deps);
  return async (_controller, env, ctx) => {
    ctx.waitUntil(
      withOutbox(env, runtime, async (d) => {
        // A failed purge must not stop the retries. The error itself is not logged: it could carry data.
        try {
          const count = await purgeExpired(d.db, d.config.retentionDays, d.now());
          if (count > 0) log('retention.purged', { count });
        } catch {
          log('retention.failed', { error: 'internal' });
        }
        await retryDue(d);
      }).catch(() => {
        log('internal.error', { error: 'internal' });
      }),
    );
  };
}
