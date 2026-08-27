// Shared test helpers for the SnapOG automated test suite.
//
// We call the Worker's `fetch` handler directly (rather than the `SELF`
// service-binding fetcher) and explicitly wait on the per-request
// `ExecutionContext`. That's the pattern Cloudflare's vitest-pool-workers
// docs recommend when a route does `ctx.waitUntil(...)` work (SnapOG's /og
// route writes to R2 and records usage this way) — it guarantees those
// fire-and-forget writes have actually landed before the test's next
// assertion or request runs, so cache/usage tests aren't flaky.
import { createExecutionContext, env as rawEnv, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/types';

export const env = rawEnv as unknown as Env;

export async function request(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request(`https://snapog.test${path}`, init);
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface RegisterResult {
  res: Response;
  html: string;
  email: string;
  rawKey: string;
}

// Drives the real POST /register flow (form-encoded, same as the HTML form)
// and scrapes the plaintext key out of the returned "key created" page —
// that's the only place the raw key is ever shown, since only its hash is
// persisted server-side.
export async function registerKey(
  opts: { email?: string; tier?: string; keyname?: string; ip?: string } = {}
): Promise<RegisterResult> {
  const email = opts.email ?? `test-${crypto.randomUUID()}@snapog.test`;
  const form = new URLSearchParams();
  form.set('email', email);
  if (opts.keyname) form.set('keyname', opts.keyname);
  if (opts.tier) form.set('tier', opts.tier);

  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (opts.ip) headers['CF-Connecting-IP'] = opts.ip;

  const res = await request('/register', {
    method: 'POST',
    headers,
    body: form.toString(),
  });
  const html = await res.text();
  const match = html.match(/id="api-key">(sk_[0-9a-f]+)<\/span>/);
  if (!match) {
    throw new Error(
      `registerKey(): could not extract API key from /register response (status ${res.status}):\n${html.slice(0, 800)}`
    );
  }
  return { res, html, email, rawKey: match[1] };
}
