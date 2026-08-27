-- SnapOG D1 Schema
-- Migration 0002: Stripe billing columns on api_keys
--
-- Adds the columns needed to link an API key to a Stripe customer/subscription
-- so that tier upgrades/downgrades can be driven by verified webhook events
-- (checkout.session.completed, customer.subscription.updated/deleted) instead
-- of any client-supplied value. Existing columns are untouched.

ALTER TABLE api_keys ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE api_keys ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE api_keys ADD COLUMN stripe_subscription_status TEXT;

CREATE INDEX IF NOT EXISTS idx_api_keys_stripe_customer ON api_keys(stripe_customer_id);
