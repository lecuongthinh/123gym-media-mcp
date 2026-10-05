-- Which posts were created by the agent (create_social_post), so its results
-- can be compared with posts made by hand. HighLevel gives no way to tell
-- them apart (an API-created post looks like a composer post by the same user),
-- so Uplifting records the ids itself. Only posts created after this exists
-- are tracked.
CREATE TABLE IF NOT EXISTS agent_posts (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  post_id text NOT NULL,
  platform text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, post_id)
);
CREATE INDEX IF NOT EXISTS agent_posts_tenant_created_idx ON agent_posts (tenant_id, created_at DESC);
ALTER TABLE agent_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE agent_posts FROM anon, authenticated;
