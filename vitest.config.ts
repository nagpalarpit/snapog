import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            // Make migrations available to the setup file via a test-only binding.
            // Also seed fake Stripe env vars so /checkout and /webhooks/stripe
            // are exercisable in tests without real Cloudflare secrets — the
            // webhook tests compute real HMAC signatures against
            // STRIPE_WEBHOOK_SECRET below to simulate Stripe.
            bindings: {
              TEST_MIGRATIONS: migrations,
              STRIPE_SECRET_KEY: 'sk_test_fake_secret_key',
              STRIPE_WEBHOOK_SECRET: 'whsec_test_fake_webhook_secret',
              STRIPE_PRICE_ID_PRO: 'price_test_pro_123',
              STRIPE_PRICE_ID_BUSINESS: 'price_test_business_456',
            },
          },
        },
      },
    },
  };
});
