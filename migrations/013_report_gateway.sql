-- Report gateway: read-only MCP access to a customer's sub-account, with
-- per-customer, per-role "pack" permissions that an Uplifting admin approves
-- in /report-admin. Fully separate from the social-posting tables (own
-- tenants/users/tokens, own HighLevel Marketplace app) so the module can be
-- moved to its own service later. Additive only: no DELETE/TRUNCATE/DROP.

CREATE TABLE IF NOT EXISTS report_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL UNIQUE,
  name text NOT NULL,
  -- pending: installed but not yet approved (no pack usable);
  -- active: approved; suspended: all access refused.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL UNIQUE,
  email text,
  display_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_memberships (
  user_id uuid NOT NULL REFERENCES report_users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES report_tenants(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'staff', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

-- One HighLevel credential per customer, AES-256-GCM encrypted by the app
-- (key only in Render). Never stored in plain text.
CREATE TABLE IF NOT EXISTS report_connections (
  tenant_id uuid PRIMARY KEY REFERENCES report_tenants(id) ON DELETE CASCADE,
  location_id text NOT NULL,
  encrypted_payload bytea NOT NULL,
  expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Master switch per customer and pack (what the customer may use at all).
CREATE TABLE IF NOT EXISTS report_pack_grants (
  tenant_id uuid NOT NULL REFERENCES report_tenants(id) ON DELETE CASCADE,
  pack text NOT NULL,
  enabled boolean NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pack)
);

-- Role ceiling per customer and pack. Missing row = the built-in default for
-- that role (see src/report/packs.js). Effective access needs BOTH rows true.
CREATE TABLE IF NOT EXISTS report_role_packs (
  tenant_id uuid NOT NULL REFERENCES report_tenants(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'staff', 'viewer')),
  pack text NOT NULL,
  enabled boolean NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role, pack)
);

CREATE TABLE IF NOT EXISTS report_audit (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES report_tenants(id) ON DELETE SET NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('mcp', 'admin', 'system')),
  actor text,
  action text NOT NULL,
  tool text,
  pack text,
  result text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_audit_tenant_created_idx ON report_audit (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS report_oauth_clients (
  client_id text PRIMARY KEY,
  client_name text,
  redirect_uris text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_login_requests (
  state_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES report_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  client_state text,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS report_auth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  user_id uuid NOT NULL REFERENCES report_users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES report_tenants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS report_oauth_tokens (
  token_hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  family_id uuid NOT NULL,
  client_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES report_users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES report_tenants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS report_oauth_tokens_family_idx ON report_oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS report_oauth_tokens_tenant_idx ON report_oauth_tokens (tenant_id);

-- Access codes for staff who cannot authorize the Marketplace app themselves
-- (HighLevel only lets an Admin do that). An admin creates one in the dashboard
-- for an email + role; the person enters it when connecting. Stored hashed.
CREATE TABLE IF NOT EXISTS report_invites (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES report_tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'staff', 'viewer')),
  created_by text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS report_invites_tenant_idx ON report_invites (tenant_id);

-- Runtime switches an admin can flip from the dashboard without a deploy
-- (e.g. key 'paused' = 'true' stops every tool call while sign-in keeps working).
CREATE TABLE IF NOT EXISTS report_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dashboard sign-in: a one-time emailed link for an allow-listed admin email.
CREATE TABLE IF NOT EXISTS report_admin_login_tokens (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

ALTER TABLE report_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_pack_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_role_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_login_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_admin_login_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE report_tenants, report_users, report_memberships, report_connections,
  report_pack_grants, report_role_packs, report_audit, report_oauth_clients,
  report_login_requests, report_auth_codes, report_oauth_tokens, report_admin_login_tokens,
  report_invites, report_settings
  FROM anon, authenticated;
REVOKE ALL ON SEQUENCE report_audit_id_seq FROM anon, authenticated;
