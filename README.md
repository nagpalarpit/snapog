# SnapOG

Generate stunning Open Graph images via API — self-hosted on your own Cloudflare account, cached globally on R2, sub-100ms on cache hit.

[![CI](https://github.com/nagpalarpit/snapog/actions/workflows/ci.yml/badge.svg)](https://github.com/nagpalarpit/snapog/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/nagpalarpit/snapog)](https://github.com/nagpalarpit/snapog/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nagpalarpit/snapog)

This is a self-hosted product: you deploy it to your own Cloudflare account (free tier is enough to start) and it's entirely yours — your data, your usage limits, no third party in the request path.

## Quick Start

```bash
# After deploying (see below), register a key on your own instance:
curl -X POST https://your-worker.your-subdomain.workers.dev/register

# Then generate an image:
curl "https://your-worker.your-subdomain.workers.dev/og?title=My+Blog+Post&domain=myblog.com&key=sk_YOUR_KEY" \
  --output og.png && open og.png
```

## API

```
GET /og
  ?title=Your Page Title     # required, max 120 chars
  &key=sk_your_key           # required
  &description=Subtitle      # optional, max 200 chars
  &domain=yourdomain.com     # optional
  &author=Jane Doe           # optional
  &tag=Tutorial              # optional, shown as pill badge
  &template=default          # default | blog | article
  &theme=dark                # dark | light
```

Returns `image/png`, 1200×630.

Headers:
- `X-Cache: HIT|MISS` — whether served from R2 cache
- `X-SnapOG-Tier: free|pro|business`

## HTML Integration

```html
<meta property="og:image"
      content="https://your-worker.your-subdomain.workers.dev/og?title=YOUR_TITLE&key=YOUR_KEY" />
<meta property="og:image:width"  content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card"   content="summary_large_image" />
<meta name="twitter:image"  content="https://your-worker.your-subdomain.workers.dev/og?title=YOUR_TITLE&key=YOUR_KEY" />
```

## Built-in tiers

The code ships with a free/pro/business tier model (rate limits, watermarking) already wired up — useful if you want to run this for a team or resell it. Stripe Checkout code is included but inert until you configure your own Stripe keys (see `wrangler.toml`). If you're self-hosting just for yourself, the free tier's limits are enforced per API key, not per deployment, so you can raise them by editing `src/types.ts`.

## Local Development

### Prerequisites
- Node.js 18+, npm
- Wrangler (`npm install -g wrangler`)
- A Cloudflare account with Workers access

### Setup

```bash
git clone https://github.com/nagpalarpit/snapog.git
cd snapog
npm install

# 1. Create D1 database
wrangler d1 create snapog-db
# Copy the returned database_id into wrangler.toml [d1_databases]

# 2. Apply migrations locally
npm run db:local

# 3. Start dev server
npm run dev
```

Open http://127.0.0.1:8787

### Test

```bash
# Register a key via browser at http://127.0.0.1:8787/register
# Then test with:
API_KEY=sk_your_key bash sample/smoke-test.sh

# Or direct curl:
curl "http://127.0.0.1:8787/og?title=Hello+World&key=sk_your_key" --output og.png
```

### Typecheck

```bash
npm run typecheck
```

## Deployment

The one-click button above handles this for you. To deploy manually instead:

```bash
# 1. Create remote D1 database
wrangler d1 create snapog-db
# Update wrangler.toml with the database_id

# 2. Apply migrations to remote
npm run db:remote

# 3. Create R2 bucket
wrangler r2 bucket create snapog-og-cache

# 4. Deploy
wrangler deploy
```

## Tech Stack

- [Cloudflare Workers](https://workers.cloudflare.com/) — edge compute
- [Hono](https://hono.dev/) — HTTP framework
- [workers-og](https://github.com/nicholasgasior/workers-og) — OG image generation (Satori-based)
- [Cloudflare D1](https://developers.cloudflare.com/d1/) — SQLite for usage tracking
- [Cloudflare R2](https://developers.cloudflare.com/r2/) — image cache storage

## License

MIT
