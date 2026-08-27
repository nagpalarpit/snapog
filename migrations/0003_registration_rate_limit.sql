-- SnapOG D1 Schema
-- Migration 0003: registration rate-limit tracking
--
-- POST /register has no email verification — adding one needs the same
-- credentialed email-sending capability this project is currently blocked
-- on provisioning — and no other limiter. Without this, a script can loop
-- hitting /register with throwaway addresses and mint unlimited free-tier
-- API keys (100 images/month each), which is unbounded R2/D1 usage against
-- $0 revenue. This table backs a simple IP-based rate limit on that route,
-- using the D1 binding that's already provisioned (there's no KV binding,
-- and adding one needs a real Cloudflare account — also blocked).

CREATE TABLE IF NOT EXISTS registration_attempts (
  id         TEXT PRIMARY KEY,
  ip         TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Composite index (ip equality filter, then created_at range filter) to
-- keep "count attempts for this IP in the last N hours" cheap.
CREATE INDEX IF NOT EXISTS idx_registration_attempts_ip_created
  ON registration_attempts(ip, created_at);
