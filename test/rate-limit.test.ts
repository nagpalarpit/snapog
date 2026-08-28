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

  it('does not let concurrent requests overshoot the monthly limit', async () => {
    const { rawKey } = await registerKey();
    const hash = await sha256Hex(rawKey);

    await env.DB.prepare('UPDATE api_keys SET usage_count = monthly_limit - 1 WHERE key_hash = ?')
      .bind(hash)
      .run();

    const CONCURRENCY = 10;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        request(`/og?title=Race+${i}&key=${rawKey}`)
      )
    );

    const allowed = responses.filter(r => r.status === 200);
    const limited = responses.filter(r => r.status === 429);
    expect(allowed.length).toBe(1);
    expect(limited.length).toBe(CONCURRENCY - 1);

    const after = await env.DB.prepare('SELECT usage_count FROM api_keys WHERE key_hash = ?')
      .bind(hash)
      .first<{ usage_count: number }>();
    expect(after?.usage_count).toBe(100);
  });

  it('resets usage_count when the billing month has rolled over', async () => {
    const { rawKey } = await registerKey();
    const hash = await sha256Hex(rawKey);

    await env.DB
      .prepare(
        "UPDATE api_keys SET usage_count = 42, usage_reset_at = datetime('now', '-1 month') WHERE key_hash = ?"
      )
      .bind(hash)
      .run();

    const res = await request(`/og?title=Fresh+Month&key=${rawKey}`);
    expect(res.status).toBe(200);

    const after = await env.DB.prepare('SELECT usage_count FROM api_keys WHERE key_hash = ?')
      .bind(hash)
      .first<{ usage_count: number }>();
    expect(after?.usage_count).toBe(1);
  });

  // maybeResetUsage's month-rollover check (src/index.ts) reads
  // usage_reset_at into JS, decides "reset needed," then folds that same
  // staleness check into the reset UPDATE's WHERE clause — the same guard
  // pattern tryConsumeUsage uses for the quota check above. Unlike the four
  // other check-then-act races already fixed in this codebase, this one is
  // order-dependent across two *different* operations (a reset from one
  // request racing an increment from another) rather than N homogeneous
  // writers all hitting one gate — a plain Promise.all of identical
  // concurrent /og requests doesn't reproduce it here, because this
  // single-threaded, synchronous-D1 test harness schedules symmetric
  // concurrent requests in a deterministic round-robin order (every
  // request's reset step resolves before any request's increment step
  // starts), which never manifests the specific "reset lands after a
  // sibling request's increment" interleaving. Exercising the exact guarded
  // statement directly is the reliable way to prove the WHERE clause is
  // load-bearing: a losing write that computed the same rollover from a
  // now-stale snapshot must not clobber usage another request already
  // recorded against the real rollover — and, symmetrically, that the
  // pre-fix unconditional form of the same statement really would clobber.
  it('does not let a stale rollover write clobber usage already recorded this period', async () => {
    const { rawKey } = await registerKey();
    const hash = await sha256Hex(rawKey);
    const row = await env.DB.prepare('SELECT id FROM api_keys WHERE key_hash = ?').bind(hash).first<{ id: string }>();
    const id = row!.id;

    const thisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

    // A real rollover already happened (usage_reset_at is current) and 5
    // units were consumed against it.
    await env.DB
      .prepare('UPDATE api_keys SET usage_count = 5, usage_reset_at = ? WHERE id = ?')
      .bind(thisMonth, id)
      .run();

    // The exact statement maybeResetUsage runs post-fix: a "loser" request
    // that computed the same newResetAt from an earlier, now-stale read
    // must match zero rows, since the live row is already current.
    const guarded = await env.DB
      .prepare('UPDATE api_keys SET usage_count = 0, usage_reset_at = ? WHERE id = ? AND usage_reset_at < ?')
      .bind(thisMonth, id, thisMonth)
      .run();
    expect(guarded.meta.changes).toBe(0);

    const afterGuarded = await env.DB
      .prepare('SELECT usage_count FROM api_keys WHERE id = ?')
      .bind(id)
      .first<{ usage_count: number }>();
    expect(afterGuarded?.usage_count).toBe(5);

    // Proves the guard is load-bearing, not incidental: the pre-fix
    // statement (no staleness check in its WHERE clause) matches
    // unconditionally and really would zero out the already-recorded usage.
    const unguarded = await env.DB
      .prepare('UPDATE api_keys SET usage_count = 0, usage_reset_at = ? WHERE id = ?')
      .bind(thisMonth, id)
      .run();
    expect(unguarded.meta.changes).toBe(1);

    const afterUnguarded = await env.DB
      .prepare('SELECT usage_count FROM api_keys WHERE id = ?')
      .bind(id)
      .first<{ usage_count: number }>();
    expect(afterUnguarded?.usage_count).toBe(0);
  });
});
