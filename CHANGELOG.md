# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
