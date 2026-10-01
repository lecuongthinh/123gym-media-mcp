-- Per-plan quantity limits, editable live from the admin panel (src/admin-panel.js)
-- without a redeploy. NULL means unlimited. Seeded with placeholder numbers --
-- the admin panel is exactly how these get tuned to real values.
CREATE TABLE IF NOT EXISTS plan_limits (
  plan text PRIMARY KEY CHECK (plan IN ('trial', 'standard', 'pro')),
  max_users integer,
  max_posts_per_month integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plan_limits (plan, max_users, max_posts_per_month) VALUES
  ('trial', 3, 10),
  ('standard', 10, 100),
  ('pro', NULL, NULL)
ON CONFLICT (plan) DO NOTHING;

ALTER TABLE plan_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE plan_limits FROM anon, authenticated;
