import { createApp } from './app';

const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // No-op until the delivery task lands.
  },
} satisfies ExportedHandler<Env>;
