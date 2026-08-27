import { describe, expect, it } from 'vitest';
import { env, registerKey, request, sha256Hex } from './helpers';

describe('GET /og — rate limiting', () => {
  it('returns 429 once usage_count has reached monthly_limit', async () => {
    const { rawKey } = await registerKey();
    const hash = await sha256Hex(rawKey);

    await env.DB.prepare('UPDATE api_keys SET usage_count = monthly_limit WHERE key_hash = ?')
      .bind(hash)
      .run();

    const res = await request(`/og?title=Over+The+Limit&key=${rawKey}`);
    expect(res.status).toBe(429);

    const body = await res.json<{ error: string; tier: string; limit: number; upgrade_url: string }>();
    expect(body.error).toMatch(/limit/i);
    expect(body.tier).toBe('free');
    expect(body.limit).toBe(100);
    expect(body.upgrade_url).toBeTruthy();
  });

  it('returns 429 when usage_count exceeds monthly_limit', async () => {
    const { rawKey } = await registerKey();
    const hash = await sha256Hex(rawKey);

    await env.DB.prepare('UPDATE api_keys SET usage_count = monthly_limit + 5 WHERE key_hash = ?')
      .bind(hash)
      .run();

    const res = await request(`/og?title=Way+Over&key=${rawKey}`);
    expect(res.status).toBe(429);
  });

  it('allows the request through when usage_count is one below monthly_limit', async () => {
    const { rawKey } = await registerKey();
    const hash = await sha256Hex(rawKey);

    await env.DB.prepare('UPDATE api_keys SET usage_count = monthly_limit - 1 WHERE key_hash = ?')
      .bind(hash)
      .run();

    const res = await request(`/og?title=Almost+There&key=${rawKey}`);
    expect(res.status).toBe(200);
  });

  it('increments usage_count on a successful generation', async () => {
    const { rawKey } = await registerKey();
    const hash = await sha256Hex(rawKey);

    const before = await env.DB.prepare('SELECT usage_count FROM api_keys WHERE key_hash = ?')
      .bind(hash)
      .first<{ usage_count: number }>();
    expect(before?.usage_count).toBe(0);

    const res = await request(`/og?title=Count+Me&key=${rawKey}`);
    expect(res.status).toBe(200);

    const after = await env.DB.prepare('SELECT usage_count FROM api_keys WHERE key_hash = ?')
      .bind(hash)
      .first<{ usage_count: number }>();
    expect(after?.usage_count).toBe(1);
  });
});
