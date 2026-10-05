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

Version **3.7.0** adds a built-in OAuth 2.1 authorization server so ChatGPT signs users in through HighLevel itself and Auth0 is no longer required. It is off unless `OAUTH_SERVER_ENABLED=true` (and the `HIGHLEVEL_*` and `TENANT_CREDENTIAL_ENCRYPTION_KEY` settings are present); migration `007_builtin_oauth_server.sql` must be applied first. Endpoints: `/.well-known/oauth-authorization-server`, `/oauth/register` (dynamic client registration, public clients, redirect URIs limited to `chatgpt.com`, `chat.openai.com`, `platform.openai.com` plus `OAUTH_ALLOWED_REDIRECT_HOSTS`), `/oauth/authorize` (PKCE S256 required), `/oauth/token` (authorization_code and rotating refresh_token; replaying a used refresh token revokes its whole family). `/oauth/authorize` sends the user to the HighLevel install/consent page; the existing callback `/oauth/callback/social-crm` recognises login states, and one approval both signs the user in and connects the sub-account: the HighLevel user id becomes the identity (`highlevel:<userId>`), the tenant for that sub-account is found or created (named after the location; needs `ENABLE_SELF_SERVE_SIGNUP=true` to create), the first member is `tenant_owner` and later members are `tenant_admin` (HighLevel admins) or `editor`, and the granted HighLevel credential is stored encrypted. Access tokens (`uat_…`, 1 hour) are opaque and stored only as SHA-256 hashes. The consent must come from a HighLevel user of the sub-account itself (Marketplace app → Listing Configuration → *Who can install* = Everyone); an agency-level (Company) grant is refused because it does not identify a single sub-account. Auth0 tokens keep working in parallel while Auth0 is still configured, and the customer_invites table is not consulted by this path. The login redirect uses the standard consent URL `marketplace.gohighlevel.com/oauth/chooselocation` built from `HIGHLEVEL_CLIENT_ID`, `HIGHLEVEL_REDIRECT_URI`, the app's 20 scopes (override with `HIGHLEVEL_OAUTH_SCOPES`) and a `version_id` taken from `HIGHLEVEL_VERSION_ID` or the Marketplace install link; the Marketplace "Install link" itself is not used because it sends sub-account users to the normal dashboard. Set `HIGHLEVEL_AUTHORIZE_URL` (e.g. `https://app.uplifting.vn/oauth/chooselocation`) to send users to the agency white-label domain instead of `marketplace.gohighlevel.com`; the `/oauth/token` exchange still uses HighLevel's API. `initialize`, `notifications/initialized` and `tools/list` are answered without a token so ChatGPT can list the tools before the user signs in (the list is static schema, no tenant data); `tools/call` and every other method still require a valid token, and a presented-but-invalid token is still rejected. Rolling back is setting `OAUTH_SERVER_ENABLED=false`.

Version **3.8.0** adds `list_social_categories` and `list_social_tags` (Social Planner scopes the app already had -- `category.readonly`, `tag.readonly` -- but no tool had used). HighLevel's `create_social_post`/`update_social_post` silently drop a `categoryId`/`tags` value that isn't a real id, and there was no way for the model to know a category or tag's real id versus the name a customer says out loud; a live customer test (an external "Uplifting Publisher" connector calling this same API) hit exactly this. The two tools resolve a name to its id first; `categoryId`'s and `tags`' field descriptions now say to call them first. HighLevel had not shipped create/update/delete for categories/tags as of this writing, only listing, so this is read-only for now.

Version **3.9.0** adds team members who are not HighLevel Admins -- HighLevel only lets an Admin authorize a Marketplace app at all, so a plain staff member could never complete the 3.7.0 login themselves. New MCP tool `invite_team_member` (tenant_owner/tenant_admin/uplifting_admin only; email + role) creates a `team_invites` row (migration `008_team_invites.sql`) and emails the invite link. Sending that email does not use a new vendor: it POSTs to the Inbound Webhook trigger of one GHL Workflow ("Send Team Invite Email") living in **Uplifting's own CRM location**, not any customer's -- set its URL as `HIGHLEVEL_INVITE_WEBHOOK_URL`. Visiting the invite link (`/invite/accept?token=`) grants membership; HighLevel is never involved for this person. `/oauth/authorize` now shows a "Continue with HighLevel" / "Email me a sign-in link" choice page instead of redirecting straight to HighLevel, so a returning invited member can sign into a ChatGPT connector by email alone: `/oauth/authorize/email` looks up the email's one active membership, emails a one-time link (same webhook) to `/oauth/email-login/verify`, which issues the same kind of authorization code the HighLevel path does. Unrecognized emails get an identical "check your email" response and no email is sent, to avoid confirming who has an account. Without `HIGHLEVEL_INVITE_WEBHOOK_URL` set, no invite or sign-in email actually goes out (it is logged and silently skipped) even though the choice page and its generic "check your email" response still appear; HighLevel sign-in itself is unaffected either way.

Version **3.10.0** fixes the HighLevel admin-detection bug, removes customer-facing "HighLevel" wording, and adds the Phase 1 foundation for tiered pricing. `completeHighLevelLogin()` no longer gates a second/later member's role on finding them in HighLevel's per-location Users API (`GET /users/?locationId=`) -- confirmed live that an agency-level Admin with inherited cross-sub-account access never appears in that list, and was silently downgraded to `editor` instead of `tenant_admin`. Since this Marketplace app is Sub-Account type and HighLevel itself only lets a sub-account Admin reach the OAuth consent screen at all, reaching this code with a per-location grant already proves Admin access; a member joining an existing tenant this way is now always `tenant_admin`. Every customer/admin-facing string (tool titles/descriptions, HTML login pages, OAuth and credential error messages) that said "HighLevel" now says "Uplifting" or a generic term instead, since the agency is white-labeled and customers should never see the underlying platform's name; internal function names and the `leadconnectorhq.com`/`gohighlevel.com` URLs themselves are unchanged (they aren't customer-visible, and the Marketplace consent URL can't be changed anyway). For pricing: migration `009_plan_and_usage.sql` adds `tenants.plan` (`trial`/`standard`/`pro`, existing tenants seeded `standard`) and `tenant_usage_counters` (one row per tenant/metric/calendar-month), incremented by the count of posts actually created (not skipped-duplicate) on every `create_social_post` call via the new `incrementUsage`/`getUsage` repository methods -- no plan limits are enforced yet, this only makes the data available for Phase 2/3. Separately, `tools/call` now rate-limits each tenant to `TENANT_RATE_LIMIT_PER_MINUTE` (default 60) requests/minute, in-memory and independent of the plan system, as a abuse guard against a runaway automation loop or a leaked token; exceeding it returns JSON-RPC error `-32029`.

Version **3.11.0** finishes the de-branding sweep 3.10.0 started, and adds process guidance so the model stops guessing at what this connector can do. The 3.10.0 pass only changed tool *titles/descriptions*; the tool *names* the model actually sees and reasons over still said `connect_highlevel`, `upload_leadconnector_media` and `search_leadconnector_media` -- renamed to `connect_social_account`, `upload_media` and `search_media_library` (ChatGPT caches tool schemas, so **every already-connected customer must disconnect and reconnect this connector** to pick up the new names). A handful of remaining "LeadConnector"/"HighLevel" strings in error messages and field descriptions (`server.js`, `src/tenant-services.js`) were also swept. Separately, a live test surfaced a real confusion: asked to find something in "the media library", the model answered from ChatGPT's own file history instead of calling `search_media_library`. The `initialize` response now includes an `instructions` field (`MCP_INSTRUCTIONS` in `server.js`) giving the model soft process guidance that a single tool description can't: that this is a separate system from ChatGPT itself, to call `connect_social_account` first if no connection exists, that "my media library"/"our gallery"/anything already in their account always means their *connected* account (never ChatGPT's own files or generated images), to resolve category/tag names to ids before use, to default new posts to draft, and to use `invite_team_member` for a non-Admin teammate instead of asking them to connect directly.

Version **3.11.1** addresses a limit the 3.10.0/3.11.0 renames couldn't reach: live-testing asked ChatGPT directly "social planner của hệ thống gì?" (which system is Social Planner?) and it answered "HighLevel (GoHighLevel/GHL)" from its own background knowledge -- the model already knows "Social Planner" is a HighLevel product regardless of what our own strings say, so no amount of renaming our side prevents it from naming the vendor if asked a direct meta-question. Two mitigations, neither a hard guarantee against a determined jailbreak: (1) removed "Social Planner" from every tool title/description/error message we control (now just "post"/"social account"/"posting"), reducing the model's own cues; (2) added an explicit rule to `MCP_INSTRUCTIONS`: if asked what platform/vendor/software this runs on, never name or guess at a third-party platform, answer only that it's Uplifting Social AI's own system.

Version **3.12.0** adds folder support to `search_media_library` -- a live complaint was that the agent could only search media by filename/text, with no way to look inside a specific folder. `GET /medias/files` actually accepts `parentId` (restrict to one folder) and `query` (server-side name search) query parameters that `listMedia()` simply never sent; it only filtered client-side on whatever one page of results came back. Added `folderId` (maps to `parentId`) and `type` (`file`/`folder`, defaults to `file`) input parameters; passing `type: "folder"` with a `search` term lets the model resolve a folder's id by name, then a follow-up call with that id as `folderId` lists only what's inside it. Every returned file now also reports its own `folderId`. `MCP_INSTRUCTIONS` and the tool description both spell out this two-step folder-lookup pattern, since a customer naming a folder ("ảnh trong thư mục Tháng 10") is a case the model won't otherwise know how to handle. New optional input fields on an existing tool are a schema change ChatGPT still caches, so **connected customers need to disconnect/reconnect again** for the model to see and use `folderId`/`type` (the server accepts them immediately for anyone who already knows to pass them).

Version **3.12.1** removes "123 GYM" (and its specific sub-brands "La Charme", "Tô Hiệu", "Balance Fit") from every generic, every-tenant-sees-this tool description and error message -- this codebase is sold to many customers now, and those are one specific customer's own brand names, not something a different customer should ever see in their own connector's tool list. `list_social_posts`/`create_social_post`'s descriptions and the "no eligible accounts" error are now plain "all eligible connected accounts", not "123 GYM accounts". The actual 123-GYM-specific account-filtering logic (`isEligible123GymAccount`, `BLOCKED_ACCOUNT_PATTERN`) was already correctly gated on `locationId === LEGACY_123_GYM_LOCATION_ID` and unaffected for every other tenant -- this was a wording leak in shared description strings, not a functional bug.

Version **3.13.0** adds the first real enforcement on top of the Phase 1 pricing foundation, plus an internal admin panel to manage it. Migration `010_plan_limits.sql` adds a `plan_limits` table (`max_users`, `max_posts_per_month` per plan; `NULL` = unlimited; seeded with placeholder numbers meant to be tuned, not final). `invite_team_member` now calls `enforceUserLimit()` (rejects once `countActiveMemberships(tenantId) >= max_users`) and `create_social_post` calls `enforcePostLimit()` (rejects once this month's `posts_created` usage counter is at `max_posts_per_month`) -- both are no-ops for `legacy_admin` callers and for any plan with no configured limit, read fresh from the DB on every call (no caching, so an admin's edit applies immediately). New `src/admin-panel.js` serves `GET /admin` (lists every tenant with its plan/member count/posts this period, and a form per plan to edit its limits) and the two `POST` routes behind it, gated by a single static key in the query string (`ADMIN_PANEL_KEY` env var; unset = the whole route 404s) rather than a login -- deliberately lightweight since it's meant to be opened from a HighLevel Custom Menu Link the agency's own team sees, not a customer-facing surface. No UI framework, just inline HTML forms matching the style of `oauth-server.js`'s pages.

Version **3.13.1** fixes email sign-in failing in ChatGPT with "thiếu dữ liệu OAuth callback" (missing OAuth callback data). Render logs showed `/oauth/email-login/verify` returning 302 with a valid `code`+`state`, yet ChatGPT never called `/oauth/token`: the emailed link was opened in a different tab/browser/device than the window ChatGPT was waiting in, and ChatGPT's callback only works in that original window. The "check your email" page now carries a secret poll token and polls `GET /oauth/email-login/poll`; clicking the link (anywhere) now shows a "you're signed in" page and parks the finished redirect, which the original window collects exactly once and navigates to itself. The link page keeps a "continue here" fallback. An unrecognized email gets the same waiting page (poll never completes), so there is still no account enumeration. Needs migration `011_email_login_poll.sql` (`poll_hash`, `completed_redirect` on `email_login_tokens`).

Version **3.13.2** lets the 123 GYM tenant post to TikTok and YouTube: its legacy account filter only allowed `facebook`/`google`, so naming a TikTok account failed with "Inactive or tenant-blocked social accounts" even though the connection was active. TikTok and YouTube are now accepted when an account is **named explicitly**; they are still never auto-selected when no `accountIds` are given, and Instagram plus the Tô Hiệu/tuyển dụng/Balance Fit exclusions are unchanged.

Version **3.14.0** removes all account blocking and replaces auto-selection with "ask the user". The legacy 123 GYM filter (facebook/google only, the Tô Hiệu / tuyển dụng / Balance Fit name exclusions, and 3.13.2's explicit-TikTok/YouTube exception) is gone: `isEligibleSocialAccount` only checks the connection is usable (active, not expired, not deleted), for every tenant and platform. `create_social_post` no longer picks accounts when `accountIds` is omitted -- it fails with a message listing the available accounts and telling the agent to ask the user (also in the tool description and `MCP_INSTRUCTIONS`), so nothing is posted to an account the user didn't name. `list_social_posts` with no `accountIds` lists across all active accounts. No reconnect needed.

Version **3.14.1** fixes duplicate posts and failed deletes. Duplicates: the retry guard compared a stored post to the request by strict equality, but HighLevel returns media objects with extra fields and normalizes text and dates, so a retried post with media was never recognised; matching now normalizes summary whitespace, compares schedule times within a minute and media by filename (`isSamePost`). A post HighLevel accepted but the list did not show yet used to throw "verification failed", making the agent retry and duplicate; it is now returned as `created` with `verified: false` and a do-not-recreate warning (it only throws when no post id came back). `MCP_INSTRUCTIONS` says to check `list_social_posts` before retrying. Deletes: Render logs showed `delete_social_post` failing upstream with `400: input must be a 24 character hex string` because the agent passed something other than a post `_id`; the id is now validated first with guidance. `delete_social_post` is still owner/admin-only.

Version **3.14.2** fixes `update_social_post` failing roughly half the time (24 of 45 audited calls). Reproduced live through ChatGPT against a test draft: HighLevel's edit endpoint is not a partial update -- sending only the changed field returns `422: accountIds must be an array with Account IDs; accountIds should not be empty; ... media must be an array`. `updateSocialPost` now loads the post as it is, overlays the requested changes, and PUTs the complete body (media normalized to `url`/`type`/`caption`, read-only `createdBy`/`scheduleTimeUpdated` dropped, `scheduleTimeUpdated: true` when the schedule changes), so the agent can still change one field at a time.

Version **3.14.3** finishes the `update_social_post` fix after a live retry of 3.14.2 got further and hit a second 422: `postApprovalDetails.property approverUser should not exist; userId must be a string; userId should not be empty`. The post HighLevel returns carries read-only extras it will not accept back and no `userId`. Updates now keep only the writable `approver` inside `postApprovalDetails` (and only for `in_review` posts), fall back to the post's own / the tenant's default `userId`, and -- because other read-only fields may exist -- parse any `... property X should not exist` 422, drop that property and retry (up to 4 times). The same live run also showed the 3.14.1 duplicate guard working: `create_social_post` returned `skipped_duplicate` for an already-created draft.

Version **3.14.4**: the live run of 3.14.3 showed `update_social_post` working but the stored post's `platform` flipping from facebook to google. Cause: the update re-sent the empty detail objects the stored post carries for platforms it is not on (`gmbPostDetails`, `tiktokPostDetails`, `instagramPostDetails`), which HighLevel read as a Google post. Updates now keep only the `*PostDetails` belonging to the platforms of the post's own accounts (`PLATFORM_DETAIL_FIELDS`), plus whatever the caller explicitly passes.

Version **3.14.5** fixes the remaining duplicate-post path, found from Render logs after 3.14.1 did not stop it: `Post creation returned no post id and could not be found in the list for linkedin accounts`. For LinkedIn, HighLevel accepts the post but returns no post id and the post list does not show it right away; the code threw, the agent retried, and the list-based duplicate check (blind to that post) allowed a second create. Now, once HighLevel has accepted a POST, `createSocialPost` never throws -- it reports `created` with `verified: false` and a do-not-recreate warning (and re-checks the list once after 1.5s). Each create is also remembered in memory per tenant for 10 minutes by content fingerprint, so an identical retry returns `skipped_duplicate` even when the list cannot see the post. In-memory only (single Render instance, lost on restart).

Version **3.15.0** adds agent-vs-manual performance tracking. HighLevel cannot tell an API-created post from one made by hand (both are `source: "composer"` by the same user), so `create_social_post` now records each created post's id in `agent_posts` (migration `012_agent_posts.sql`, best-effort, fire-and-forget like usage counting). New tool `get_agent_post_performance` (read-only; optional `fromDate`/`toDate`, default last 30 days) lists published posts across the tenant's active accounts, treats ids found in `agent_posts` as agent posts and the rest as manual, and returns post count, total and average engagement (likes + shares + comments from each post's `insights`), top 3 posts, overall and per platform. Only posts created after this version are tracked; earlier agent posts count as manual. New tool = schema change, so connected customers must disconnect/reconnect to see it.

Version **3.15.1** lowers the video limit for `upload_media` from 500 MB to **100 MB** (`VIDEO_MAX_MB` env var overrides; images stay 25 MB). A file supplied by ChatGPT is read fully into server memory and then copied into a `Blob`, and the host has roughly 512 MB, so one large video could crash the service for every tenant. The tool exists for media ChatGPT itself generates (customers upload their own files directly into the media library), so large files are not a real use case; an oversize file is refused from its `content-length` before the body is read, with a message telling the agent to ask the user to upload it directly. The tool description and `MCP_INSTRUCTIONS` now state this purpose. The `fileUrl` path was never affected (HighLevel fetches that URL itself).


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
3. The customer (now `tenant_owner`) asks the agent to call the `connect_social_account` tool (named `connect_highlevel` before v3.11.0) from inside ChatGPT with the `locationId` of the specific sub-account to connect, opens the returned URL and completes consent. (Equivalent to calling `POST /onboarding/highlevel/start` with `{ "locationId": "..." }` directly, for anything other than ChatGPT.) `locationId` is required — see the 3.5.5 note above for why the OAuth response alone cannot be trusted to name it.
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
8. Confirm `/health` reports version `3.7.0` and does not expose configuration.
9. Complete ChatGPT OAuth and run read-only `list_social_accounts` for `UwsfBVLmz7XSKJbhuOTS`.
10. Attempt the 123 GYM `locationId` with the Testing Agency user and confirm it is blocked before any HighLevel request.
11. Inspect `audit_events` for success/failure records without secrets.
12. Keep production and `main` unchanged.
