// Coverage for GET /dashboard, including the post-Stripe-redirect case where
// no `key` query param is present (see checkout.test.ts: the raw key is
// deliberately never sent to Stripe, so the redirect back lands here bare).
import { describe, expect, it } from 'vitest';
import { registerKey, request } from './helpers';

describe('GET /dashboard', () => {
  it('400s with a generic prompt when key is missing', async () => {
    const res = await request('/dashboard');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Enter your API key or create a new one below');
  });

  it('400s with a payment-success prompt when redirected back from Stripe without a key', async () => {
    const res = await request('/dashboard?upgraded=1');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Payment successful!');
    expect(html).toContain('Enter your API key below');
  });

  it('404s for an unknown key', async () => {
    const res = await request('/dashboard?key=sk_this_key_does_not_exist_0000');
    expect(res.status).toBe(404);
  });

  it('200s and renders the dashboard for a valid key', async () => {
    const { rawKey } = await registerKey();
    const res = await request(`/dashboard?key=${rawKey}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(rawKey.slice(0, 12));
    expect(html).toContain('Dashboard');
  });
});
