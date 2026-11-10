import { createApp, createScheduled } from './app';

const app = createApp();
const scheduled = createScheduled();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled,
} satisfies ExportedHandler<Env>;
