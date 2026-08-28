// The R2 cache key is content-addressed (see src/og/render.ts buildCacheKey),
// so nothing ever naturally expires it — runCacheSweep is the only thing
// that reaps old entries. See src/lib/cache-sweep.ts for why that's needed
// at all.
//
// Uses list() rather than get() to check whether a key survived: get()
// immediately after a sweep that deletes nothing trips a known
// vitest-pool-workers isolated-storage snapshot issue with the R2 SQLite
// backend (https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage).
// list() checks the same thing without the flake.
import { describe, expect, it } from 'vitest';
import { env } from './helpers';
import { runCacheSweep } from '../src/lib/cache-sweep';

async function exists(key: string): Promise<boolean> {
  const page = await env.OG_CACHE.list({ prefix: key });
  return page.objects.some(obj => obj.key === key);
}

describe('runCacheSweep()', () => {
  it('deletes og/ objects older than the retention window', async () => {
    await env.OG_CACHE.put('og/old-entry.png', new Uint8Array([1, 2, 3]));

    const thirtyOneDaysLater = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const result = await runCacheSweep(env.OG_CACHE, thirtyOneDaysLater, 30);

    expect(result.deleted).toBe(1);
    expect(await exists('og/old-entry.png')).toBe(false);
  });

  it('leaves objects inside the retention window alone', async () => {
    await env.OG_CACHE.put('og/fresh-entry.png', new Uint8Array([4, 5, 6]));

    const result = await runCacheSweep(env.OG_CACHE, new Date(), 30);

    expect(result.deleted).toBe(0);
    expect(await exists('og/fresh-entry.png')).toBe(true);
  });

  it('only touches the og/ prefix', async () => {
    await env.OG_CACHE.put('not-og/unrelated.txt', new Uint8Array([7]));

    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await runCacheSweep(env.OG_CACHE, farFuture, 30);

    expect(await exists('not-og/unrelated.txt')).toBe(true);
  });
});
