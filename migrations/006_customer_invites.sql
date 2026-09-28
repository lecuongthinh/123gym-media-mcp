-- Self-serve provisioning is gated by this table instead of an email
-- allowlist hard-coded in an Auth0 Action. Uplifting staff invite a customer
-- by inserting a row (Supabase Table Editor); the first successful login with
-- that email consumes it and creates the tenant. default_location_id, when
-- set, is the only HighLevel sub-account that tenant may connect.
CREATE TABLE IF NOT EXISTS customer_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  tenant_display_name text,
  default_location_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  accepted_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_invites_pending_email_idx
  ON customer_invites (lower(email)) WHERE status = 'pending';

ALTER TABLE customer_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE customer_invites FROM anon, authenticated;
