-- Foundation for tiered pricing (Phase 1 of the pricing roadmap): a `plan`
-- column to gate features/limits on later, and a usage counter so a plan's
-- limits have something real to check against. No enforcement yet -- this
-- migration only adds the ability to know a tenant's plan and count its
-- AI-driven post creations; Phase 2/3 decide the actual per-plan limits.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'standard' CHECK (plan IN ('trial', 'standard', 'pro'));

-- Every tenant that existed before this migration is an already-onboarded
-- paying customer, not a new trial signup -- seed them explicitly rather
-- than relying on the column default alone.
UPDATE tenants SET plan = 'standard' WHERE plan IS NULL OR plan = 'standard';

-- One row per tenant/metric/calendar-month, incremented as usage happens
-- (metric is a free-form label, e.g. 'posts_created', so future metrics
-- don't need a new table). `period` is 'YYYY-MM' in UTC.
CREATE TABLE IF NOT EXISTS tenant_usage_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric text NOT NULL,
  period text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period)
);

ALTER TABLE tenant_usage_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tenant_usage_counters FROM anon, authenticated;
