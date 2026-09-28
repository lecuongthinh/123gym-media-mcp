# Uplifting Social AI

Multi-tenant MCP resource server for ChatGPT, LeadConnector Media and HighLevel Social Planner.

Version **3.3.0** added Auth0 OAuth, database-backed user/tenant authorization, encrypted HighLevel OAuth credentials, audit events and tenant-isolated tool execution. The legacy 123 GYM environment credential remains supported but is not used by customer OAuth requests unless the authenticated user has an active 123 GYM membership.

Version **3.4.0** removed the temporary `debug_test_draft_without_userid` diagnostic: it was built to check whether HighLevel would accept a draft post without `userId`, and live testing against the real API confirmed it does not (HighLevel returns `422` for any status, including draft, when `userId` is missing). Instead, `connections.default_user_id` lets each tenant configure a HighLevel user id that `create_social_post` fills in automatically when the caller (ChatGPT/agent) omits `userId`, so the agent never needs to know a HighLevel-internal id. It also adds `list_location_users`, a read tool that returns a tenant's HighLevel staff so a `default_user_id` (or `postApprovalDetails.approver`) can be picked without leaving ChatGPT. Run `migrations/004_default_user_id.sql` (or `npm run migrate`) and set `default_user_id` for each tenant that should get this behavior.

Version **3.5.0** adds opt-in self-serve onboarding so a new customer needs no manual SQL: with `ENABLE_SELF_SERVE_SIGNUP=true`, the first time a brand-new Auth0 subject authenticates it is automatically provisioned a new `tenants` row, a `users` row and a `tenant_owner` membership (an existing-but-suspended user is never re-provisioned — it still fails closed). The HighLevel Marketplace OAuth callback (`/oauth/callback/social-crm`) now also calls the new `list_location_users` logic itself right after connecting, and stores a `default_user_id` automatically (preferring a user whose role is admin/owner) when the connected token has permission to read Users; if it doesn't, the connection still succeeds and `default_user_id` stays unset until an admin sets it, exactly like before. **Self-serve provisioning trusts whatever already authenticated via Auth0** — it does not gate who may sign up. Keep Auth0's own connection restricted to invite-only or approved signups; `ENABLE_SELF_SERVE_SIGNUP` only removes the manual database step *after* Auth0 has already let someone in.

Version **3.5.1** removed the OAuth-scope check (`uplifting:read`/`uplifting:write`) from tool authorization and from `/onboarding/highlevel/start`. Live testing surfaced an Auth0 platform limit: Auth0 will not add custom RBAC scopes to an access token issued to a **third-party** application (Dynamic Client Registration, `client_id` prefixed `tpc_`) unless the specific user was separately granted that permission in Auth0 — ChatGPT registers as exactly this kind of third-party client, so `api.accessToken.addScope(...)` in a Post Login Action is silently dropped for it (Auth0 logs this as a "Warning During Login": *"Attempting to add scopes (...) to an access token for a third-party application (...). These scopes were ignored."*). That made the scope check impossible to satisfy for self-serve users without also standing up an Auth0 Management API integration (an M2M app + a Role + a `post-user-registration` Action) just to grant permissions per new user. Authorization is now enforced entirely by the tenant `memberships.role` looked up from our own database (see the Roles table below), which every OAuth principal already goes through regardless of what scopes its access token carries.

Version **3.5.2** adds `connect_highlevel`, an MCP tool wrapping `/onboarding/highlevel/start` so ChatGPT can start HighLevel Marketplace OAuth for the caller's own tenant from inside the chat — a self-serve `tenant_owner` no longer needs a separate REST call outside ChatGPT to connect their sub-account. It runs before the generic tenant/connection lookup that every other tool goes through (that lookup would otherwise fail for a brand-new tenant with no connection yet, which is exactly the case this tool exists for), and still enforces the same owner/admin-only role check as the REST endpoint.

Version **3.5.5** fixes a real install failure found by live testing: when the HighLevel user completing OAuth consent is an agency-level (Company) user -- which every person on Uplifting's own agency is -- HighLevel's token response has no `locationId` at all, even after picking exactly one sub-account on the consent screen (confirmed via `userType: "Company"`, `companyId` present, `isBulkInstallation: true`). `connect_highlevel` and `POST /onboarding/highlevel/start` now **require** a `locationId` argument naming the sub-account to bind the tenant to. The OAuth callback stores that intended location before redirecting (`oauth_states.intended_location_id`, migration `005_oauth_state_intended_location.sql`), and when the token response comes back Company-scoped it mints a location-scoped access token via `POST /oauth/locationToken` (`src/highlevel-location-token.js`) using the company token + that locationId. The resulting connection is marked `auth_mode: "company"`; refreshing it (`src/credential-provider.js`) refreshes the company token and re-mints a fresh location token each time, since HighLevel does not issue a location-level refresh token in this mode. A genuine single-location HighLevel user (no agency access) still gets `locationId` directly in the response and is stored as `auth_mode: "location"`, refreshed the original simpler way.

Version **3.5.6** rewrote every tool's `locationId` description ("Defaults to 123 GYM for backward compatibility" read like an instruction to the model). That turned out not to be the actual cause of the `Cross-tenant location access blocked` failures -- see 3.5.7 -- but the old wording was still misleading, so the rewrite stays.

Version **3.5.7** fixes the real cause of `Cross-tenant location access blocked` for any OAuth tenant other than 123 GYM when a tool is called without `locationId` (confirmed live with an empty `{}` call): the tool handlers each declare `locationId = DEFAULT_LOCATION_ID` (123 GYM) as their own parameter default, so an omitted `locationId` silently became 123 GYM and then failed the tenant check against the caller's real location. The `/mcp` `tools/call` dispatch now overwrites `args.locationId` with the authorized tenant's own location right after `requestTenantContext` (which has already rejected any caller-supplied `locationId` that isn't theirs), so the handlers' 123 GYM default is unreachable for OAuth callers. This is the original "stop silently defaulting to the production location" concern, finally closed for the OAuth path.

Version **3.6.0** replaces the email allowlist hard-coded in the Auth0 "Gate signup by allowlist" Action with an invitation table. With `ENABLE_SELF_SERVE_SIGNUP=true`, only an email that has a `pending` row in `customer_invites` (migration `006_customer_invites.sql`) can create a tenant; the first login with that email consumes the row, names the tenant from `tenant_display_name`, and links `accepted_tenant_id`. Matching is case-insensitive, an email Auth0 explicitly marks unverified (`email_verified: false`) is refused, and a consumed invite cannot be reused. If the invite row has `default_location_id`, `connect_highlevel` needs no `locationId` argument and that tenant may connect only that sub-account. **Inviting a customer is now one row in the Supabase Table Editor** (`email`, optionally `tenant_display_name` and `default_location_id`) -- no Auth0 edit or redeploy. The Auth0 Action can be removed once this is verified; if you keep it, both gates apply. Keep Auth0 database sign-ups disabled: an admin-created Auth0 user whose email is not marked verified in Auth0 will be refused here.

## Security model

There are two independent OAuth relationships:

1. **ChatGPT → Uplifting MCP:** Auth0 Authorization Code + PKCE authenticates the human user. The MCP validates signature, issuer, audience and expiry. The Auth0 `sub` is resolved to `users` and an active `memberships` row. The selected tenant claim must match that membership. Tool-level authorization is enforced by that membership's `role`, not by OAuth scopes (see the 3.5.1 note above for why).
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
- `HIGHLEVEL_REDIRECT_URI` — staging `/oauth/callback/social-crm`
- `TENANT_CREDENTIAL_ENCRYPTION_KEY` — base64 encoding of 32 random bytes

Generate the encryption key locally without displaying any existing secret:

```bash
openssl rand -base64 32
```

Store the result directly in Render. Do not put it in Git, Supabase, ChatGPT or documentation.

Legacy admin access is optional and disabled by default:

- `ENABLE_LEGACY_ADMIN_AUTH=false`
- `MCP_ADMIN_API_KEY` may remain unset. If internal emergency access is required, set both the key and `ENABLE_LEGACY_ADMIN_AUTH=true`; only `X-API-Key` accepts it. Bearer tokens are reserved for OAuth.

Self-serve signup is optional and disabled by default:

- `ENABLE_SELF_SERVE_SIGNUP=false` — set to `true` only once Auth0's own connection restricts who can sign in (invite-only, approval required, or a closed allow-list). This flag controls what the app does *after* Auth0 authenticates someone, not who Auth0 lets authenticate.

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

### Self-serve (ENABLE_SELF_SERVE_SIGNUP=true)

1. Invite the customer: insert a row into `customer_invites` (Supabase Table Editor) with their `email`, and optionally `tenant_display_name` and the HighLevel `default_location_id`. Keep Auth0 database sign-ups disabled.
2. The customer adds the MCP staging URL in ChatGPT and logs in through Auth0 (signing up there too, if Auth0 allows it). On their very first successful login, the MCP auto-creates their `tenants` row, `users` row and a `tenant_owner` membership — no SQL needed.
3. The customer (now `tenant_owner`) asks the agent to call the `connect_highlevel` tool from inside ChatGPT with the `locationId` of the specific HighLevel sub-account to connect, opens the returned URL and completes HighLevel consent. (Equivalent to calling `POST /onboarding/highlevel/start` with `{ "locationId": "..." }` directly, for anything other than ChatGPT.) `locationId` is required — see the 3.5.5 note above for why the OAuth response alone cannot be trusted to name it.
4. The callback tries to auto-resolve `connections.default_user_id` via HighLevel's Users API. If the connected app/token has that scope, it is set automatically; if not, `create_social_post` will require an explicit `userId` until an admin sets `default_user_id` manually (via SQL, or by asking the customer to run `list_location_users` and reporting back a HighLevel user id).
5. Test `list_social_accounts` and a `create_social_post` draft to confirm both read and write reach HighLevel.

### Fully manual (ENABLE_SELF_SERVE_SIGNUP unset or false)

1. Create/invite the user in Auth0 and set `app_metadata.tenant_id` to the tenant UUID.
2. In Supabase SQL Editor, insert the same Auth0 `sub` into `users` and create one active `memberships` row. Never insert a password or token.
3. Add the tenant's HighLevel connection:
   - Pilot PIT: keep the token in Render and store only `env://VARIABLE_NAME` in `tenant_credentials.secret_ref`.
   - Marketplace OAuth: the tenant owner calls `POST /onboarding/highlevel/start` with `{ "locationId": "..." }`, opens the returned URL and completes HighLevel consent. The callback validates a one-time state and stores encrypted tokens, and tries the same automatic `default_user_id` resolution described above.
4. If `default_user_id` did not resolve automatically (PIT path always needs this step manually), set `connections.default_user_id` for this tenant's connection row to a valid HighLevel user id from that sub-account (Settings → My Staff, the HighLevel Users API, or this MCP's own `list_location_users` tool once the connection exists). HighLevel's Social Planner rejects `create_social_post` for every status, including draft, when `userId` is absent — there is no "system" poster identity. Skipping this step means every `create_social_post` call fails with a 422 unless the caller supplies `userId` itself.
5. Add the MCP staging URL in ChatGPT, select OAuth, complete login and scan tools.
6. Test `list_social_accounts` first, then a `create_social_post` draft, to confirm both read and write actually reach HighLevel. Use only the Testing Agency location during staging integration tests.

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
8. Confirm `/health` reports version `3.6.0` and does not expose configuration.
9. Complete ChatGPT OAuth and run read-only `list_social_accounts` for `UwsfBVLmz7XSKJbhuOTS`.
10. Attempt the 123 GYM `locationId` with the Testing Agency user and confirm it is blocked before any HighLevel request.
11. Inspect `audit_events` for success/failure records without secrets.
12. Keep production and `main` unchanged.
