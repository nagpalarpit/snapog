// Coverage for POST /webhooks/stripe — this is the ONLY code path allowed to
// elevate an api_keys row above `free` (see the tier-spoof regression tests
// in register.test.ts for the other half of that trust boundary). We
// simulate Stripe by computing a real HMAC-SHA256 signature the same way
// Stripe does, using the STRIPE_WEBHOOK_SECRET seeded as a fake test value
// in vitest.config.ts.
import { describe, expect, it } from 'vitest';
import { TIER_LIMITS } from '../src/types';
import { env, registerKey, request, sha256Hex } from './helpers';

const WEBHOOK_SECRET = 'whsec_test_fake_webhook_secret'; // must match vitest.config.ts binding

async function signStripePayload(
  payload: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `t=${timestamp},v1=${hex}`;
}

async function apiKeyIdFor(rawKey: string): Promise<string> {
  const hash = await sha256Hex(rawKey);
  const row = await env.DB.prepare('SELECT id FROM api_keys WHERE key_hash = ?').bind(hash).first<{ id: string }>();
  if (!row) throw new Error('api key row not found');
  return row.id;
}

describe('POST /webhooks/stripe', () => {
  it('400s when the Stripe-Signature header is missing', async () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const res = await request('/webhooks/stripe', { method: 'POST', body: payload });
    expect(res.status).toBe(400);
  });

  it('400s when the signature does not match (wrong secret)', async () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const badSig = await signStripePayload(payload, 'whsec_totally_wrong_secret');
    const res = await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': badSig },
      body: payload,
    });
    expect(res.status).toBe(400);
  });

  it('400s when the signature is malformed', async () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const res = await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': 'not-a-valid-header' },
      body: payload,
    });
    expect(res.status).toBe(400);
  });

  it('upgrades the api_keys row to pro on a verified checkout.session.completed event', async () => {
    const { rawKey } = await registerKey();
    const apiKeyId = await apiKeyIdFor(rawKey);

    const payload = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_test_123',
          subscription: 'sub_test_123',
          metadata: { api_key_id: apiKeyId, tier: 'pro' },
        },
      },
    });
    const sig = await signStripePayload(payload, WEBHOOK_SECRET);

    const res = await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': sig },
      body: payload,
    });
    expect(res.status).toBe(200);

    const updated = await env.DB.prepare(
      `SELECT tier, monthly_limit, stripe_customer_id, stripe_subscription_id, stripe_subscription_status
       FROM api_keys WHERE id = ?`
    )
      .bind(apiKeyId)
      .first<{
        tier: string;
        monthly_limit: number;
        stripe_customer_id: string;
        stripe_subscription_id: string;
        stripe_subscription_status: string;
      }>();

    expect(updated?.tier).toBe('pro');
    expect(updated?.monthly_limit).toBe(TIER_LIMITS.pro);
    expect(updated?.stripe_customer_id).toBe('cus_test_123');
    expect(updated?.stripe_subscription_id).toBe('sub_test_123');
    expect(updated?.stripe_subscription_status).toBe('active');
  });

  it('upgrades to business tier when metadata.tier is business', async () => {
    const { rawKey } = await registerKey();
    const apiKeyId = await apiKeyIdFor(rawKey);

    const payload = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_test_biz',
          subscription: 'sub_test_biz',
          metadata: { api_key_id: apiKeyId, tier: 'business' },
        },
      },
    });
    const sig = await signStripePayload(payload, WEBHOOK_SECRET);

    const res = await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': sig },
      body: payload,
    });
    expect(res.status).toBe(200);

    const updated = await env.DB.prepare('SELECT tier, monthly_limit FROM api_keys WHERE id = ?')
      .bind(apiKeyId)
      .first<{ tier: string; monthly_limit: number }>();
    expect(updated?.tier).toBe('business');
    expect(updated?.monthly_limit).toBe(TIER_LIMITS.business);
  });

  it('downgrades to free on a verified customer.subscription.deleted event', async () => {
    const { rawKey } = await registerKey();
    const apiKeyId = await apiKeyIdFor(rawKey);

    // First upgrade via checkout.session.completed so there's a paid
    // subscription on record to cancel.
    const checkoutPayload = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_test_456',
          subscription: 'sub_test_456',
          metadata: { api_key_id: apiKeyId, tier: 'pro' },
        },
      },
    });
    await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': await signStripePayload(checkoutPayload, WEBHOOK_SECRET) },
      body: checkoutPayload,
    });

    const deletePayload = JSON.stringify({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_test_456', status: 'canceled' } },
    });
    const res = await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': await signStripePayload(deletePayload, WEBHOOK_SECRET) },
      body: deletePayload,
    });
    expect(res.status).toBe(200);

    const updated = await env.DB.prepare(
      'SELECT tier, monthly_limit, stripe_subscription_status FROM api_keys WHERE id = ?'
    )
      .bind(apiKeyId)
      .first<{ tier: string; monthly_limit: number; stripe_subscription_status: string }>();

    expect(updated?.tier).toBe('free');
    expect(updated?.monthly_limit).toBe(TIER_LIMITS.free);
    expect(updated?.stripe_subscription_status).toBe('canceled');
  });

  it('downgrades to free on customer.subscription.updated with status past_due', async () => {
    const { rawKey } = await registerKey();
    const apiKeyId = await apiKeyIdFor(rawKey);

    const checkoutPayload = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_test_789',
          subscription: 'sub_test_789',
          metadata: { api_key_id: apiKeyId, tier: 'pro' },
        },
      },
    });
    await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': await signStripePayload(checkoutPayload, WEBHOOK_SECRET) },
      body: checkoutPayload,
    });

    const updatePayload = JSON.stringify({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_test_789', status: 'past_due' } },
    });
    const res = await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': await signStripePayload(updatePayload, WEBHOOK_SECRET) },
      body: updatePayload,
    });
    expect(res.status).toBe(200);

    const updated = await env.DB.prepare(
      'SELECT tier, stripe_subscription_status FROM api_keys WHERE id = ?'
    )
      .bind(apiKeyId)
      .first<{ tier: string; stripe_subscription_status: string }>();
    expect(updated?.tier).toBe('free');
    expect(updated?.stripe_subscription_status).toBe('past_due');
  });

  it('does not downgrade on customer.subscription.updated with an active status', async () => {
    const { rawKey } = await registerKey();
    const apiKeyId = await apiKeyIdFor(rawKey);

    const checkoutPayload = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_test_active',
          subscription: 'sub_test_active',
          metadata: { api_key_id: apiKeyId, tier: 'pro' },
        },
      },
    });
    await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': await signStripePayload(checkoutPayload, WEBHOOK_SECRET) },
      body: checkoutPayload,
    });

    const updatePayload = JSON.stringify({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_test_active', status: 'active' } },
    });
    const res = await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': await signStripePayload(updatePayload, WEBHOOK_SECRET) },
      body: updatePayload,
    });
    expect(res.status).toBe(200);

    const updated = await env.DB.prepare('SELECT tier FROM api_keys WHERE id = ?')
      .bind(apiKeyId)
      .first<{ tier: string }>();
    expect(updated?.tier).toBe('pro');
  });

  it('400s when the signature timestamp is outside the 5-minute tolerance (replay protection)', async () => {
    const { rawKey } = await registerKey();
    const apiKeyId = await apiKeyIdFor(rawKey);

    const payload = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_test_replay',
          subscription: 'sub_test_replay',
          metadata: { api_key_id: apiKeyId, tier: 'pro' },
        },
      },
    });
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour old
    const sig = await signStripePayload(payload, WEBHOOK_SECRET, staleTimestamp);

    const res = await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': sig },
      body: payload,
    });
    expect(res.status).toBe(400);

    const updated = await env.DB.prepare('SELECT tier FROM api_keys WHERE id = ?')
      .bind(apiKeyId)
      .first<{ tier: string }>();
    expect(updated?.tier).toBe('free');
  });

  it('ignores unrecognized event types but still returns 200', async () => {
    const payload = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
    const res = await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': await signStripePayload(payload, WEBHOOK_SECRET) },
      body: payload,
    });
    expect(res.status).toBe(200);
  });
});
