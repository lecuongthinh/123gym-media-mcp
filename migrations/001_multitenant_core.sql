CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL UNIQUE,
  email text,
  display_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('tenant_owner', 'tenant_admin', 'editor', 'viewer', 'uplifting_support', 'uplifting_admin', 'uplifting_security_admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS tenant_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_backend text NOT NULL,
  secret_ref text NOT NULL UNIQUE,
  credential_type text NOT NULL CHECK (credential_type IN ('private_integration_token', 'oauth2')),
  expires_at timestamptz,
  rotation_state text NOT NULL DEFAULT 'current',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (secret_ref !~* '(bearer[[:space:]]+|eyJ[a-zA-Z0-9_-]+\.)')
);

CREATE TABLE IF NOT EXISTS connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_location_id text NOT NULL,
  auth_type text NOT NULL CHECK (auth_type IN ('private_integration_token', 'oauth2')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  credential_id uuid NOT NULL REFERENCES tenant_credentials(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_location_id),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  tool_name text,
  action text NOT NULL,
  result text NOT NULL,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memberships_tenant_status_idx ON memberships (tenant_id, status);
CREATE INDEX IF NOT EXISTS connections_tenant_status_idx ON connections (tenant_id, status);
CREATE INDEX IF NOT EXISTS audit_events_tenant_created_idx ON audit_events (tenant_id, created_at DESC);
