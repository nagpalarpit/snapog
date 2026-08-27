// Regression coverage for the tier-spoofing bug fixed in a prior cycle:
// self-serve /register used to trust a client-submitted `tier` form field
// with no payment check, so anyone could POST tier=business and walk away
// with a paid-tier key for free. It's now fixed so /register always issues
// tier=free server-side regardless of what the client submits — these
// tests must never regress that fix.
import { describe, expect, it } from 'vitest';
import { TIER_LIMITS } from '../src/types';
import { env, registerKey, request, sha256Hex } from './helpers';

describe('POST /register — tier safety', () => {
  it('never grants the business tier from a client-submitted tier field', async () => {
    const { rawKey, html } = await registerKey({ tier: 'business' });

    const hash = await sha256Hex(rawKey);
    const row = await env.DB.prepare('SELECT tier, monthly_limit FROM api_keys WHERE key_hash = ?')
      .bind(hash)
      .first<{ tier: string; monthly_limit: number }>();

    expect(row?.tier).toBe('free');
    expect(row?.monthly_limit).toBe(TIER_LIMITS.free);
    expect(html).toContain('API KEY — FREE');
    expect(html).not.toContain('API KEY — BUSINESS');
  });

  it('never grants the pro tier from a client-submitted tier field', async () => {
    const { rawKey, html } = await registerKey({ tier: 'pro' });

    const hash = await sha256Hex(rawKey);
    const row = await env.DB.prepare('SELECT tier, monthly_limit FROM api_keys WHERE key_hash = ?')
      .bind(hash)
      .first<{ tier: string; monthly_limit: number }>();

    expect(row?.tier).toBe('free');
    expect(row?.monthly_limit).toBe(TIER_LIMITS.free);
    expect(html).toContain('API KEY — FREE');
    expect(html).not.toContain('API KEY — PRO');
  });

  it('issues the free tier when no tier field is submitted at all', async () => {
    const { rawKey } = await registerKey();

    const hash = await sha256Hex(rawKey);
    const row = await env.DB.prepare('SELECT tier FROM api_keys WHERE key_hash = ?')
      .bind(hash)
      .first<{ tier: string }>();

    expect(row?.tier).toBe('free');
  });

  it('rejects invalid email addresses with 400', async () => {
    const form = new URLSearchParams();
    form.set('email', 'not-an-email');
    const res = await request('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(400);
  });
});
