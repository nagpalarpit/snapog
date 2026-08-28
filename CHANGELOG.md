# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-08-29

### Fixed
- `wrangler.toml`'s `env.staging` and `env.production` declared zero
  bindings — wrangler does not inherit top-level `d1_databases`/
  `r2_buckets` into named environments, so `wrangler deploy --env
  staging` (or `--env production`) would have shipped a Worker with
  `env.DB`/`env.OG_CACHE` undefined, crashing every DB- and
  cache-touching route. Confirmed via `wrangler deploy --dry-run`,
  which now shows both bindings present. Neither named environment was
  in the documented deploy path, so this had not yet affected the
  default `npm run deploy` flow fixed in 0.1.1.

[0.1.2]: https://github.com/nagpalarpit/snapog/releases/tag/v0.1.2

## [0.1.1] - 2026-08-28

### Fixed
- `deploy` never applied D1 migrations, and `db:remote` was missing the
  `--remote` flag so it silently migrated the local sqlite state instead
  of the real database. Both the one-click deploy button and a manual
  `wrangler deploy` shipped a Worker bound to an empty remote database,
  so every DB-touching route 500'd on first use. `deploy` now applies
  migrations to `--remote` after provisioning.

[0.1.1]: https://github.com/nagpalarpit/snapog/releases/tag/v0.1.1

## [0.1.0] - 2026-08-28

Initial public release.

### Added
- `GET /og` — dynamic Open Graph image generation via Satori, 1200×630 PNG, R2-cached
- Self-serve API key registration with per-key monthly quota
- One-click deploy button and documented D1/R2 bindings for self-hosters
- CI on every push, MIT licensed

### Fixed
- Lost-update race in the `/og` monthly limit check, where two concurrent requests
  could both read a stale usage count and both pass the quota check
- Month-rollover race in `maybeResetUsage`, where a stale read during the reset
  window could zero out a sibling request's already-recorded usage

[0.1.0]: https://github.com/nagpalarpit/snapog/releases/tag/v0.1.0
