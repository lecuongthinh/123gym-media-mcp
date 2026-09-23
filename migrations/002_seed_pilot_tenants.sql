INSERT INTO tenants (id, slug, display_name, status, timezone) VALUES
  ('00000000-0000-4000-8000-000000000123', '123-gym', '123 GYM', 'active', 'Asia/Ho_Chi_Minh'),
  ('00000000-0000-4000-8000-000000000124', 'testing-agency', 'Testing Agency', 'active', 'Asia/Ho_Chi_Minh')
ON CONFLICT (id) DO UPDATE SET
  slug = EXCLUDED.slug,
  display_name = EXCLUDED.display_name,
  status = EXCLUDED.status,
  timezone = EXCLUDED.timezone,
  updated_at = now();

INSERT INTO tenant_credentials (id, secret_backend, secret_ref, credential_type) VALUES
  ('10000000-0000-4000-8000-000000000123', 'environment', 'env://LC_PRIVATE_TOKEN', 'private_integration_token'),
  ('10000000-0000-4000-8000-000000000124', 'environment', 'env://LC_PRIVATE_TOKEN_TESTING_AGENCY', 'private_integration_token')
ON CONFLICT (id) DO UPDATE SET
  secret_backend = EXCLUDED.secret_backend,
  secret_ref = EXCLUDED.secret_ref,
  credential_type = EXCLUDED.credential_type,
  updated_at = now();

INSERT INTO connections (id, tenant_id, provider, external_location_id, auth_type, status, credential_id) VALUES
  ('20000000-0000-4000-8000-000000000123', '00000000-0000-4000-8000-000000000123', 'highlevel', 'pUePVc6UKEUecvZS6EYU', 'private_integration_token', 'active', '10000000-0000-4000-8000-000000000123'),
  ('20000000-0000-4000-8000-000000000124', '00000000-0000-4000-8000-000000000124', 'highlevel', 'UwsfBVLmz7XSKJbhuOTS', 'private_integration_token', 'active', '10000000-0000-4000-8000-000000000124')
ON CONFLICT (id) DO UPDATE SET
  tenant_id = EXCLUDED.tenant_id,
  external_location_id = EXCLUDED.external_location_id,
  auth_type = EXCLUDED.auth_type,
  status = EXCLUDED.status,
  credential_id = EXCLUDED.credential_id,
  updated_at = now();
