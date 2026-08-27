// Coverage for GET /checkout — the Stripe Checkout Session creation route.
// We never let this route touch a real Stripe account: `fetch` is mocked so
// tests exercise our request-building/validation logic and response
// handling without needing network access or real Stripe credentials.
// STRIPE_SECRET_KEY / STRIPE_PRICE_ID_PRO / STRIPE_PRICE_ID_BUSINESS are
// seeded as fake test values in vitest.config.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKey, request } from './helpers';

describe('GET /checkout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('400s when the key parameter is missing', async () => {
    const res = await request('/checkout?tier=pro');
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/key/i);
  });

  it('400s when the tier parameter is missing', async () => {
    const { rawKey } = await registerKey();
    const res = await request(`/checkout?key=${rawKey}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/tier/i);
  });

  it('400s when the tier parameter is invalid', async () => {
    const { rawKey } = await registerKey();
    const res = await request(`/checkout?tier=enterprise&key=${rawKey}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/tier/i);
  });

  it('401s when the key is invalid', async () => {
    const res = await request('/checkout?tier=pro&key=sk_this_key_does_not_exist_0000');
    expect(res.status).toBe(401);
  });

  it('creates a Stripe Checkout Session and 302-redirects to it', async () => {
    const { rawKey } = await registerKey();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
      expect(init?.method).toBe('POST');

      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk_test_fake_secret_key');
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const params = new URLSearchParams(init?.body as string);
      expect(params.get('mode')).toBe('subscription');
      expect(params.get('line_items[0][price]')).toBe('price_test_pro_123');
      expect(params.get('line_items[0][quantity]')).toBe('1');
      expect(params.get('metadata[tier]')).toBe('pro');
      expect(params.get('metadata[api_key_id]')).toBeTruthy();
      expect(params.get('client_reference_id')).toBeTruthy();
      // The raw key must never be handed to Stripe: success/cancel URLs are
      // persisted on the Checkout Session in Stripe's own dashboard/logs, a
      // third party our own key otherwise never reaches.
      expect(params.get('success_url')).not.toContain(rawKey);
      expect(params.get('success_url')).toContain('upgraded=1');
      expect(params.get('cancel_url')).not.toContain(rawKey);
      // No pre-existing stripe_customer_id on a fresh free key.
      expect(params.get('customer')).toBeNull();

      return new Response(
        JSON.stringify({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/test_session_123' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const res = await request(`/checkout?tier=pro&key=${rawKey}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/test_session_123');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('builds the same session shape for the business tier', async () => {
    const { rawKey } = await registerKey();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const params = new URLSearchParams(init?.body as string);
      expect(params.get('line_items[0][price]')).toBe('price_test_business_456');
      expect(params.get('metadata[tier]')).toBe('business');
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/biz_session' }), {
        status: 200,
      });
    });

    const res = await request(`/checkout?tier=business&key=${rawKey}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/biz_session');
  });

  it('returns a generic 502 (no leaked Stripe details) when Stripe responds with an error', async () => {
    const { rawKey } = await registerKey();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'No such price: price_test_pro_123', type: 'invalid_request_error' } }), {
        status: 400,
      })
    );

    const res = await request(`/checkout?tier=pro&key=${rawKey}`);
    expect(res.status).toBe(502);
    const body = await res.json<{ error: string }>();
    expect(body.error).not.toMatch(/price_test_pro_123/);
    expect(body.error).not.toMatch(/invalid_request_error/);
  });

  it('returns 502 when the Stripe response has no url field', async () => {
    const { rawKey } = await registerKey();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'cs_test_no_url' }), { status: 200 })
    );

    const res = await request(`/checkout?tier=pro&key=${rawKey}`);
    expect(res.status).toBe(502);
  });
});
