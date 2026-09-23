ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

ALTER TABLE tenant_credentials
  ADD COLUMN IF NOT EXISTS encrypted_payload bytea,
  ADD COLUMN IF NOT EXISTS encryption_version integer,
  ADD COLUMN IF NOT EXISTS last_rotated_at timestamptz;

ALTER TABLE tenant_credentials
  DROP CONSTRAINT IF EXISTS tenant_credentials_backend_payload_check;

ALTER TABLE tenant_credentials
  ADD CONSTRAINT tenant_credentials_backend_payload_check CHECK (
    (secret_backend = 'environment' AND encrypted_payload IS NULL)
    OR
    (secret_backend = 'encrypted_database' AND encrypted_payload IS NOT NULL)
  );

ALTER TABLE tenant_credentials
  DROP CONSTRAINT IF EXISTS tenant_credentials_metadata_no_secret_check;

ALTER TABLE tenant_credentials
  ADD CONSTRAINT tenant_credentials_metadata_no_secret_check CHECK (
    metadata::text !~* '(access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer[[:space:]]+)'
  );

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('highlevel')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states (expires_at) WHERE used_at IS NULL;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE users, tenants, memberships, connections,
  tenant_credentials, audit_events, schema_migrations, oauth_states
  FROM anon, authenticated;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
