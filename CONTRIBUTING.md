# Contributing to SnapOG

Thanks for considering a contribution. SnapOG is a small, focused project —
keep changes scoped and avoid adding new abstractions or config knobs that
aren't needed by the change at hand.

## Getting Started

Follow the "Local Development" section in the [README](README.md) to get a
working dev environment (D1 database, migrations, `wrangler dev`).

## Before Opening a PR

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Both must pass. CI runs the same two commands on every push and PR
(`.github/workflows/ci.yml`) — if it's red, the PR won't be merged.

If you're changing an OG template (`src/templates/` or wherever rendering
logic lives), add a pixel-content regression test alongside the existing
ones rather than only a snapshot/screenshot check — the existing tests
guard against subtle Satori layout regressions (e.g. multi-line title
overlap) that are easy to introduce and hard to spot by eye.

## Pull Requests

- One logical change per PR. Unrelated cleanups make review harder — open a
  separate PR.
- Describe *why* the change is needed, not just what it does — the diff
  already shows what changed.
- If your change touches the API surface (`/og` query params, response
  headers), update the README's API section in the same PR.

## Reporting Bugs

Open a GitHub issue with a minimal reproduction (a `curl` command against a
freshly deployed instance is ideal). If it's a security issue, see
[SECURITY.md](SECURITY.md) instead — please don't file it as a public issue.

## Code Style

There's no linter configured yet; match the existing style in the file
you're editing (TypeScript, Hono route handlers, no unnecessary comments).
