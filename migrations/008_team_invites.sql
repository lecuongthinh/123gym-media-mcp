-- Lets a tenant_owner/tenant_admin add a teammate without that person needing
-- to be a HighLevel Admin themselves (HighLevel only lets Admins authorize a
-- Marketplace app at all -- see highlevel-onboarding history). The invite
-- grants membership; email_login_tokens is the separate, later mechanism a
-- returning member uses to actually sign into a ChatGPT connector without a
-- fresh HighLevel consent.

CREATE TABLE IF NOT EXISTS team_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('tenant_admin', 'editor', 'viewer')),
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_invites_expiry_idx ON team_invites (expires_at) WHERE status = 'pending';

-- Carries a pending ChatGPT /oauth/authorize request (copied from
-- oauth_login_requests at the moment the member asks to sign in by email)
-- across the "check your email" round trip.
CREATE TABLE IF NOT EXISTS email_login_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  client_state text,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_login_tokens_expiry_idx ON email_login_tokens (expires_at);

ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_login_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE team_invites, email_login_tokens FROM anon, authenticated;
