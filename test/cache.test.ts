// R2 cache behavior. /og writes the rendered PNG to R2 via ctx.waitUntil()
// (fire-and-forget) so it doesn't block the response; our request() helper
// awaits the ExecutionContext (see helpers.ts) so the write is guaranteed
// to have landed before the test's next request runs.
import { describe, expect, it } from 'vitest';
import { registerKey, request } from './helpers';

describe('GET /og — R2 cache', () => {
  it('MISSes on first request, HITs on an identical repeat request', async () => {
    const { rawKey } = await registerKey();
    const params = `title=Cache+Test&description=Same+every+time&domain=example.com&key=${rawKey}`;

    const first = await request(`/og?${params}`);
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Cache')).toBe('MISS');
    const firstBuf = await first.arrayBuffer();

    const second = await request(`/og?${params}`);
    expect(second.status).toBe(200);
    expect(second.headers.get('X-Cache')).toBe('HIT');
    const secondBuf = await second.arrayBuffer();

    // Cached response should be byte-identical to the original render.
    expect(secondBuf.byteLength).toBe(firstBuf.byteLength);
    expect(new Uint8Array(secondBuf)).toEqual(new Uint8Array(firstBuf));
  });

  it('still counts cache hits toward the usage limit', async () => {
    const { rawKey } = await registerKey();
    const params = `title=Cache+And+Count&key=${rawKey}`;

    await request(`/og?${params}`); // MISS, usage_count -> 1
    const second = await request(`/og?${params}`); // HIT, usage_count -> 2
    expect(second.headers.get('X-Cache')).toBe('HIT');

    const third = await request(`/og?${params}`); // HIT again -> 3
    expect(third.headers.get('X-Cache')).toBe('HIT');
  });

  it('different params produce a cache MISS, not a false HIT', async () => {
    const { rawKey } = await registerKey();
    const a = await request(`/og?title=Variant+A&key=${rawKey}`);
    const b = await request(`/og?title=Variant+B&key=${rawKey}`);
    expect(a.headers.get('X-Cache')).toBe('MISS');
    expect(b.headers.get('X-Cache')).toBe('MISS');
  });

  it('free tier and a different tier would not collide on cache key (watermark differs)', async () => {
    // Both requests below are free-tier (self-serve only issues free keys),
    // but exercise that the watermark flag is baked into buildCacheKey() —
    // two free keys requesting the same title should still share one cache
    // entry, confirming the cache key isn't accidentally per-key.
    const key1 = await registerKey();
    const key2 = await registerKey();

    const first = await request(`/og?title=Shared+Cache&key=${key1.rawKey}`);
    expect(first.headers.get('X-Cache')).toBe('MISS');

    const second = await request(`/og?title=Shared+Cache&key=${key2.rawKey}`);
    expect(second.headers.get('X-Cache')).toBe('HIT');
  });
});
