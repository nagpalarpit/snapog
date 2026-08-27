// Coverage for the IP-based rate limit on POST /register: without email
// verification (blocked on the same credentialed email-sending capability
// the whole company is waiting on), IP throttling is the only thing
// stopping a script from looping this route to mint unlimited free-tier
// API keys. See migrations/0003_registration_rate_limit.sql and the guard
// clause at the top of app.post('/register', ...) in src/index.ts.
//
// Note: registerKey() (test/helpers.ts) scrapes the raw key out of the
// response HTML and throws if it can't find one — it only works for calls
// expected to succeed. Calls expected to be rejected (429/400) go through
// request() directly so we can assert on the status/body instead.
import { describe, expect, it } from 'vitest';
import { env, registerKey, request } from './helpers';

function registerViaForm(email: string, ip: string) {
  const form = new URLSearchParams();
  form.set('email', email);
  return request('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip },
    body: form.toString(),
  });
}

describe('POST /register — IP rate limiting', () => {
  it('allows registrations up to the limit from the same IP', async () => {
    const ip = `1.2.3.${crypto.randomUUID().slice(0, 4)}`;
    for (let i = 0; i < 5; i++) {
      const { res } = await registerKey({ ip });
      expect(res.status).toBe(200);
    }
  });

  it('rejects the request that exceeds the limit with a 429', async () => {
    const ip = `5.6.7.${crypto.randomUUID().slice(0, 4)}`;
    for (let i = 0; i < 5; i++) {
      const { res } = await registerKey({ ip });
      expect(res.status).toBe(200);
    }

    const res = await registerViaForm(`overflow-${crypto.randomUUID()}@snapog.test`, ip);
    expect(res.status).toBe(429);
    const html = await res.text();
    expect(html).toMatch(/too many/i);
  });

  it('does not let a cheap validation failure dodge the limit', async () => {
    const ip = `9.9.9.${crypto.randomUUID().slice(0, 4)}`;
    // Trip 5 attempts with an invalid email — each still counts against the limit.
    for (let i = 0; i < 5; i++) {
      const res = await registerViaForm('not-an-email', ip);
      expect(res.status).toBe(400);
    }

    // 6th attempt, even with a valid email, is over the limit.
    const res = await registerViaForm(`should-be-blocked-${crypto.randomUUID()}@snapog.test`, ip);
    expect(res.status).toBe(429);
  });

  it('does not let one IP exhausting its limit affect a different IP', async () => {
    const ipA = `10.0.0.${crypto.randomUUID().slice(0, 4)}`;
    const ipB = `10.0.1.${crypto.randomUUID().slice(0, 4)}`;

    for (let i = 0; i < 5; i++) {
      const { res } = await registerKey({ ip: ipA });
      expect(res.status).toBe(200);
    }
    // ipA is now over the limit...
    const overLimit = await registerViaForm(`blocked-${crypto.randomUUID()}@snapog.test`, ipA);
    expect(overLimit.status).toBe(429);

    // ...but ipB has made no attempts yet and should sail through.
    const { res } = await registerKey({ ip: ipB });
    expect(res.status).toBe(200);
  });

  it('does not crash when CF-Connecting-IP is absent (falls back to a shared bucket)', async () => {
    const { res } = await registerKey();
    expect(res.status).toBe(200);
  });

  it('allows exactly 5 successes under truly concurrent requests from one IP, not more', async () => {
    // The old implementation did a separate INSERT then SELECT COUNT, which
    // raced under concurrency: simultaneous requests could all read the
    // count before any of their inserts committed, letting more than 5
    // through. Firing 10 requests via Promise.all (rather than the
    // sequential loops the other tests use) is what actually exercises that
    // failure mode — the atomic INSERT...SELECT...WHERE must serialize them.
    const ip = `203.0.113.${crypto.randomUUID().slice(0, 4)}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => registerViaForm(`concurrent-${crypto.randomUUID()}@snapog.test`, ip))
    );
    const succeeded = results.filter(res => res.status === 200);
    const limited = results.filter(res => res.status === 429);
    expect(succeeded.length).toBe(5);
    expect(limited.length).toBe(5);
  });

  it('prunes attempts older than 24 hours as a side effect of the next registration', async () => {
    const staleIp = `172.16.0.${crypto.randomUUID().slice(0, 4)}`;
    await env.DB
      .prepare(
        `INSERT INTO registration_attempts (id, ip, created_at)
         VALUES (?, ?, datetime('now', '-25 hours'))`
      )
      .bind(crypto.randomUUID(), staleIp)
      .run();

    // Any registration triggers the batched housekeeping DELETE, regardless
    // of which IP it comes from.
    const { res } = await registerKey({ ip: `172.16.1.${crypto.randomUUID().slice(0, 4)}` });
    expect(res.status).toBe(200);

    const remaining = await env.DB
      .prepare('SELECT COUNT(*) as count FROM registration_attempts WHERE ip = ?')
      .bind(staleIp)
      .first<{ count: number }>();
    expect(remaining?.count ?? 0).toBe(0);
  });
});
