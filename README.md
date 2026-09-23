# Uplifting Social AI

Multi-tenant MCP resource server for ChatGPT, LeadConnector Media and HighLevel Social Planner.

Version **3.3.0** adds Auth0 OAuth, database-backed user/tenant authorization, encrypted HighLevel OAuth credentials, audit events and tenant-isolated tool execution. The legacy 123 GYM environment credential remains supported but is not used by customer OAuth requests unless the authenticated user has an active 123 GYM membership.

## Security model

There are two independent OAuth relationships:

1. **ChatGPT → Uplifting MCP:** Auth0 Authorization Code + PKCE authenticates the human user. The MCP validates signature, issuer, audience, expiry and scopes. The Auth0 `sub` is resolved to `users` and an active `memberships` row. The selected tenant claim must match that membership.
2. **Uplifting MCP → HighLevel:** each tenant has its own `connections` row. Pilot PIT credentials remain in Render environment variables. Marketplace OAuth access and refresh tokens are AES-256-GCM encrypted before storage; the encryption key remains only in Render.

`locationId` is never an authorization decision for OAuth users. It is accepted only as an optional consistency check after the tenant has been selected from the authenticated membership.

Roles:

| Role | Read tools | Create/update/upload | Delete | Connect HighLevel |
|---|---:|---:|---:|---:|
| `viewer` | Yes | No | No | No |
| `editor` | Yes | Yes | No | No |
| `tenant_admin` / `tenant_owner` | Yes | Yes | Yes | Yes |
| `uplifting_admin` | Yes | Yes | Yes | Yes |

## Local commands

```bash
npm ci
npm test
npm run check:config
npm run migrate
npm start
```

`npm run migrate` needs only `DATABASE_URL` (and `NODE_ENV=production` when SSL must be enabled). It records each migration filename in `public.schema_migrations` and uses a PostgreSQL advisory lock.

## Render staging

- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/health`
- Migration command, run once before deploying this version: `npm run migrate`

Required for customer OAuth mode:

- `DATABASE_URL`
- `AUTH0_ISSUER_BASE_URL` — canonical issuer including trailing slash
- `AUTH0_AUDIENCE` — Auth0 API identifier; use the canonical MCP resource URL
- `MCP_RESOURCE_URL` — public staging origin, no trailing slash
- `AUTH0_TENANT_CLAIM` — recommended `https://uplifting.vn/tenant_id`

Testing Agency PIT pilot:

- `LC_PRIVATE_TOKEN_TESTING_AGENCY`

Required only when enabling HighLevel Marketplace OAuth onboarding:

- `HIGHLEVEL_CLIENT_ID`
- `HIGHLEVEL_CLIENT_SECRET`
- `HIGHLEVEL_INSTALL_URL` — copy from the HighLevel Marketplace app Auth pane
- `HIGHLEVEL_REDIRECT_URI` — staging `/oauth/callback/highlevel`
- `TENANT_CREDENTIAL_ENCRYPTION_KEY` — base64 encoding of 32 random bytes

Generate the encryption key locally without displaying any existing secret:

```bash
openssl rand -base64 32
```

Store the result directly in Render. Do not put it in Git, Supabase, ChatGPT or documentation.

Legacy admin access is optional and disabled by default:

- `ENABLE_LEGACY_ADMIN_AUTH=false`
- `MCP_ADMIN_API_KEY` may remain unset. If internal emergency access is required, set both the key and `ENABLE_LEGACY_ADMIN_AUTH=true`; only `X-API-Key` accepts it. Bearer tokens are reserved for OAuth.

## Auth0 configuration

1. Create an Auth0 API whose Identifier exactly equals `AUTH0_AUDIENCE` / `MCP_RESOURCE_URL`.
2. Add API permissions `uplifting:read`, `uplifting:write`, `uplifting:admin`. Enable RBAC and **Add Permissions in the Access Token**.
3. Enable Authorization Code and Refresh Token grants and PKCE `S256`.
4. Configure ChatGPT as a public third-party client. Auth0 supports manual Client ID Metadata Document registration; import the exact ChatGPT CIMD URL displayed by ChatGPT. For the stable mode this is `https://chatgpt.com/oauth/client.json`.
5. Allow the exact redirect URI shown by ChatGPT. When issuer identification is supported it is `https://chatgpt.com/connector_platform_oauth_redirect`; otherwise use the callback-specific URI shown in ChatGPT.
6. Add an Auth0 Post Login Action that emits the tenant selector from Auth0 `app_metadata`; the database membership remains authoritative:

```js
exports.onExecutePostLogin = async (event, api) => {
  const tenantId = event.user.app_metadata?.tenant_id;
  if (tenantId) api.accessToken.setCustomClaim("https://uplifting.vn/tenant_id", tenantId);
};
```

7. Verify Auth0 discovery advertises the authorization endpoint, token endpoint and `S256`. The MCP publishes `/.well-known/oauth-protected-resource` and challenges unauthenticated requests with `WWW-Authenticate`.

Do not place roles or access decisions only in Auth0. The backend always checks `users`, `memberships` and `tenants` in PostgreSQL after validating the token.

## Provision a customer

For the first staging pilot, provision the identity before the user connects ChatGPT:

1. Create/invite the user in Auth0 and set `app_metadata.tenant_id` to the tenant UUID.
2. In Supabase SQL Editor, insert the same Auth0 `sub` into `users` and create one active `memberships` row. Never insert a password or token.
3. Add the tenant's HighLevel connection:
   - Pilot PIT: keep the token in Render and store only `env://VARIABLE_NAME` in `tenant_credentials.secret_ref`.
   - Marketplace OAuth: the tenant owner calls `POST /onboarding/highlevel/start`, opens the returned URL and completes HighLevel consent. The callback validates a one-time state and stores encrypted tokens.
4. Add the MCP staging URL in ChatGPT, select OAuth, complete login and scan tools.
5. Test `list_social_accounts` first. Use only the Testing Agency location during staging integration tests.

If a user has memberships in more than one tenant, the Auth0 access token must contain the tenant claim. If the claim is absent, the request fails closed as ambiguous.

## Supabase and RLS

Migration `003_oauth_security.sql`:

- adds encrypted credential fields and one-time HighLevel OAuth state storage;
- enables RLS for all application and migration tables;
- revokes table and sequence privileges from Supabase `anon` and `authenticated` Data API roles;
- creates no permissive Data API policies.

The backend connects directly through `DATABASE_URL`; it does not use the Supabase anon/service API key. Confirm the Render PostgreSQL role can still query after migration before deploying the backend. The migration is additive and contains no `DELETE`, `TRUNCATE` or `DROP TABLE`.

## Staging release checklist

1. Back up the Supabase staging database.
2. Review and run `003_oauth_security.sql` or `npm run migrate` against staging only.
3. Confirm `schema_migrations` contains `003_oauth_security.sql`.
4. Configure Auth0 variables and validate protected-resource metadata.
5. Provision one Testing Agency Auth0 user and membership.
6. Run `npm test` and `npm run check:config`.
7. Deploy only `feature/oauth-multitenant-v1` to the staging Render service.
8. Confirm `/health` reports version `3.3.0` and does not expose configuration.
9. Complete ChatGPT OAuth and run read-only `list_social_accounts` for `UwsfBVLmz7XSKJbhuOTS`.
10. Attempt the 123 GYM `locationId` with the Testing Agency user and confirm it is blocked before any HighLevel request.
11. Inspect `audit_events` for success/failure records without secrets.
12. Keep production and `main` unchanged.
