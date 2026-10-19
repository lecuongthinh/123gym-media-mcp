# Report gateway (read-only CRM access for ChatGPT / Claude)

Version 3.16.0 adds `src/report/`: a **separate** MCP endpoint (`/report/mcp`) that lets a customer's
ChatGPT or Claude read their own sub-account, with **permissions an Uplifting admin approves per
customer and per role** in a dashboard (`/report-admin`). It shares the Render service, Supabase
project and credential encryption key with Uplifting Social AI, but has its own HighLevel Marketplace
app, tables (`report_*`), OAuth server and routes, and does not touch the posting code. Reports
themselves are *not* built here: customers' skills/GPT instructions combine the generic read tools.

Off unless `REPORT_ENABLED=true`. Unsetting it makes every `/report*` route answer 404 (kill switch).

## What is enforced where

| Layer | Enforced by |
|---|---|
| Read-only | The Marketplace app only declares `*.readonly` scopes; no tool writes. |
| Which customer data | Every call is bound to the signed-in person's own `location_id`; tools take no `locationId`. |
| Which packs a customer may use | Dashboard master switch (`report_pack_grants`). New installs start **pending** with nothing enabled. |
| Which packs a role may use | Dashboard role matrix (`report_role_packs`), defaults in `src/report/packs.js`. Needs **both** to allow. |
| Revocation | Tokens are re-checked against the database on every call; revoking a person or suspending a customer takes effect immediately and blocks refresh. |
| Audit | `report_audit`: who, tool, pack, result. Never tokens or customer data (only argument *names*). |
| Data minimisation | Email/phone masked unless `includePii:true`; summary tools aggregate on the server; message previews off by default. |

Packs: `contacts`, `opportunities`, `conversations`, `calendar`, `payments`, `custom_objects`, `social_planner`.
Tool and pack names are a public contract (customers' skills call them, ChatGPT caches schemas): add, never rename.

## Setup (once)

1. **Create the Marketplace app** (cannot be scripted): developer.gohighlevel.com → new app, type **Sub-Account**,
   *Who can install = Everyone*, redirect URL `https://<host>/report/oauth/callback`. Tick **only** the scopes listed in
   `/report-admin/setup` (all `.readonly`). Keep it separate from the "Uplifting Social AI" app.
2. **Migration:** `npm run migrate` (applies `013_report_gateway.sql`; it is additive).
3. **Render env vars** (names only; put values in Render, never in Git):

   | Var | Purpose |
   |---|---|
   | `REPORT_ENABLED=true` | turns the module on |
   | `REPORT_GHL_CLIENT_ID`, `REPORT_GHL_CLIENT_SECRET` | the new app's credentials |
   | `REPORT_GHL_REDIRECT_URI` | `https://<host>/report/oauth/callback` |
   | `REPORT_GHL_VERSION_ID` | optional: the app's version id for the consent URL |
   | `REPORT_ADMIN_EMAILS` | comma list of dashboard admins |
   | `REPORT_SESSION_SECRET` | 32+ random chars (`openssl rand -hex 32`) |
   | `REPORT_ADMIN_WEBHOOK_URL` | optional; falls back to `HIGHLEVEL_INVITE_WEBHOOK_URL` (the existing "send email" workflow) |
   | `REPORT_ALLOWED_REDIRECT_HOSTS` | optional extra OAuth redirect hosts |
   | `REPORT_RATE_LIMIT_PER_MINUTE` | optional, default 60 per customer |
   | `REPORT_GHL_API_VERSION` | optional, default `v3` (see "Not verified") |

   Already required by the posting app and reused: `MCP_RESOURCE_URL`, `TENANT_CREDENTIAL_ENCRYPTION_KEY`, `DATABASE_URL`.
4. `npm run check:config` shows what is missing (names only). `/health` adds `"report":"enabled"` when on.

## Onboarding a customer

1. Customer adds `https://<host>/report/mcp` as a custom connector (ChatGPT: Developer mode → Settings → Apps → Create;
   Claude: Settings → Connectors → Add custom connector) and signs in as their CRM admin → customer appears as **Chờ duyệt**.
2. In `/report-admin` open the customer, choose a preset (or tick packs) and **Duyệt**. Adjust the role matrix if needed.
3. Staff who are not CRM admins cannot authorize the app themselves: create an **access code** (email + role) in the
   customer page; they choose "Dùng mã truy cập" when connecting. Codes are single-use, 7 days, shown once, stored hashed.
4. Skills should call `get_my_permissions` first and tell the user which pack is off instead of trying to work around it.

## Running on the same service as the posting app

If the report module shares a Render service with Uplifting Social AI, these limit how far one can hurt the other
(they reduce the risk, they do not remove it: both still share one process and one deploy):

- **Bulkhead:** at most `REPORT_MAX_CONCURRENT` (default 6) report tool calls run at once, `REPORT_MAX_QUEUE`
  (default 20) wait; beyond that the call is refused at once with "hệ thống đang bận". Slow upstream calls cannot take every slot.
- **Pause switch:** `/report-admin` has "Tạm dừng tất cả". It stops every tool call within ~5 s without a deploy
  (stored in `report_settings`; sign-in and the dashboard keep working). Resume the same way.
- **Kill switch:** `REPORT_ENABLED` unset/false makes every `/report*` route 404 (needs a redeploy).
- **Graceful shutdown:** on SIGTERM the server stops taking connections and lets in-flight requests finish (up to 25 s)
  before exiting, so a deploy does not cut a post or upload in half.
- **CI (optional):** `docs/github-actions-test.yml` runs `npm test`. Add it as `.github/workflows/test.yml` through the GitHub web UI (the push token used here has no `workflow` scope), then in Render set Auto-Deploy to *After CI checks pass* so a failing test never deploys.
- A report-side failure is contained to `/report*` (errors answer 500 for those paths only; the module is mounted before the posting routers).

### Safe rollout order (one change per deploy)

1. Deploy this code with **no** `REPORT_*` variables. Behavior is unchanged; confirm `/health` shows version 3.16.0 and posting still works.
2. Run `npm run migrate` (013 is additive).
3. Add the `REPORT_*` variables (this triggers one more deploy), confirm `/health` shows `"report":"enabled"`.
4. Install on a test sub-account, approve in `/report-admin`, call each pack.
5. Only then onboard a customer. Roll back any step with Render's rollback, or pause from the dashboard.

## Local preview

`node scripts/report-dev.js` serves the dashboard on http://localhost:4010/report-admin/login with seeded in-memory data
(no database, no HighLevel). `npm test` runs `report.test.js` (fake HighLevel + in-memory store, ~12 end-to-end cases).

## Limits and not verified

- **Postgres store is not exercised by the tests** (they use the in-memory store with identical methods). Run
  `npm run migrate` on staging and walk one install + approve + tool call before relying on it.
- **HighLevel endpoints and the `Version` header were written from HighLevel's docs and have not been called live.** The
  client defaults to `Version: v3` (what the posting app already uses for Social Planner) and retries once with
  `2021-07-28` if HighLevel's error names the header. The custom-object schema list (`GET /objects/`) is the least certain
  path. Smoke-test each pack against a real sub-account.
- Only per-sub-account installs are supported; an agency-wide (company) grant is refused with a clear message.
- One tenant = one sub-account (a customer with several branches installs once per branch).
- Dashboard sign-in needs the email webhook; without it nobody can log in (except `REPORT_DEV_LOGIN=true` outside production).
- In-memory rate limit, single instance, like the posting app.
