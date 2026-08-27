# Security Policy

SnapOG is self-hosted: each deployment runs entirely inside the operator's own
Cloudflare account (Workers, D1, R2). There is no shared multi-tenant
infrastructure and no hosted instance operated by this project, so a
vulnerability report is almost always about the code itself, not a specific
deployment.

## Supported Versions

Only the latest commit on `main` is supported. There are no maintained
release branches — if you're running an older checkout, update before
reporting an issue to confirm it still reproduces.

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security reports.

Email **hyperstring.labs@gmail.com** with:
- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal request/curl example is ideal).
- The commit hash you tested against.

We aim to acknowledge reports within a few days. Once a fix is confirmed, it
will be pushed to `main` and credited to the reporter in the commit message
unless you ask to stay anonymous.

## Scope Notes

- API key generation, rate limiting, and tier enforcement live in
  `src/`; issues there (e.g. bypassing a tier limit, forging a key) are in
  scope.
- The R2 cache key derivation and D1 schema are also in scope — a bug that
  lets one API key read or overwrite another key's cached images would be
  a high-severity report.
- Cloudflare platform-level issues (Workers runtime, D1, R2 itself) are out
  of scope — report those to Cloudflare directly.
- Stripe integration code ships inert (no keys configured by default); if
  you find an issue in it, please still report it, but note in your report
  whether it requires an operator to have configured live Stripe keys.
