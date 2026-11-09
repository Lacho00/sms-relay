import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./drizzle');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            INGEST_TOKEN: 'ingest-token-0123456789abcdef0123456789',
            READ_TOKEN: 'read-token-0123456789abcdef01234567890',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup/apply-migrations.ts'],
      coverage: {
        provider: 'istanbul',
        include: ['src/**'],
        exclude: ['src/index.ts'],
        thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
      },
    },
  };
});
