// SnapOG — Main Cloudflare Worker
// Routes: GET /og (image gen), GET / (landing), GET/POST /register, GET /dashboard

import { Hono } from 'hono';
import { generateOGImage, buildCacheKey } from './og/render';
import {
  landingPage,
  registerPage,
  keyCreatedPage,
  dashboardPage,
  errorPage,
} from './dashboard/pages';
import type { ApiKey, Env, OGParams, Tier } from './types';
import { TIER_LIMITS } from './types';

const app = new Hono<{ Bindings: Env }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateRawKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'sk_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ─── Stripe helpers ─────────────────────────────────────────────────────────
// No `stripe` npm package here on purpose — it assumes Node streams/http
// that don't run on Workers. We talk to Stripe's REST API with plain fetch
// and verify webhook signatures ourselves with Web Crypto.

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Not a realistic timing-attack surface here, but comparing in constant time
// is free and avoids leaving an easy footgun for later reuse elsewhere.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Verifies a Stripe `Stripe-Signature` header of the form
// `t=<timestamp>,v1=<hex_hmac>[,v1=<hex_hmac>...]` against the raw request
// body. Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 using the
// webhook signing secret; we recompute it and compare.
async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!sigHeader) return false;

  let timestamp: string | undefined;
  const candidateSignatures: string[] = [];
  for (const part of sigHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1') candidateSignatures.push(v);
  }
  if (!timestamp || candidateSignatures.length === 0) return false;

  // Reject stale signatures so a captured valid payload can't be replayed
  // indefinitely to re-grant a tier after cancellation. 5 minutes matches
  // the Stripe SDK's default tolerance.
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > 300) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return candidateSignatures.some(sig => timingSafeEqualHex(expected, sig));
}

interface StripeCheckoutSession {
  url?: string;
  id?: string;
}

// Minimal shape of the Stripe event payloads we actually read fields from.
interface StripeWebhookEvent {
  type?: string;
  data?: {
    object?: {
      id?: string;
      customer?: string;
      subscription?: string;
      status?: string;
      metadata?: Record<string, string>;
    };
  };
}

// Validate an API key from request and return the DB row, or null
async function resolveApiKey(
  db: D1Database,
  rawKey: string | null
): Promise<ApiKey | null> {
  if (!rawKey) return null;
  const hash = await sha256(rawKey);
  const row = await db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
    .bind(hash)
    .first<ApiKey>();
  return row ?? null;
}

// Reset monthly usage if billing month rolled over
async function maybeResetUsage(db: D1Database, key: ApiKey): Promise<ApiKey> {
  const resetAt = new Date(key.usage_reset_at);
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  if (resetAt < thisMonth) {
    const newResetAt = thisMonth.toISOString();
    await db
      .prepare(
        'UPDATE api_keys SET usage_count = 0, usage_reset_at = ? WHERE id = ?'
      )
      .bind(newResetAt, key.id)
      .run();
    return { ...key, usage_count: 0, usage_reset_at: newResetAt };
  }
  return key;
}

// Increment usage counter and record event
async function recordUsage(
  db: D1Database,
  key: ApiKey,
  template: string,
  cacheHit: boolean
): Promise<void> {
  const eventId = crypto.randomUUID();
  await db.batch([
    db
      .prepare('UPDATE api_keys SET usage_count = usage_count + 1 WHERE id = ?')
      .bind(key.id),
    db
      .prepare(
        'INSERT INTO usage_events (id, api_key_id, template, cache_hit) VALUES (?, ?, ?, ?)'
      )
      .bind(eventId, key.id, template, cacheHit ? 1 : 0),
  ]);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Landing page
app.get('/', c => {
  const host = new URL(c.req.url).host;
  return htmlResponse(landingPage(host));
});

// ── OG image generation ────────────────────────────────────────────────────────
app.get('/og', async c => {
  const q = c.req.query();
  const rawKey = q['key'] ?? null;

  // Validate required param
  const title = (q['title'] ?? '').trim().slice(0, 120);
  if (!title) {
    return c.json({ error: 'title parameter is required' }, 400);
  }

  // Resolve API key (required)
  if (!rawKey) {
    return c.json({ error: 'key parameter is required. Get a free key at /register' }, 401);
  }
  let apiKey = await resolveApiKey(c.env.DB, rawKey);
  if (!apiKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  // Reset usage if month rolled
  apiKey = await maybeResetUsage(c.env.DB, apiKey);

  // Check rate limit
  if (apiKey.usage_count >= apiKey.monthly_limit) {
    return c.json(
      {
        error: 'Monthly image limit reached',
        tier: apiKey.tier,
        limit: apiKey.monthly_limit,
        upgrade_url: '/register?tier=pro',
      },
      429
    );
  }

  const params: OGParams = {
    title,
    description: (q['description'] ?? '').trim().slice(0, 200) || undefined,
    domain: (q['domain'] ?? '').trim().slice(0, 100) || undefined,
    author: (q['author'] ?? '').trim().slice(0, 80) || undefined,
    tag: (q['tag'] ?? '').trim().slice(0, 40) || undefined,
    theme: (q['theme'] === 'light' ? 'light' : 'dark') as 'dark' | 'light',
    template: (['blog', 'article'].includes(q['template'] ?? '')
      ? q['template']
      : 'default') as OGParams['template'],
  };

  const watermark = apiKey.tier === 'free';
  const cacheKey = await buildCacheKey(params, watermark);
  const r2Key = `og/${cacheKey}.png`;

  // ── R2 cache lookup ──
  const cached = await c.env.OG_CACHE.get(r2Key);
  if (cached) {
    // Cache hit — return stored PNG, still track usage (counts toward limit)
    await recordUsage(c.env.DB, apiKey, params.template ?? 'default', true);
    const imageData = await cached.arrayBuffer();
    return new Response(imageData, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
        'X-Cache': 'HIT',
        'X-SnapOG-Tier': apiKey.tier,
      },
    });
  }

  // ── Generate image ──
  const imageResponse = await generateOGImage(params, watermark);
  const imageBuffer = await imageResponse.arrayBuffer();

  // Store in R2 (fire-and-forget, don't block response)
  c.executionCtx.waitUntil(
    c.env.OG_CACHE.put(r2Key, imageBuffer.slice(0), {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { tier: apiKey.tier, template: params.template ?? 'default' },
    })
  );

  // Record usage (also fire-and-forget after we have the image)
  c.executionCtx.waitUntil(
    recordUsage(c.env.DB, apiKey, params.template ?? 'default', false)
  );

  return new Response(imageBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      'X-Cache': 'MISS',
      'X-SnapOG-Tier': apiKey.tier,
    },
  });
});

// ── Registration ──────────────────────────────────────────────────────────────
app.get('/register', c => {
  const tier = c.req.query('tier');
  return htmlResponse(registerPage(undefined, tier));
});

app.post('/register', async c => {
  // No email verification exists on this route (blocked on the same
  // credentialed email-sending capability the whole company is currently
  // waiting on to provision), so IP-based throttling is the only thing
  // stopping a script from looping this endpoint to mint unlimited
  // free-tier keys (100 images/month each) at zero cost. CF-Connecting-IP
  // is the real client IP on Cloudflare Workers; it's absent under
  // local/test conditions, where everything falls into one 'unknown'
  // bucket — tests must set the header explicitly to exercise per-IP
  // isolation.
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';

  // 5 registrations/hour/IP: generous for a real person signing up a
  // couple of keys, punishing for a throwaway-email loop.
  const REGISTER_RATE_LIMIT = 5;

  // Recording the attempt and checking the limit used to be two separate
  // round trips (INSERT then SELECT COUNT), which raced: two concurrent
  // requests from the same IP could both insert, then both count before
  // either commit was visible to the other, letting a couple of requests
  // squeeze past the limit at the boundary. A single INSERT...SELECT...WHERE
  // statement is atomic in SQLite, so the count check and the insert that
  // makes it count both happen as one indivisible step — no window for a
  // second request to sneak in between them. Batching a housekeeping DELETE
  // alongside it (same D1 round trip) keeps this table from growing
  // unbounded, since nothing else ever prunes it.
  const [, insertResult] = await c.env.DB.batch([
    c.env.DB
      .prepare(`DELETE FROM registration_attempts WHERE created_at < datetime('now', '-24 hours')`),
    c.env.DB
      .prepare(
        `INSERT INTO registration_attempts (id, ip)
         SELECT ?, ? WHERE (
           SELECT COUNT(*) FROM registration_attempts
           WHERE ip = ? AND created_at >= datetime('now', '-1 hours')
         ) < ?`
      )
      .bind(crypto.randomUUID(), ip, ip, REGISTER_RATE_LIMIT),
  ]);
  if (insertResult.meta.changes === 0) {
    return htmlResponse(
      registerPage('Too many registration attempts from your network. Please try again in a bit.'),
      429
    );
  }

  let email: string, keyname: string, tier: string;
  try {
    const form = await c.req.formData();
    email = (form.get('email') as string ?? '').trim().toLowerCase();
    keyname = (form.get('keyname') as string ?? '').trim() || 'default';
    tier = (form.get('tier') as string ?? 'free').trim();
  } catch {
    return htmlResponse(registerPage('Invalid form data'), 400);
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return htmlResponse(registerPage('Please enter a valid email address', tier), 400);
  }

  // Self-serve signup only ever grants the free tier — pro/business require
  // a paid checkout flow (not yet implemented) before elevated limits apply.
  // The submitted `tier` value is display-only (pre-fills which plan the
  // visitor intended to buy) and must never be trusted for entitlement.
  void tier;
  const safeTier: Tier = 'free';

  // Upsert user
  const userId = crypto.randomUUID();
  await c.env.DB
    .prepare(
      'INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING'
    )
    .bind(userId, email)
    .run();

  const user = await c.env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (!user) {
    return htmlResponse(registerPage('Database error — please try again'), 500);
  }

  // Generate API key
  const rawKey = generateRawKey();
  const keyHash = await sha256(rawKey);
  const keyPrefix = rawKey.slice(0, 12);
  const keyId = crypto.randomUUID();
  const resetAt = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const monthlyLimit = TIER_LIMITS[safeTier];

  await c.env.DB
    .prepare(
      `INSERT INTO api_keys
         (id, user_id, name, key_prefix, key_hash, tier, monthly_limit, usage_reset_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(keyId, user.id, keyname, keyPrefix, keyHash, safeTier, monthlyLimit, resetAt)
    .run();

  return htmlResponse(keyCreatedPage(rawKey, email, safeTier));
});

// ── Stripe Checkout ───────────────────────────────────────────────────────────
// The only way to elevate an api_keys row above `free` is this route creating
// a Checkout Session and the `/webhooks/stripe` handler below confirming
// payment via a signature-verified webhook. There is no code path where a
// client-supplied value directly sets `tier`.
app.get('/checkout', async c => {
  const tier = c.req.query('tier');
  if (tier !== 'pro' && tier !== 'business') {
    return c.json({ error: 'tier parameter must be "pro" or "business"' }, 400);
  }

  const rawKey = c.req.query('key');
  if (!rawKey) {
    return c.json(
      { error: 'key parameter is required, register for a free key first at /register' },
      400
    );
  }

  const apiKey = await resolveApiKey(c.env.DB, rawKey);
  if (!apiKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const priceId = tier === 'pro' ? c.env.STRIPE_PRICE_ID_PRO : c.env.STRIPE_PRICE_ID_BUSINESS;
  const secretKey = c.env.STRIPE_SECRET_KEY;
  if (!priceId || !secretKey) {
    console.error(`Stripe checkout misconfigured: missing price id or secret key for tier=${tier}`);
    return c.json({ error: 'Checkout is temporarily unavailable' }, 502);
  }

  // Deliberately not embedding rawKey here: these URLs are handed to Stripe
  // and persisted on the Checkout Session in Stripe's own dashboard/logs, a
  // third party our own key never otherwise reaches. The user already has
  // the key (they supplied it to start checkout), so /dashboard's existing
  // "enter your key" prompt covers the post-redirect case.
  const host = new URL(c.req.url).host;
  const successUrl = `https://${host}/dashboard?upgraded=1`;
  const cancelUrl = `https://${host}/dashboard`;

  const body = new URLSearchParams();
  body.set('mode', 'subscription');
  body.set('line_items[0][price]', priceId);
  body.set('line_items[0][quantity]', '1');
  body.set('success_url', successUrl);
  body.set('cancel_url', cancelUrl);
  body.set('client_reference_id', apiKey.id);
  body.set('metadata[tier]', tier);
  body.set('metadata[api_key_id]', apiKey.id);
  if (apiKey.stripe_customer_id) {
    body.set('customer', apiKey.stripe_customer_id);
  }

  let stripeRes: Response;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (err) {
    console.error('Stripe checkout session request threw:', err);
    return c.json({ error: 'Checkout is temporarily unavailable' }, 502);
  }

  if (!stripeRes.ok) {
    const errText = await stripeRes.text();
    console.error(`Stripe checkout session creation failed (${stripeRes.status}):`, errText);
    return c.json({ error: 'Checkout is temporarily unavailable' }, 502);
  }

  const session = await stripeRes.json<StripeCheckoutSession>();
  if (!session.url) {
    console.error('Stripe checkout session response missing url field:', JSON.stringify(session));
    return c.json({ error: 'Checkout is temporarily unavailable' }, 502);
  }

  return c.redirect(session.url, 302);
});

// ── Stripe webhook ────────────────────────────────────────────────────────────
app.post('/webhooks/stripe', async c => {
  const sigHeader = c.req.header('Stripe-Signature') ?? null;
  const rawBody = await c.req.text();

  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET is not configured; rejecting webhook');
    return c.json({ error: 'Webhook not configured' }, 400);
  }

  const validSignature = await verifyStripeSignature(rawBody, sigHeader, secret);
  if (!validSignature) {
    return c.json({ error: 'Invalid signature' }, 400);
  }

  let event: StripeWebhookEvent;
  try {
    event = JSON.parse(rawBody) as StripeWebhookEvent;
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  const type = event.type;
  const obj = event.data?.object ?? {};

  try {
    if (type === 'checkout.session.completed') {
      const apiKeyId = obj.metadata?.['api_key_id'];
      const tier = obj.metadata?.['tier'];
      const customerId = obj.customer ?? null;
      const subscriptionId = obj.subscription ?? null;

      if (apiKeyId && (tier === 'pro' || tier === 'business')) {
        await c.env.DB
          .prepare(
            `UPDATE api_keys
               SET tier = ?,
                   monthly_limit = ?,
                   stripe_customer_id = ?,
                   stripe_subscription_id = ?,
                   stripe_subscription_status = 'active'
             WHERE id = ?`
          )
          .bind(tier, TIER_LIMITS[tier as Tier], customerId, subscriptionId, apiKeyId)
          .run();
      } else {
        console.error(
          'checkout.session.completed missing/invalid metadata:',
          JSON.stringify(obj.metadata ?? {})
        );
      }
    } else if (
      type === 'customer.subscription.deleted' ||
      (type === 'customer.subscription.updated' &&
        ['canceled', 'unpaid', 'past_due'].includes(obj.status ?? ''))
    ) {
      const subscriptionId = obj.id;
      const status = type === 'customer.subscription.deleted' ? 'canceled' : (obj.status ?? 'canceled');
      if (subscriptionId) {
        await c.env.DB
          .prepare(
            `UPDATE api_keys
               SET tier = 'free',
                   monthly_limit = ?,
                   stripe_subscription_status = ?
             WHERE stripe_subscription_id = ?`
          )
          .bind(TIER_LIMITS.free, status, subscriptionId)
          .run();
      }
    }
    // All other event types are intentionally ignored — still 200 so Stripe
    // doesn't treat them as failed deliveries and keep retrying.
  } catch (err) {
    // Log for manual reconciliation, but still 200: Stripe retries failed
    // webhooks aggressively and a bug on our side shouldn't cause a retry
    // storm. This event's effects can be replayed manually from the Stripe
    // dashboard if needed.
    console.error('Error processing Stripe webhook event:', type, err);
  }

  return c.json({ received: true });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/dashboard', async c => {
  const rawKey = c.req.query('key');
  if (!rawKey) {
    const message = c.req.query('upgraded')
      ? 'Payment successful! Enter your API key below to view your updated dashboard.'
      : 'Enter your API key or create a new one below';
    return htmlResponse(registerPage(message), 400);
  }

  const apiKey = await resolveApiKey(c.env.DB, rawKey);
  if (!apiKey) {
    return htmlResponse(errorPage(404, 'API key not found'), 404);
  }

  const refreshed = await maybeResetUsage(c.env.DB, apiKey);

  // Count recent events (last 24h)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const recent = await c.env.DB
    .prepare(
      'SELECT COUNT(*) as cnt FROM usage_events WHERE api_key_id = ? AND generated_at > ?'
    )
    .bind(refreshed.id, yesterday)
    .first<{ cnt: number }>();

  return htmlResponse(dashboardPage(refreshed, recent?.cnt ?? 0, rawKey));
});

// ── Health / ops ──────────────────────────────────────────────────────────────
app.get('/health', c => c.json({ ok: true, ts: new Date().toISOString() }));

// 404 fallback
app.notFound(_c => htmlResponse(errorPage(404, 'Page not found'), 404));
app.onError((err, _c) => {
  console.error('Unhandled error:', err);
  return htmlResponse(errorPage(500, 'Internal server error'), 500);
});

export default app;
