# SetterFi setup manual

This is the operator and contractor manual for standing up every external system SetterFi depends
on: the environment itself, GoHighLevel, Meta (Facebook, Instagram, WhatsApp), A2P 10DLC for SMS,
Stripe, and Google Calendar. It is written for someone with no prior context on the project, and it
assumes access to the deployment configuration and to the client's provider accounts.

Two rules run through the whole document. First, **environment variable values never appear here,
and never should**. Names only. Every value is typed straight into the deployment configuration, and
a value that transits a chat transcript, a ticket, a commit, or a shared document is a value that
has to be rotated. Second, **every provider claim carries the URL it was read from and the date it
was read**. Where a claim could not be verified against provider documentation, it is labelled
unverified rather than smoothed over. Model recall is not a source for a provider fact.

Related documents: [docs/ENGINEERING-BRIEF.md](ENGINEERING-BRIEF.md) for what the product is,
[docs/ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together,
[docs/BACKEND-SPEC.md](BACKEND-SPEC.md) for the data model and API contracts,
[docs/PRODUCT.md](PRODUCT.md) for every surface and its actions,
[docs/CONTEXT.md](CONTEXT.md) for the external clocks and the account model,
[docs/META-APP-REVIEW-PACKAGE.md](META-APP-REVIEW-PACKAGE.md) for the Meta App Review filing,
[docs/LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md) for the go-live gate, and
[docs/operations/README.md](operations/README.md) for the running operations material.

---

## Chapter 1. Environment

### 1.1 The environment policy

There is **one environment**. Work ships to `main` and deploys to the single `setter-fi` Vercel
project. There is no staging project, no preview tier that anybody treats as authoritative, and no
Supabase branch environment: **one Supabase project serves both local development and production**,
so every migration is a production migration and must be treated as one.

What makes that safe is the flag discipline. **New backend behaviour lands behind environment
flags**, off by default, so a deployment changes nothing for the client until somebody explicitly
turns the flag on. Several flags do not merely change behaviour behind a route, they change whether
the route exists at all: the Google Calendar routes answer 404 while their flag is unset, and so do
both GoHighLevel install callbacks.

**Demos run on a seeded test tenant whose rows are excluded from analytics.** Anything created for
testing carries `is_test` end to end, and production analytics provably excludes it. There are tests
that pin this; keep them green.

One consequence of a single environment worth stating plainly: the build gate
(`scripts/verify-env-contract.mjs`, run by `npm run build`) evaluates the variable set at build time,
and `NEXT_PUBLIC_*` values are inlined into the bundle at build time. Set the variable, then
redeploy, and read the build log for the verifier's output.

### 1.2 Repository setup

```
git clone <repo>  &&  cd SetterFi
cp .env.example .env.local        # fill from the Vercel project configuration
npm install
npm run verify                    # typecheck + lint + tests, must pass clean before you start
npm run dev
```

- Node 22 or newer. Continuous integration runs 22, Vercel runs 24. Package manager is npm.
- Tests are Vitest. `npm test` runs the unit and integration suite; `npm run verify` runs typecheck,
  lint, and both test projects and is the gate to use before pushing.
- `npm run db:migrate` applies migrations (`supabase migration up --include-all`). Migrations live in
  `supabase/migrations/*.sql` and must be reproducible from a clean database. Never edit a shipped
  migration, always add a new one.
- `--include-all` is load-bearing, not decoration. Without it the CLI applies only migrations newer
  than the last one recorded in `supabase_migrations.schema_migrations`, and silently skips any file
  whose timestamp sits below that mark. Two people working in parallel produce that gap routinely:
  on 2026-09-03 `20261012000002` was applied while `20261012000001` was still pending, so the
  earlier file now has to go in behind it. Keep the flag on any command that applies migrations,
  and read the applied list rather than the directory listing when you need to know what has run.
- `npm run test:rls:clean` resets the local database and runs the row-level-security suite against
  it. A change that ships a migration should run this before it is considered done. `npm run
  test:rls` runs the same suite without the reset, and residue from earlier seeds can fail it; a
  red result there is only real if it reproduces after the reset.
- `npm run build` runs the first-customer environment verifier and then `next build`.

TypeScript is strict, and zod validates at every boundary: webhook payloads, API bodies, offer-layer
writes. One integration client per provider under `src/lib/integrations/`, never raw fetch
calls to providers scattered through routes. Webhooks verify the signature, return 200 in under a
second, and do the work in `waitUntil`, with idempotency keys everywhere. Every privileged mutation
writes an `audit_log` row, and where the interface says "Logged", the backend logs it.

### 1.3 The driver selector convention

Every provider integration is selected by an explicit environment variable rather than inferred from
context. The selector names all end in `_DRIVER`, and the rule is enforced in one place,
`driverSelection` at `src/lib/env-contract.ts:528`.

The behaviour, exactly as implemented:

- Value `real` selects the real provider arm (`src/lib/env-contract.ts:543`).
- Value `mock` selects the deterministic mock arm, **except under `NODE_ENV=production`, where it
  throws** `DriverConfigurationError` (`src/lib/env-contract.ts:538-539`). A global selector has no
  authoritative tenant context, so a production process is never allowed to turn provider work into
  fake success.
- **Any other value, including unset, throws** `DriverConfigurationError`
  (`src/lib/env-contract.ts:544`). There is no default arm. A missing selector fails loudly at the
  first call rather than quietly picking one.

A second helper, `requireEnvironment` at `src/lib/env-contract.ts:547`, throws the same error naming
the missing variables when a real arm is selected without its credentials. The error carries variable
names and never values.

The selectors in use: `SETTERFI_GHL_DRIVER`, `SETTERFI_OPENROUTER_DRIVER`, `SETTERFI_META_DRIVER`,
`SETTERFI_NOTION_DRIVER`, `SETTERFI_EMBEDDINGS_DRIVER`, `SETTERFI_GHL_PROVISIONING_DRIVER`,
`SETTERFI_STRIPE_DRIVER`, `SETTERFI_EMAIL_DRIVER`.

Phase flags are a separate mechanism and follow a different rule: they are read as exactly the
string `true` and are otherwise off, and a child flag reads its parent first. Turning a child on
without its parent does nothing.

### 1.4 Environment variable names

This section is the single source for variable **names**. It follows the grouping in `.env.example`.
Nothing here carries a value, and nothing should be added here that does.

**Core platform and access**

| Name | Intent |
|---|---|
| `SHADCNBLOCKS_API_KEY` | Premium component registry access at install time |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL, browser-visible |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key, browser-visible |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key for jobs and webhooks, guarded at every call site |
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI authentication for migrations |
| `SUPABASE_DB_PASSWORD` | Direct Postgres password used by migration tooling |
| `SETTERFI_ACCESS_PASSWORD` | The shared access gate wrapping the deployment before real auth |
| `SETTERFI_AUTH_MODE` | Which authentication mode the app runs in |
| `APP_BASE_URL` | Absolute base URL used when building links in notifications and checkout |
| `CRON_SECRET` | Authenticates scheduled job routes |

**The demo sign-in exception.** `SETTERFI_DEMO_LOGINS`, `SETTERFI_DEMO_LOGIN_PASSWORD`, and
`SETTERFI_PRODUCTION_DEMO_LOGINS` drive the one-click demo sign-in buttons on `/login`. Those buttons
ship real working credentials in server-rendered HTML, so they must stay unset anywhere a real coach
can reach. While the deployment doubles as the review build, the exception requires
`SETTERFI_DEMO_LOGINS`, `SETTERFI_PRODUCTION_DEMO_LOGINS`, a configured
`SETTERFI_DEMO_LOGIN_PASSWORD`, and `SETTERFI_ACCESS_PASSWORD` together, and the production
environment validator rejects partial combinations. Never commit either password. **Before
first-customer access: disable both demo flags, remove the demo password, redeploy, rotate or delete
the demo identities, revoke their sessions, and confirm the shortcuts are gone from `/login`.**

**Secrets used for hashing and encryption**

| Name | Intent |
|---|---|
| `SETTERFI_TAG_SECRET` | Signs tags so a client-supplied value cannot be forged |
| `SETTERFI_SUPPRESSION_PEPPER` | Peppers suppression-list hashes |
| `SETTERFI_CREDENTIAL_ENCRYPTION_KEY` | Encrypts stored provider credential envelopes |

**Provider credentials**

| Name | Intent |
|---|---|
| `GHL_CLIENT_ID` / `GHL_CLIENT_SECRET` | App 1 OAuth client pair |
| `GHL_WEBHOOK_PUBLIC_KEY` | Ed25519 verification key for `X-GHL-Signature`, published in provider docs |
| `GHL_AGENCY_CLIENT_ID` / `GHL_AGENCY_CLIENT_SECRET` | App 2 OAuth client pair |
| `GHL_AGENCY_ACCESS_TOKEN` | Bootstrap-only agency token, ignored once a stored install exists |
| `GHL_AGENCY_COMPANY_ID` | The client's agency company identifier, returned on the token response |
| `GHL_INSTALL_URL` / `GHL_AGENCY_INSTALL_URL` | Portal-issued install links for app 1 and app 2 |
| `GHL_SNAPSHOT_ID` | Snapshot pushed onto each new coach sub-account |
| `GHL_NUMBER_POOL_ID` | Number pool a coach's phone number is bought from |
| `OPENROUTER_API_KEY` | Chat completions only, no embeddings endpoint |
| `OPENAI_API_KEY` | Embeddings only, used by brain sync |
| `NOTION_API_KEY` / `NOTION_KB_ROOT_ID` / `NOTION_EXPORT_PATH` | Knowledge base sync |
| `META_APP_ID` / `META_APP_SECRET` | Meta app credentials for OAuth and webhooks |
| `META_LOGIN_CONFIG_ID` | Facebook Login configuration used by the coach connect flow |
| `META_SYSTEM_USER_TOKEN` | Platform-owned Meta operations |
| `META_WEBHOOK_VERIFY_TOKEN` | Webhook subscription handshake |
| `META_WHATSAPP_SYSTEM_USER_TOKEN` / `META_WABA_ID` / `META_WHATSAPP_PHONE_NUMBER_ID` | WhatsApp sender |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Billing |
| `RESEND_API_KEY` / `RESEND_WEBHOOK_SIGNING_SECRET` / `SETTERFI_EMAIL_FROM` | Outbound email |
| `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET` | Our own Google Calendar OAuth app |

The backend specification's own table adds three names that are not in `.env.example` today and are
worth knowing about. `SUPABASE_DB_URL` is the direct Postgres connection used by migrations.
`GHL_WEBHOOK_PUBLIC_KEY_PREVIOUS` is accepted alongside the current key during a key rotation overlap
and is empty in steady state. `GHL_WEBHOOK_PUBLIC_KEY_RSA` backed the legacy `X-WH-Signature`
RSA-SHA256 header, which the provider removed on 2026-09-01, so that variable can be dropped.

**Test-resource pins.** The real-provider calendar probe is restricted to an explicitly named test
resource so it can never touch a live coach: `SETTERFI_GHL_TEST_ACCESS_TOKEN`,
`SETTERFI_GHL_TEST_LOCATION_ID`, `SETTERFI_GHL_TEST_CALENDAR_ID`, `SETTERFI_GHL_TEST_CONTACT_ID`.

**Phase and behaviour flags.** Each of these is inert until set to exactly `true`, and a child reads
its parent first.

| Group | Names |
|---|---|
| Phase 1 | `SETTERFI_PHASE1_LIVE`, `SETTERFI_PIPELINE_WRITE_LIVE`, `SETTERFI_BOOKING_CONFIRM_LIVE`, `SETTERFI_APPOINTMENT_LIFECYCLE_LIVE`, `SETTERFI_INBOX_VERBS_LIVE` |
| Phase 2 | `SETTERFI_PHASE2_LIVE`, `SETTERFI_PLATFORM_CONVERSATION_QUEUE_LIVE` |
| Phase 3 | `SETTERFI_PHASE3_LIVE`, `SETTERFI_SUPPRESSION_SYNC_LIVE`, `SETTERFI_CONTACT_DELETE_LIVE` |
| Phase 4 | `SETTERFI_PHASE4_LIVE`, `SETTERFI_CONTACT_MANAGEMENT_LIVE`, `SETTERFI_WHATSAPP_EMBEDDED_SIGNUP` |
| Phase 5 | `SETTERFI_PHASE5_LIVE`, `SETTERFI_SIGNUP_REPAIR_LIVE` |
| Phase 6 | `SETTERFI_PHASE6_LIVE`, `SETTERFI_PHASE6_AFFILIATES_LIVE`, `SETTERFI_PHASE6_STRIPE_LIVE`, `SETTERFI_CHECKOUT_ATTEMPTS_LIVE` |
| Phase 7 | `SETTERFI_PHASE7_LIVE`, `SETTERFI_PHASE7_ANALYTICS_LIVE`, `SETTERFI_PHASE7_EVALS_LIVE`, `SETTERFI_PHASE7_MEET_AGENT_LIVE` |
| Phase 8 | `SETTERFI_PHASE8_LIVE`, `SETTERFI_PHASE8_ALERTS_LIVE`, `SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE`, `SETTERFI_PHASE8_SUPPORT_LIVE`, `SETTERFI_PHASE8_EXPORTS_LIVE`, `SETTERFI_PHASE8_ENGINE_EVAL_LIVE` |
| Phase 9 | `SETTERFI_PHASE9_LIVE`, `SETTERFI_PHASE9_GHL_OAUTH_LIVE` |
| Account and tenancy | `SETTERFI_ACCOUNT_SECURITY_LIVE`, `SETTERFI_ACCOUNT_MFA_LIVE`, `SETTERFI_ACCOUNT_EMAIL_CHANGE_LIVE`, `SETTERFI_ACCOUNT_TERMS_LIVE`, `SETTERFI_TENANT_MEMBERSHIP_LIVE`, `SETTERFI_TENANT_OWNERSHIP_LIVE` |
| Brain and offer layer | `SETTERFI_BRAIN_OBJECTIONS_LIVE`, `SETTERFI_OFFER_LAYER_ENGINE_INPUT_LIVE`, `SETTERFI_TIER_OFFER_TERMS_LIVE` |
| Surfaces and channels | `SETTERFI_PUBLIC_LANDING_LIVE`, `SETTERFI_CAPI_LIVE`, `SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE` |

Three of those deserve a sentence each. `SETTERFI_ACCOUNT_MFA_LIVE` needs
`SETTERFI_ACCOUNT_SECURITY_LIVE` as well. `SETTERFI_ACCOUNT_EMAIL_CHANGE_LIVE` moves only the
application row today and not the Supabase Auth identity, so it stays off until the two stores agree.
`SETTERFI_OFFER_LAYER_ENGINE_INPUT_LIVE` changes agent output for every tenant at once, so switch it
on for a watched tenant first.

**The public marketing site.** `SETTERFI_PUBLIC_LANDING_LIVE=true` makes `next.config.ts` rewrite
`/` to `/site/index.html`, the static scroll-driven site whose source lives in
`scrollcraft/builds/setterfi/` (index, `BRIEF.md`, the engine copy, the `assets/` screenshots). The
served copy under `public/site/` is generated from that build by rewriting the three relative asset
paths to `/site/...`, so every edit to the build has to be copied over again before it ships;
`/site` is a public prefix in `src/lib/auth/claims.ts` so the proxy never asks it for a session.
With the flag off, `/` still renders the React landing page in `src/app/page.tsx`. The site's Sign
in and Get started buttons point at `/login` and `/signup`; its footer links `/privacy` and
`/terms`, which do not exist yet and are required before the Google Calendar OAuth verification is
filed.

**Placeholder copy markers.** Every `SETTERFI_DEMO_PLACEHOLDER_*` name holds unapproved copy carrying
a visible unapproved label, and the real filing paths reject a placeholder outright. They are
`SETTERFI_DEMO_PLACEHOLDER_CONSENT_VERSION`, `_CAMPAIGN_COPY_VERSION`, `_TIER_PRICES`,
`_ALLOWANCE_NOTICE`, `_DISPUTE_PATH`, and `_AFFILIATE_TERMS`.
`SETTERFI_PLATFORM_PREVIEW_DATA` selects the synthetic platform snapshot on any build that also
runs demo logins, production included since 2026-09-04 (the owner reads the console there); real
analytics always reads the `analytics_*` projection and never includes that snapshot. **The flag is
a fork in the read path, not a filter on it.** With it on, `platformMeasurementSource` in
`src/lib/repositories/platform-analytics.ts` calls `read_platform_measurement_preview_for_actor`
and returns a stored snapshot stamped with the caller's as-of instant, so the owner Overview never
reaches the analytics projection at all and nothing seeded, backfilled or corrected in the database
can move a figure on it. That is the first thing to check when a change to the data does not show
up on Overview. It is set to `false` on both the Vercel production and preview environments as of
2026-09-04, so the console reads real analytics on the deployment the owner opens.

**A2P probe pins.** `SETTERFI_A2P_PROBE_TARGET` and `SETTERFI_A2P_PROBE_TARGET_HASH` name the phone
number the readiness probe sends to. See chapter 4.

**The build gate.** `SETTERFI_FIRST_CUSTOMER_ENFORCE` controls what a production build does when a
live flag's provider lacks real credentials. Blank or `true` is the honest default and **fails the
build**. Exactly `false` prints the full missing or invalid list in the build log and lets the build
proceed, which is the current state while the launch credential list is being filled. Deleting the
variable re-arms the gate.

### 1.5 Supabase and Vercel

Vercel: **`setter-fi`, one project.** Supabase: project `setterfi` under the client's organisation,
one project, no branch environment. All third-party accounts are under client ownership per the
contract and are operated via the project email address.

### 1.6 Credential discipline for contractors

Secrets live in the Vercel and Supabase configuration only. Never in the repository, never in a chat
message, never in a commit message. If a secret turns up somewhere it should not be, treat it as
compromised and rotate it.

Least privilege applies to provider access as well. For GoHighLevel, work against a sandbox or test
agency and one test sub-account, and do not touch the client's real agency locations without the
project lead in the loop. For Meta, use test app credentials; the production system-user token is not
a contractor credential. For Notion, the sync pipeline gets a scoped integration token and is tested
against seeded dummy documents rather than the client's real knowledge base. Stripe live keys are not
handed out.

### 1.7 Reseeding the demo data

The demo is written by seeders only. Run them in this order, each one idempotent, against a local
stack after `supabase db reset` or against the hosted project with `--confirm-hosted`:

```bash
node scripts/seed-phase1-demo.mjs
node scripts/seed-phase2-demo.mjs
node scripts/seed-phase5-demo.mjs
node scripts/seed-phase6-demo.mjs --acknowledge-stale-rollups
node scripts/seed-phase7-demo.mjs --acknowledge-stale-rollups
node scripts/seed-phase8-demo.mjs --acknowledge-stale-rollups
node scripts/seed-showcase-leads.mjs --confirm --acknowledge-stale-rollups
node scripts/seed-staging-users.mjs          # --local for the local stack
node scripts/seed-demo-gaps.mjs --confirm --acknowledge-stale-rollups
node scripts/seed-platform-review-data.mjs --confirm --acknowledge-stale-rollups
node scripts/seed-demo-complete.mjs --confirm --acknowledge-stale-rollups
node scripts/run-phase7-demo.mjs --acknowledge-stale-rollups
node scripts/seed-demo-history.mjs --confirm-hosted   # last, and only after the chain above
```

**The history seeder runs last, and the order is a hard requirement rather than a preference.**
`scripts/seed-demo-history.mjs` (added 2026-09-04, `npm run demo:seed-history`) puts the demo
platform on a twelve-month grid: the owner Overview windows all three of its trend series into
twelve contiguous 30-day periods, and every demo tenant had been seeded within the same few weeks,
so signups, active subscriptions and recognised revenue each drew one tall bar at the right edge
with eleven empty ones behind it. The seeder moves `tenants.created_at` for the eight existing demo
tenants onto that grid, upserts the sixteen cohort tenants the curve needs (eight cannot draw
eleven months of growth), opens each subscription's mirrored period at its signup, and writes one
cost rollup per subscribed tenant per period. It **moves** tenants rather than creating them, so a
run against a database where the earlier seeders have not landed exits with
`DEMO_HISTORY_TENANT_MISSING` naming the slugs it could not find. Every tenant it touches is
re-read and refused unless `is_demo` is true whatever the fixture claims, the whole run is one
transaction, and rerunning on the same day writes the same instants. The schedule itself lives in
`scripts/fixtures/demo-history.mjs`, whose header also records the one thing this does not fix: the
phase 6 money story is pinned to absolute 2026 dates and its two newest revenue bars will drift out
of the trailing window as real time passes.

Hosted runs need `SUPABASE_DB_PASSWORD` as well as the service-role key, because phases 5 to 8, the
showcase and the platform-review seeders open a direct Postgres connection. Run them with the
repository's `.env.local` and no stale shell exports (`env -u SUPABASE_SERVICE_ROLE_KEY node
--env-file=.env.local ...`), since a service-role key for another project makes the target check fail
in a confusing way.

**Closed cost months are final.** `tenant_cost_rollups` is append-only and its write function refuses
a differing replay, which is the product's guarantee that a computed month is never quietly
restated. A seeder that finds a closed month holding figures other than the ones it would write
therefore exits 1 and names the tenant, the period and both sets of figures, rolling back everything
else it wrote. `--acknowledge-stale-rollups` downgrades only that check to a printed list; every
other read-back still has to match exactly. On a freshly reset database the flag is inert. The
hosted project holds four such months from before the plan ladder was corrected on 2026-09-02 (the
money-story tenant's July 2026, and August 2026 for the three platform-review tenants); they show on
the admin cost evidence screen at the old figures until a migration adds a way to supersede a closed
month.

**Do not run the reset scripts against populated data.** `reset-platform-review-data.mjs` deletes
from a ledger a trigger makes append-only and stops with `BILLING_CORRECTION_REQUESTS_APPEND_ONLY`;
`reset-phase6-demo.mjs` deletes tier rows that other tenants still reference, so the next phase 5 seed
dies on `tenants_tier_id_fkey`; and `run-phase8-demo.mjs` calls both internally. On a local stack use
`supabase db reset` and reseed. On the hosted project there is no reset; reseeding converges the
existing rows.

---

## Chapter 2. GoHighLevel

### 2.1 Status as of 2026-09-02

**Both marketplace apps exist in the client's developer portal, fully configured.** App 1 and app 2
were created and their portal work was closed on 2026-08-19: names, types, target users, listing
types, redirect URLs, webhook URL and events, scopes, and client key pairs are all in place, and the
four link and credential pairs they produce are stored in the deployment configuration.

**The agency install of app 1 completed on the 2026-09-02 call.** Alec, signed in at agency level,
selected all sub-accounts; the callback consumed its state at 15:48:49 UTC, `audit_log` id 1446
recorded `channel.messaging_install.completed` with `install_target = "company"`, and the `agent`
row in `ghl_agency_installs` is `token_ok` with `install_to_future_locations`,
`approve_all_locations` and `is_bulk_installation` all `true`. That is the section 2.10 pass
condition in full. App 2 was not redone on the call and did not need to be: its company grant from
2026-08-21 is still `token_ok` and refreshing. The answers to section 2.12's three questions are
recorded there.

So: portal configuration is complete, both agency installs hold, the per-location receipts are
waiting on tenant bindings (section 2.12), and the two driver flags stay at `mock` until section 2.13
is proven.

### 2.2 Why two apps

**Two apps, both Private, in the client's own developer account.** The provider forbids a single app
from holding both sub-account scopes and agency scopes, and our code needs both.

App 1, **SetterFi Agent**, is a sub-account-target app that the client's agency bulk-installs across
all current and future coach sub-accounts. It carries the messaging and calendar scopes, owns the
single webhook URL, and produces the Company token we exchange for per-coach Location tokens.

App 2, **SetterFi Provisioning**, is an agency-target app that mints a new coach's sub-account and
pushes the snapshot.

Neither app needs to be published. A Private app is unlisted and installs by opening its OAuth link
directly, so **no provider review sits on our critical path**. The catch that shapes everything else:
**scopes are locked once an app version goes live and can only be edited while it is a draft**, so
the scope list has to be right on the first submission or the fix is a new app version.

The one-app collapse is dead in the agency direction. An Agency-target app cannot hold `oauth.*`,
which are classified as Sub-Account scopes, so it could never mint a Location token. It works only in
the other direction, which is what app 1 already is: a Sub-Account-target app installed at agency
level with bulk install returns a Company token that carries `oauth.*`. That asymmetry is the reason
the split exists.

**Private, not Public.** A Public app needs a demo video covering install, setup, functionality,
third-party auth, error handling, and uninstall, plus screenshots, a short description, privacy
policy and terms URLs, a security contact, and support commitments, and the provider publishes no
review timeline at all. Private caps installs at five agencies, which is irrelevant while SetterFi
serves one. If the client ever resells SetterFi to other agencies, the cap binds at the sixth and the
answer is the written exception request rather than publishing, because publishing would put a
white-label product in a provider-branded marketplace.

### 2.3 App 1 as built, 2026-08-19

| Field | Value |
|---|---|
| App name | `SetterFi Agent` |
| App id | `6a84aa3af974d82d9becb8e8` |
| App type | Private |
| Target user | Sub-Account, **locked, cannot be changed** |
| Who can install | Agency only |
| Listing type | White-label |
| Redirect URL | `https://setter-fi.vercel.app/api/channels/messaging/callback`, added and saved. The default-URL flag is unsettable until the app is approved |
| Webhook URL | `https://setter-fi.vercel.app/api/webhooks/ghl` |
| Webhook events on | `InboundMessage`, `OutboundMessage`, and nothing else |
| Install link | Whitelabel variant on `marketplace.leadconnectorhq.com`, carrying `response_type`, `redirect_uri`, `client_id`, all nine scopes, and `version_id=6a84aa3af974d82d9becb8e8`. Re-captured after the client key was generated, because the first capture predated the key and had no `client_id` |
| Client key name | `setter-fi-production`, marked Default, created 2026-08-19. Exactly one key pair exists, and the reveal modal reopens blank once dismissed, so do not click Add again looking for it |
| Shared secret | Not generated, section empty. Correct: it signs the context handed to an embedded custom page, a surface we do not build |
| Client ID | `6a84aa3af974d82d9becb8e8-msz66emm`, not a secret. Suffix `-msz66emm`; app 2's is `-mszzcwx9`, and the two are near-transposable |
| Client secret | Generated 2026-08-19, shown once, held in the deployment configuration only |
| Scopes (9) | `conversations/message.readonly`, `conversations/message.write`, `calendars.readonly`, `calendars/events.readonly`, `calendars/events.write`, `oauth.write`, `oauth.readonly`, `phonenumbers.read`, `phonenumbers.write` |

Notes that only matter if you are re-creating the app or auditing it:

- **The distribution questions are not on the Auth tab.** Target user and bulk install live on
  Profile, Listing Configuration, and both lock once saved. The target-user question is
  `Sub-account`; the bulk-install question is `Yes`, which is mandatory for new apps, irreversible,
  and exactly the behaviour we want, since one agency install then covers all current and future
  coach sub-accounts.
- **Do not add `contacts.readonly` or `contacts.write`.** No code path calls a contacts endpoint.
  Contacts are local rows plus `contactId` values lifted off inbound webhook payloads, and the
  provider's review guidelines say apps may be rejected for requesting broad or unnecessary
  permissions.
- **`phonenumbers.read` and `phonenumbers.write` on app 1 are harmless but unused.** The purchase
  call is made with app 2's agency token, so the scope is required on app 2. App 1 only ever calls
  `/conversations/messages`, `/oauth/locationToken`, and the `/calendars/*` family.
- **Take the Whitelabel install link, not the Standard one.** The Standard link is on
  `marketplace.gohighlevel.com` and carries the provider's brand in a hostname a coach's browser
  would show. The Whitelabel variant is on `marketplace.leadconnectorhq.com`.
- **Client keys are generated under MANAGE, Secrets, Client keys, Add.** They do not exist until you
  do that, and they are not on the Auth tab. The secret is shown once. Copy it from the browser
  straight into the deployment configuration.
- **The webhook verification key is not issued to us.** Both verifying public keys are published in
  full in the provider's own webhook integration guide. Copy the Ed25519 one, the key paired with
  `X-GHL-Signature`, into `GHL_WEBHOOK_PUBLIC_KEY`.
- **The redirect URL's default-flag radio is refused** with "Cannot set default redirect URL on non
  approved apps". Its tooltip says an unset default lands the user on the marketplace screen after
  install. Our flow always passes an explicit `redirect_uri` and every callback path ends in a 303
  back to a SetterFi route, so the default should only govern an install started from a marketplace
  listing, a path we do not offer. Unproven either way, and app 2 hits the same refusal.

### 2.4 App 2 as built, 2026-08-19

| Field | Value |
|---|---|
| App name | `SetterFi Provisioning` |
| App id | `6a85838d69e42818e09c62b3` |
| App type | Private |
| Target user | Agency, **locked** |
| Who can install | Agency only |
| Listing type | White-label |
| Redirect URL | `https://setter-fi.vercel.app/api/channels/messaging/agency-callback`, saved. Default flag approval-gated exactly as on app 1 |
| Webhook | None, verified programmatically: default URL empty, all 68 toggles off, all 68 custom URL fields blank |
| Client key name | `setter-fi-provisioning`, created 2026-08-19, self-assigned as Default because the first client key on an app takes the Default radio |
| Client ID | `6a85838d69e42818e09c62b3-mszzcwx9`, not secret |
| Client secret | Generated 2026-08-19, shown once, in the deployment configuration only |
| Scopes (4) | `locations.write` (the only one raising the sensitive-scope dialog), `locations.readonly`, `snapshots.readonly`, `phonenumbers.write` |

Two things about app 2's scope list that will otherwise be re-litigated later.

**`oauth.write` and `oauth.readonly` are not on app 2, and that is the design.** They are classified
as Sub-Account scopes, so an Agency-target app cannot hold them: they are absent under the default
filter, appear only once "Show unavailable" is toggled, and render locked. The picker header states
the rule outright, and the Agency-available picker is 24 scopes across 11 categories with no OAuth
category at all. App 2 does not need them. The only `/oauth/` call in the adapter is
`POST /oauth/locationToken`, which sends app 1's client id, so location-token minting already runs on
app 1's credentials and app 1's agency grant. The provisioning driver touches exactly two endpoints,
`POST /locations/` and `GET /snapshots/snapshot-status/...`, and no `/oauth/` path.
`GHL_AGENCY_CLIENT_ID` and `GHL_AGENCY_CLIENT_SECRET` are used for app 2's own token exchange and
refresh, which are protocol calls authenticated by the client secret rather than scoped API calls.

**`phonenumbers.write` belongs on app 2, and an earlier version of this runbook had it backwards.**
`purchaseOrFindNumber` lives on the provisioning driver and authenticates with app 2's agency access
token, so the purchase call needs the scope on app 2.

App 2 carries no webhook URL. **One receiver, on app 1.**

### 2.5 Redirect URIs and webhook settings

| Purpose | URL |
|---|---|
| App 1 redirect | `https://setter-fi.vercel.app/api/channels/messaging/callback` |
| App 2 redirect | `https://setter-fi.vercel.app/api/channels/messaging/agency-callback` |
| Webhook receiver (app 1 only) | `https://setter-fi.vercel.app/api/webhooks/ghl` |

Redirect URLs must be HTTPS, on a verified domain, and production-stable. Both callback routes exist
in the repository and return 404 until both Phase 9 flags are exactly `true`.

Webhook events toggled on: `InboundMessage` and `OutboundMessage`, and nothing else.
`AppInstall` and `AppUninstall` **are not in the event picker at all**. Checked live on 2026-08-19:
the picker holds 68 events, every one an entity event, and searching it for "install" returns "No
Data". There is no app-lifecycle section. So the two lifecycle events cannot be subscribed to, and
whether they are delivered anyway is unverified. Do not go looking for the toggles and do not treat
their absence as a misconfiguration.

The webhook URL keeps its `/ghl` path deliberately. The white-label naming rule is about what a
coach's browser shows, and a provider-to-server webhook is never in an address bar. Webhook URL and
event toggles can be changed after an app is live, unlike scopes.

Signature verification reads `x-ghl-signature` first and falls back to `x-wh-signature`, and
verifies against the raw request bytes rather than a re-serialised body. `X-GHL-Signature` is Ed25519
over the raw body, base64-encoded. `X-WH-Signature` was the legacy RSA-SHA256 header and was removed
on 2026-09-01, so `GHL_WEBHOOK_PUBLIC_KEY` must hold the Ed25519 key.

### 2.6 What the code calls

| Capability | Endpoint | `Version` sent | Scope | Token type |
|---|---|---|---|---|
| Send a message to a lead | `POST /conversations/messages` | `2021-04-15` | `conversations/message.write` | Location |
| Mint a coach's Location token | `POST /oauth/locationToken` | `2021-07-28` | `oauth.write` | Company access token, not a Private Integration Token |
| Create a coach's sub-account | `POST /locations/` | `2021-07-28` | `locations.write` | Company |
| Poll snapshot push status | `GET /snapshots/snapshot-status/{snapshotId}/location/{locationId}` | `2021-07-28` | `snapshots.readonly` | Company |
| Buy a coach's phone number | `POST /phone-system/numbers/location/{locationId}/purchase` | `2021-07-28` | `phonenumbers.write` | Agency token |
| Fetch free calendar slots | `GET /calendars/{calendarId}/free-slots` | `2021-04-15` | `calendars.readonly` | Location |
| Book an appointment | `POST /calendars/events/appointments` | `2021-04-15` | `calendars/events.write` | Location |
| Reschedule an appointment | `PUT /calendars/events/appointments/{eventId}` | `2021-04-15` | `calendars/events.write` | Location |
| Cancel an appointment | `DELETE /calendars/events/{eventId}` | `2021-04-15` | `calendars/events.write` | Location |
| Reconcile appointments | `GET /calendars/events` | `2021-04-15` | `calendars/events.readonly` | Location |

Everything is API v2 against `https://services.leadconnectorhq.com`, with date-based `Version`
headers, which remain fully supported.

Two things are still unverified in this table and fail closed rather than guessing. The
`snapshot-status` response body shape is inherited from our own mock, so an unrecognised envelope
raises `GHL_SNAPSHOT_STATUS_RESPONSE_UNVERIFIED` (`src/lib/integrations/ghl.ts:532`) and blocks the
onboarding lane by name instead of normalising an unknown body into "ready". And the literal
`messageType` strings for Instagram and Facebook are assumed to be `"IG"` and `"FB"`; the provider
documents only `SMS`, `CALL`, and `Email` and publishes no example for the DM channels, so a
different real string throws `GHL_INBOUND_CHANNEL_UNSUPPORTED`
(`src/lib/integrations/ghl.ts:136`) on the product's primary channel. Both are settled by one real
call, and section 2.12 says where to record the answers.

### 2.7 Verified claims

Fetched from the provider's live documentation on **2026-08-18** unless a later date is given.

| # | Claim | Source and read date |
|---|---|---|
| 1 | App creation fields are App Name, App Type (`Private`/`Public`), Target User, Who Can Install, Listing Type. Private apps are unlisted and go live immediately; Public apps are installable by all users once approved. | https://marketplace.gohighlevel.com/docs/oauth/CreateMarketplaceApp, 2026-08-18 |
| 2 | Distribution asks three questions: target user (`Agency`/`Sub-account`, cannot be modified once set), who can install (`Both Agency and Sub-account`/`Agency Only`), and bulk install by agencies (mandatory `Yes` for new apps, irreversible). | https://marketplace.gohighlevel.com/docs/oauth/AppDistribution, 2026-08-18 |
| 3 | Sub-account-target apps must not require agency-level access such as `companies.readonly`, `companies.write`, `location.write`, `saas/location.write`, `snapshots.readonly`, `snapshots.write`, `custom-menu-link.readonly`, `custom-menu-link.write`. | https://marketplace.gohighlevel.com/docs/oauth/AppDistribution, 2026-08-18 |
| 4 | Sub-account target plus bulk install `Yes` plus an agency installing yields a token with `"isBulkInstallation": true` and `"userType": "Company"`. The provider labels this shape new and recommended. | https://marketplace.gohighlevel.com/docs/oauth/AppDistribution, 2026-08-18 |
| 5 | A Private app may be installed in up to 5 agencies; at 6 or more, new installs are blocked while existing installs keep working. One agency counts once regardless of sub-account count, and limits apply per App ID across versions. Effective for apps created on or after 18 November 2025. | https://marketplace.gohighlevel.com/docs/MarketplacePolicies/PrivateAppInstallLimits, 2026-08-18 |
| 6 | The install URL is read from the app's Auth pane, Install Link, Show. There is no longer a constructable authorize URL in the docs. Standard and whitelabel variants are offered. | https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0, 2026-08-18 |
| 7 | The token endpoint is `POST https://services.leadconnectorhq.com/oauth/token`, accepting JSON or form encoding, with `client_id`, `client_secret`, `grant_type`, `code`, `user_type`, `redirect_uri`. No `Version` header appears in any documented example. | https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0, 2026-08-18 |
| 8 | `user_type` values are exactly `Company` and `Location`; the response field is `userType`. | https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0 and .../TargetUserSubAccount, 2026-08-18 |
| 9 | `POST /oauth/locationToken` takes form encoding, `Version: 2021-07-28`, a bearer agency access token, and a body of `companyId` plus `locationId`; it returns `access_token`, `token_type`, `expires_in` (86400), `refresh_token`, `scope`, `userType: "Location"`, `companyId`, `locationId`, `userId`, `traceId`. | https://marketplace.gohighlevel.com/docs/Authorization/TargetUserSubAccount, 2026-08-18 |
| 10 | Access tokens expire in roughly 24 hours. Refresh tokens are valid one year or until used: using one invalidates the original and returns a new one. | https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0 and .../oauth/Faqs, 2026-08-18 |
| 11 | Rate limits are 100 requests per 10 seconds burst and 200,000 per day, for each marketplace app per resource. Returned headers: `X-RateLimit-Limit-Daily`, `X-RateLimit-Daily-Remaining`, `X-RateLimit-Interval-Milliseconds`, `X-RateLimit-Max`, `X-RateLimit-Remaining`. | https://marketplace.gohighlevel.com/docs/oauth/Faqs, 2026-08-18 |
| 12 | The header is `Version`, specified per request. Supported values are `v3` (released 11 June 2026), `2023-02-21`, `2021-07-28`, `2021-04-15`, and `legacy`, with every "Supported Until" listed as TBD. | https://marketplace.gohighlevel.com/docs/Versioning, 2026-08-18 |
| 13 | Webhooks are configured per app under Advanced Settings, Webhooks, with one URL per app and a toggle per event. | https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0, 2026-08-18 |
| 14 | Scopes can only be changed while an app version is a draft; once live they are locked. Webhook endpoints and subscribed events can be modified at any time, including on a live version. | https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide, 2026-08-18 |
| 15 | Install and uninstall payload `type` values are the literal strings `"INSTALL"` and `"UNINSTALL"`, while the documentation and portal event names are `AppInstall` and `AppUninstall`. | https://marketplace.gohighlevel.com/docs/webhook/AppInstall, .../AppUninstall, .../WebhookLogsDashboard, 2026-08-19 |
| 16 | Agency-level install payloads carry `companyId` and omit `locationId`; location-level payloads carry both. The uninstall schema is only `type`, `appId`, `companyId`, `locationId`. | https://marketplace.gohighlevel.com/docs/webhook/AppInstall and .../AppUninstall, 2026-08-19 |
| 17 | "If a webhook URL is configured for your app, this [App Install] event is subscribed to by default." | https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0, 2026-08-18 |
| 18 | `X-GHL-Signature` is Ed25519, base64. `X-WH-Signature` is the legacy RSA-SHA256 header, deprecated 1 September 2026. Both verifying public keys are published in full PEM form; there is no per-app webhook signing key. | https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide, 2026-08-18 |
| 19 | The provider signs the raw JSON request body, the same bytes in the POST, and instructs reading the raw body as UTF-8 before parsing. There is no timestamp header; deduplicate on the body's `webhookId`. | https://marketplace.gohighlevel.com/docs/webhook/ProviderOutboundMessage and .../WebhookIntegrationGuide, 2026-08-18 |
| 20 | Scope to webhook mapping: `conversations/message.readonly` yields InboundMessage and OutboundMessage; `conversations.readonly` yields ConversationUnreadWebhook; `locations.readonly` yields LocationCreate and LocationUpdate. AppInstall and AppUninstall list no scope. | https://marketplace.gohighlevel.com/docs/Authorization/Scopes, 2026-08-18 |
| 21 | Retries: up to 12 excluding the original, exponential backoff with jitter, triggered by any non-2xx or no response. Return 2xx even for processing errors. Logs are retained 30 days. | https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide and .../WebhookLogsDashboard, 2026-08-18 |
| 22 | Circuit breaker: roughly every 3 days, URLs receiving more than 10,000 webhooks in the trailing window with under 90% success get a warning, and a second consecutive failure pauses delivery. Re-enabling is manual from the marketplace dashboard. | https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide, 2026-08-18 |
| 23 | Documented `InboundMessage` `messageType` values are `"SMS"`, `"CALL"`, `"Email"`, with `messageTypeString` carrying `"TYPE_SMS"`, `"TYPE_CALL"`, `"TYPE_VOICEMAIL"`. Payload fields include `webhookId`, `type`, `locationId`, `contactId`, `conversationId`, `messageId`, `body`, `direction`, `status`, `dateAdded`, `from`, `to`, `attachments`, and there is no `phone` or `email` field. | https://marketplace.gohighlevel.com/docs/webhook/InboundMessage, 2026-08-18 |
| 24 | There is no message-delivery-status webhook. Status flows outbound only, via `POST /conversations/messages/status`, and only a conversation-provider app's token may write it. | https://marketplace.gohighlevel.com/docs/marketplace-modules/ConversationProviders, 2026-08-18 |
| 25 | Verbatim scope strings and access types: `locations.write`, `oauth.readonly`, `oauth.write`, `snapshots.readonly`, `snapshots.write` are Agency; `conversations/message.write`, `conversations/message.readonly`, `calendars.readonly`, `calendars/events.readonly`, `calendars/events.write`, `contacts.readonly`, `contacts.write`, `locations.readonly`, `phonenumbers.read`, `numberpools.read` are Sub-Account. | https://marketplace.gohighlevel.com/docs/Authorization/Scopes, 2026-08-18 |
| 26 | `POST /oauth/locationToken` and `GET /oauth/installedLocations` are agency-access-only and require an access token generated with user type Agency, explicitly not a Private Integration Token. They are renamed in v3 to `/oauth/location-token` and `/oauth/installed-locations`. | GoHighLevel/highlevel-api-docs `apps/oauth.json` and `apps/v3/oauth-v3.json` at `0af86a4`; https://marketplace.gohighlevel.com/docs/ghl/oauth/get-location-access-token, 2026-08-18 |
| 27 | Appointment deletion is `DELETE /calendars/events/{eventId}`. No `DELETE /calendars/events/appointments/{eventId}` path exists in the calendars spec. | GoHighLevel/highlevel-api-docs `apps/calendars.json` at `0af86a4`, 2026-08-18 |
| 28 | Snapshot status endpoints are `GET /snapshots/snapshot-status/{snapshotId}` and `GET /snapshots/snapshot-status/{snapshotId}/location/{locationId}`. `GET /snapshots/status` does not exist. | GoHighLevel/highlevel-api-docs `apps/snapshots.json` at `0af86a4`, 2026-08-18 |
| 29 | Private Integration Tokens cannot receive webhooks; OAuth 2.0 is required if the integration needs webhooks or custom modules. | https://marketplace.gohighlevel.com/docs/Authorization/authorization_doc, 2026-08-18 |
| 30 | Where app review applies, a demo video is mandatory covering install, setup, main functionality, third-party auth, error handling, and uninstall, and least-privilege scope justification is required. Privacy Policy and ToS are not mandatory fields in the current submission flow. Redirect URLs must use HTTPS, match a verified domain, and be production-ready. | https://marketplace.gohighlevel.com/docs/oauth/AppReviewGuidelines, 2026-08-18 |
| 31 | Whitelabel apps must not use the provider's name or visuals in listing content, screenshots, videos, OAuth screens, setup pages, embedded apps, or support docs, and the words "Sub-account", "Agency", and "Location" are banned from public copy in favour of "business account", "company", "client account". | https://marketplace.gohighlevel.com/docs/oauth/AppReviewGuidelines, 2026-08-18 |
| 32 | Agency Pro at $497 is the plan tier carrying SaaS Mode, unlimited sub-accounts, white-labeling, and advanced API access. Starter and Freelancer do not have SaaS Mode. | https://help.gohighlevel.com/support/solutions/articles/48001180534-how-to-upgrade-to-highlevel-s-agency-pro-plan-497-saas-plan-, 2026-08-18 |
| 33 | Sandbox accounts are limited to 2 sub-accounts, email and SMS services are disabled by default, and data may be deleted, reset, or overwritten without notice. | https://marketplace.gohighlevel.com/docs/MarketplacePolicies/SandBoxFUP, 2026-08-18 |
| 34 | There is no public API endpoint for A2P 10DLC brand or campaign registration. All 852 documented paths across every v2 and v3 spec were enumerated; the only A2P artifact is a compliance object in the chat-widget spec that configures opt-in copy shown to a lead. The phone surface is exactly four endpoints: list number pools, list available numbers, purchase a number for a location, list active numbers. | GoHighLevel/highlevel-api-docs at `0af86a4`; https://marketplace.gohighlevel.com/docs/ghl/phone-system/, 2026-08-18 |
| 35 | Agencies can automatically install apps for future sub-accounts by choosing the all-sub-accounts option during the initial installation, and that choice happens during the initial installation rather than later. | https://help.gohighlevel.com/support/solutions/articles/155000002141-marketplace-app-distribution-type, 2026-09-02 |
| 36 | The agency-level install article describes the selection as selecting all or specific sub-accounts, with the app integrated at agency level by default. | https://help.gohighlevel.com/support/solutions/articles/155000001057-agency-level-marketplace-apps-installation, 2026-09-02 |
| 37 | An agency-targeted app is listed only in the agency marketplace and is installed at the agency. | https://marketplace.gohighlevel.com/docs/2021-07-28/oauth/AppDistribution, 2026-09-02 |
| 38 | `installToFutureLocations` is a token **response** field, described as controlling whether the app is automatically installed to future locations, for company tokens only, alongside `approveAllLocations` and `isBulkInstallation`. None of the three is a request parameter. | https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token/, 2026-09-02 |
| 39 | The App Management API documents only Uninstall and Get Installer Details. There is no documented mechanism for changing an existing install's sub-account set. | https://marketplace.gohighlevel.com/docs/ghl/marketplace/app-management/, 2026-09-02 |

**Still unverified as of 2026-09-02**, and treated as open rather than assumed:

- Whether the install link honours an appended `state` parameter. If it drops it, every callback is
  safely refused and no install completes, which is a loud failure rather than a silent one.
- Whether `AppInstall` and `AppUninstall` are delivered at all, given that neither is subscribable.
- The literal `messageType` strings for Instagram, Facebook, and the other DM channels.
- Whether an agency bulk install fans out into per-location `INSTALL` events.
- The HTTP status returned on a rate-limit breach. The strings "429" and "too many" appear on zero
  pages in the developer documentation set.
- The provider's webhook request timeout, named as a retry trigger with no published duration.
- What the `chooselocation` screen shows for a **Private** app opened by a direct link, as opposed to
  the marketplace listing flow both help articles describe. Nobody on our side has seen this screen.
- Whether the all-sub-accounts choice can be changed after install. What is verified is that no
  documented mechanism changes it: no install-to-location API, no toggle, and the flag is a token
  response field only. "Reinstall is the only way" is our conclusion from an absence, not a quote.

### 2.8 Before install day: the flag sequence

Order matters here, and getting it wrong burns an authorization code, which is the one genuinely
unrecoverable thing in this chapter.

1. **Set three flags to exactly `true` and redeploy, with both drivers still at `mock`.**
   `SETTERFI_PHASE1_LIVE` gates the webhook receiver itself, so without it `/api/webhooks/ghl`
   answers 404 and nothing the provider sends is ever seen. `SETTERFI_PHASE9_LIVE` and
   `SETTERFI_PHASE9_GHL_OAUTH_LIVE` are the parent and child gate on both callback routes and the
   install starter, and `phase9GhlOAuthLive()` requires both (`src/lib/env-contract.ts:447`).
   Then deploy, because variables bind at build time.

   This step feels irreversible and is not. Setting any of the three to anything other than `true`
   closes the routes again on the next build.

2. **Confirm the client's agency is on Agency Pro ($497) before installing anything.**
   `POST /locations/` is plan-gated, so on a lower tier zero-touch provisioning does not degrade, it
   fails at step one. The tier is machine-readable from the marketplace installations endpoint as
   `companyPlan`, for example `agency_monthly_497`, so assert it rather than trusting the billing
   screen. The field is null for sub-account-level installs, so read it off the agency install.

3. **Verify the deploy is Ready and green** on the `setter-fi` project. The build log will carry the
   `SETTERFI_FIRST_CUSTOMER_ENFORCE` disarmed credential list. That is expected while the launch
   credential list is being filled and is not a failure.

4. **Prove both callbacks answer a bogus state with a 303.** No secrets are involved:

   ```
   curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" \
     "https://setter-fi.vercel.app/api/channels/messaging/callback?state=probe&code=probe"
   curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" \
     "https://setter-fi.vercel.app/api/channels/messaging/agency-callback?state=probe&code=probe"
   ```

   Expect `303` from both, redirecting to `/coach/integrations?messaging=error` and
   `/admin/provisioning?provisioning=error`. A `404` means a flag is off. A `401` means the proxy is
   refusing the path, which is a defect seen before on 2026-08-28. Each probe writes one `failed`
   audit row with `GHL_OAUTH_STATE_INVALID_OR_REPLAYED`, which is expected. Note the time you ran
   them so they are not later read as the call's own attempts.

5. **Confirm an admin can load `/admin/provisioning`** and see the Marketplace installs panel with a
   Connect or Reconnect control on each of the two app rows. Only `owner` and `admin` may start an
   install, and an impersonated session is refused
   (`src/app/api/channels/ghl/install-start/handler.ts:121-122`).

6. **Generate the install link on the call, never before.** An install state lives ten minutes
   (`GHL_OAUTH_STATE_TTL_MS`, `src/lib/integrations/ghl-oauth.ts:31`) and is single-use.

### 2.9 Install day: during the call

App 1 goes first, because its consent screen carries the sub-account choice, which is the choice the
whole call exists for.

1. **Alec signs in to GoHighLevel as an agency user**, the agency owner or admin login rather than a
   sub-account login, **in the same browser** he will click from. The panel opens the provider's
   screen in a new tab of that browser, and whatever session that browser holds is the session that
   approves.
2. **In SetterFi, an owner or admin opens `/admin/provisioning`** and clicks the messaging app's
   Connect, or Reconnect if a credential is already stored. That posts to the install starter, which
   mints the single-use state and writes a `channel.messaging_install.started` audit row, then opens
   the provider's `chooselocation` consent screen.
3. **On the consent screen, Alec picks the all-sub-accounts option, not a single location.** This is
   the single most important instruction in the chapter. A single-location pick is what happened on
   2026-08-21 and it produced an install on 1 of 74 sub-accounts. If the wording on the screen
   differs from the help articles, describe what he sees and take the widest option offered; if the
   only option is one location, go to section 2.11.
4. **Then app 2, same pattern.** Back on `/admin/provisioning`, click the provisioning app's Connect.
   App 2 is agency-target, so expect a company-level consent with no sub-account multi-select.
   Whether the picker is suppressed entirely or shows the agency as a single row is undocumented, and
   either is fine. A Location grant here is refused by name,
   `GHL_AGENCY_INSTALL_USER_TYPE_UNEXPECTED`
   (`src/app/api/channels/messaging/agency-callback/handler.ts:142`).
5. Both approvals land back on `/admin/provisioning` with `?messaging=linked` or
   `?provisioning=linked`.

**What each approval should return.** Approving the agent app as an agency user should return
`userType: "Company"` with `isBulkInstallation: true`, and it should complete as the platform-level
agent grant rather than as a coach's install. Using app 1's chooser to pick a single sub-account
returns a Location grant instead, and a Location grant is refused unless that location is already
bound to a tenant: the redirect carries `messaging=error`, nothing is stored, and the attempts panel
names it `GHL_INSTALL_TENANT_UNRESOLVED`. That refusal is intentional, because a stored install with
no tenant is a connection no message could ever be routed to.

### 2.10 What to watch, and the pass condition

Three read-only queries against production while it happens. All `select`, no writes.

| Table | Column | Expected after each app |
|---|---|---|
| `ghl_oauth_states` | `consumed_at` | Non-null on the row created minutes earlier. It was null on every failed attempt to date |
| `audit_log` | `action` | `channel.messaging_install.completed` for app 1, `platform.provisioning_install.completed` for app 2, with `payload.after.install_target = "company"` |
| `ghl_agency_installs` | `updated_at`, `install_state` | One row per app, where `app` is `'agent'` or `'provisioning'` and is unique with `company_id`, with `install_state = 'token_ok'` and `updated_at` after the call started |
| `ghl_agency_installs` | `install_to_future_locations`, `approve_all_locations`, `is_bulk_installation` | The consent receipt, written straight from the token response |

Those three receipt columns are the point of the call. They come back as **response** fields on
`POST /oauth/token`, and none of the three is a request parameter. Nothing we send can set them; only
what Alec picks on the consent screen can.

The completion audit row is best-effort. It retries once and then logs, deliberately, so a missing
audit row never redirects a successful install to an error. If the `ghl_agency_installs` row moved
and the audit row did not, the install succeeded.

**Pass condition, all four per app:**

1. The `ghl_oauth_states` row for the attempt has `consumed_at` set.
2. A completion audit row exists for that app.
3. `ghl_agency_installs` has a row for that app with `install_state = 'token_ok'` and `updated_at`
   later than the call's start time.
4. **App 1 only:** `install_to_future_locations = true`. If it is `false` or `null`, the fallback
   check is an installed-locations read, which must return **74** locations for app 1. That is the
   full sub-account count confirmed by a paged read on 2026-08-22. Anything less than 74 is not a
   pass.

If app 1's flag is false or null and the installed-locations count is short, the call did not pass.
Go to section 2.11. App 2 does not need the flag; it only ever uses the company grant.

### 2.11 Fallback, and what not to do

**If the picker offers one location, or only the client's own primary account, stop.** Do not
complete a single-location install and do not treat it as partial progress. That is exactly the state
the call exists to replace.

1. Confirm Alec is signed in at **agency** level, in this browser, and not inside a sub-account.
   Sub-account users get a sub-account install by definition.
2. If the all-sub-accounts option genuinely is not offered, the cause is app 1's distribution
   settings, meaning bulk install and target user, which live on Profile, Listing Configuration
   rather than the Auth tab. That is a portal task for **after** the call: it needs the shared client
   developer login and a second-factor code from the client owner, and the bulk-install field is
   locked after first save.
3. **Do not uninstall app 1 on the call.** Uninstalling drops the stored company grant while nothing
   replaces it, and messaging is dead in that gap. Changing an existing install's sub-account set is
   undocumented, so any redo is an uninstall and reinstall, agreed off the call and rehearsed first.

**Do not** email or send the install link ahead of the call. A state expires in ten minutes and is
single-use, and two failures on 2026-08-27 were precisely a stale link reopened. **Do not** go
hunting for a "future sub-accounts" toggle in the agency portal; it does not exist. **Do not** start
an install from an impersonated session; it is refused and the refusal is audit-logged. **Do not**
paste the install link, an access or refresh token, or a client secret into a chat, a ticket, or a
shared document. The link carries a live single-use credential and the rest are secrets.

**If the callback errors**, the redirect always lands on an error URL and the specific code is in the
`failed` audit row's payload. Codes come from `src/lib/integrations/ghl-oauth.ts`.

| Code | What actually happened | The one action |
|---|---|---|
| `GHL_OAUTH_STATE_EXPIRED` (`:315`) | More than ten minutes passed between clicking Connect and finishing the approval | Click Connect again and finish inside ten minutes |
| `GHL_OAUTH_STATE_ALREADY_COMPLETED` (`:312`) | The same approval came back twice, from a reload or a back-button replay | Check the pass condition before doing anything. The first pass probably succeeded |
| `GHL_OAUTH_STATE_INVALID_OR_REPLAYED` (`:313`) | No such state: an old link, or a link from a previous session | Generate a fresh link from the panel |
| `GHL_OAUTH_STATE_APP_MISMATCH` (`:310`) | App 2's redirect arrived carrying app 1's state, or the reverse | Do not retry blind. The two links were crossed; re-check which button was clicked |
| `GHL_OAUTH_STATE_MISSING` / `GHL_OAUTH_CODE_MISSING` | The provider redirected without a state or without a code | Retry once. If it repeats it is a portal redirect-URL problem, not ours |
| `GHL_OAUTH_PROVIDER_DECLINED` | The approval was cancelled or the provider refused the consent | Ask what the screen said, then retry |
| `GHL_OAUTH_TOKEN_EXCHANGE_FAILED` (`:453`) and its network and malformed-JSON variants (`:411`, `:417`) | The code came back but the token call failed or answered unparseably | Retry once. A second failure is ours: stop the call and read the deploy logs |
| `GHL_OAUTH_GRANT_REVOKED` (`:421`) | The token endpoint answered 400 or 401, meaning a spent or withdrawn grant | Do not loop. A fresh approval is the only fix |
| `GHL_OAUTH_TOKEN_ENVELOPE_INVALID` (`:370`) | The token response was missing a required field or carried an unknown `userType` | Ours. Capture the audit row's body-key shape and stop |
| `GHL_AGENCY_INSTALL_USER_TYPE_UNEXPECTED` (`agency-callback/handler.ts:142`) | App 2 got a Location grant, so it was approved from a sub-account login | Sign in as the agency user and redo app 2 |
| `GHL_INSTALL_START_ROLE_FORBIDDEN` / `GHL_INSTALL_START_IMPERSONATION_FORBIDDEN` (`install-start/handler.ts:121-122`) | Whoever clicked Connect is not owner or admin, or is impersonating | Have an owner or admin click it from their own session |

### 2.12 After the call: three questions to answer, and the values to capture

**Record the answers to these three in this document's install-day section, the same day**, because
no amount of documentation has settled them and one real install settles all three at once.

1. **Does the install link honour an appended `state`?** If it drops it, every callback is refused
   and no install completes.
2. **Does an `INSTALL` webhook body actually arrive?** There is no toggle for `AppInstall` or
   `AppUninstall` anywhere in the picker, so delivery rests on an undocumented default. If nothing
   arrives, install reconciliation never runs and the uninstall writer never fires.
3. **Where does the browser finish?** The default-redirect flag could not be set, and its tooltip
   says an unset default lands the user on the marketplace screen. Our callback ends in a 303 back to
   a SetterFi route on every path, so it should land on `/coach/integrations`. Watch it rather than
   assume it.

**Answers recorded 2026-09-02, from production reads after the call.**

1. **Yes, the install link honours the appended `state`.** The state minted at 15:48:05 UTC came
   back on the callback and was consumed at 15:48:49 UTC; the `started` and `completed` audit rows
   (ids 1445 and 1446) carry the same `state_ref`. Nothing was refused.
2. **Yes, `INSTALL` webhook bodies arrive, one per sub-account plus one for the company.** Between
   15:48:49 and 15:48:56 UTC, 78 signed `INSTALL` events landed in `webhook_events`, all
   `signature_verified = true`. One is `installType: "Company"` with no `locationId`, and is marked
   `INSTALL_RECEIPT_INVALID` because the per-location reconciler has nothing to reconcile for it.
   The other 77 are `installType: "Location"` with 77 distinct `locationId` values, so the agency
   has 77 sub-accounts today, not the 74 counted on 2026-08-22. All 77 sit in `failed`, which is the
   retryable state: 41 as `GHL_INSTALL_TENANT_UNRESOLVED`, the designed refusal for a location no
   coach tenant is bound to yet, and 36 as `INSTALL_RECONCILE_FAILED`, meaning the driver's
   `reconcileInstall` step threw during the burst before tenant resolution was reached. The second
   group's cause was not read on the day. An hour later none of the 78 rows had moved
   (`attempts = 0`, `processed_at` null) although `/api/jobs/ghl-install-reconcile` is scheduled
   every fifteen minutes; confirm the job is actually running before relying on the retry.
3. **The browser was meant to land on `/admin/provisioning`**, the `return_path` on the state row,
   and Alec saw "Installed". Whether the marketplace screen appeared in between was not observed;
   nobody on the call was asked to watch for it.

**Then capture the values the code needs.** `companyId` from the agency grant into
`GHL_AGENCY_COMPANY_ID`. The coach snapshot's ID, read from its URL in the agency interface, into
`GHL_SNAPSHOT_ID`. The number pool ID, read from
`GET https://services.leadconnectorhq.com/phone-system/number-pools?locationId=...` with
`Version: 2021-07-28`, into `GHL_NUMBER_POOL_ID`. And the seeded test sub-account's location,
calendar, and contact IDs plus a Location access token into the four `SETTERFI_GHL_TEST_*` names.

**Use a real sub-account in the client's agency as the test account, flagged as test data.** Sandbox
accounts are capped at 2 sub-accounts, have email and SMS disabled by default, and their data may be
deleted or reset without notice, which makes a sandbox useless for an SMS-first product. The cost of
a real sub-account is a seat and an analytics exclusion, and the test-data segregation already
handles the exclusion.

Do not paste app 2's agency access token anywhere. `GHL_AGENCY_ACCESS_TOKEN` is a bootstrap for a
deployment that has not yet completed an OAuth install, it expires roughly 24 hours after it is set,
and it stops being consulted the moment a stored install exists. The stored agency grant lives
encrypted in `ghl_agency_installs`; the resolver refreshes it five minutes ahead of expiry, persists
both rotated halves in one statement, and serialises concurrent refreshes through a compare-and-set
lease so the single-use refresh token is never spent twice across serverless instances. A refused
grant marks the install as needing re-authorization and every later call fails closed.

### 2.13 Proving the receiver, then flipping the drivers

1. **Send a real SMS into the test sub-account** and confirm a signed `InboundMessage` reaches
   `/api/webhooks/ghl` and verifies against `GHL_WEBHOOK_PUBLIC_KEY`. The provider's Webhook Logs
   Dashboard, at `/app-settings/{app-id}/dashboard/logs` under Insights, Logs, Webhooks, shows
   delivery status and the full payload, retained 30 days. Drivers stay at `mock` throughout: this
   proves the receiver, not the sender.
2. **Read the literal `messageType` value off a real Instagram DM and a real Facebook DM** in that
   log, and compare against the `"IG"` and `"FB"` the channel mapping assumes.
3. **Confirm the provider behaviours no documentation settles**, each one a real call rather than a
   code change: the `snapshot-status` response body shape; whether a refresh token spent twice comes
   back 400 or 401, since those are treated as terminal revocation and everything else as retryable;
   and whether `/oauth/token` returns `companyId` on the agency grant and `locationId` on the
   sub-account grant, since both persisters refuse a grant that does not name its target.
4. **Only then set `SETTERFI_GHL_DRIVER` and `SETTERFI_GHL_PROVISIONING_DRIVER` to `real`** and
   deploy again. Everything up to that point runs against mocks with real credentials in place, which
   is the point: the credentials, the routes, and the receiver are each proven separately before
   anything live depends on all three at once.

---

## Chapter 3. Meta: Facebook, Instagram, and WhatsApp

### 3.1 The apps as set up

Two Meta apps were created live with the client owner on 2026-07-27, under **the client's Business
Portfolio**, both shared to the development side with full app access:

- **SetterFi Connector**, Facebook Login use case, for coach OAuth.
- **SetterFi Messaging**, WhatsApp plus Instagram plus Messenger use cases. This is the channel app.

A system user named `setterfib` exists with Admin role and both apps assigned. A WhatsApp Business
Account named "SetterFi support" was created under professional services, with no real phone number
attached yet, only a test number. A dedicated support number can be added and verified later.

**Two things about that setup are open and load-bearing.**

The token generated on SetterFi Messaging carried `instagram_manage_messages`, `pages_messaging`,
`whatsapp_business_management`, and `business_messaging`, which is **not**
`whatsapp_business_messaging`, the scope that authorizes WhatsApp send and receive. **Any previously
issued system-user token must be regenerated with messaging capability and stored only in the
deployment configuration.** The WhatsApp Business Account was also created after the token was
minted, and its assignment to the system user is unconfirmed.

**Business verification is asserted, not verified.** The client owner's answer on the call described
ad spend, which is not Meta Business Verification, and the same question bundled two-factor
authentication in with it, so neither is confirmed. Check Business Settings, Security Center before
treating the App Review clock as unblocked.

Also still open: payment-method attachment to the WhatsApp Business Account. There is a card on file
with Meta for ads, and that is not the same as a card attached to the messaging account. Verify it
before any real send.

**The WhatsApp direction is direct through our own app, on the Tech Provider path.** GoHighLevel's
native Meta channels remain the interim fallback: if App Review runs long, coaches connect
Facebook and Instagram through GoHighLevel and we cut over to our own app when it clears. Both paths
sit behind one channel adapter, so the switch is a configuration change rather than a rewrite. Meta
can be live immediately via the fallback, so never promise the direct path on a date.

### 3.2 The setup procedure

The client owner drives on his own account by screenshare, with the operator guiding each click. No
account access is handed over. **Owner of every asset is the client's Business Portfolio**, so it
stays with the client.

**Step 0. Baseline, confirm before anything else.**

- Signed in to `business.facebook.com` as the client owner, with the correct Business Portfolio
  selected.
- **Two-factor authentication is on** for the account acting here. It is required for Tech Provider.
- **Business verification status is Verified**, checked in Business Settings, Security Center. If it
  is not verified, that is the blocker and starting it is the first action. It is the same
  verification the Facebook and Instagram app needs.

**Step 1. Create the Meta app.** At `developers.facebook.com`, My Apps, Create App. Type is
**Business**. Name it, and link it to the client's Business Portfolio at creation. Inside the app,
Add product, WhatsApp, Set up.

**Step 2. Create the company WhatsApp sender.** This is what makes the portfolio eligible for Tech
Provider. Under WhatsApp, API Setup, create or attach a WhatsApp Business Account. Add **our own
company phone number**, one that is not already on the consumer WhatsApp app. This is the platform's
own sender, not a coach's, and no coach number is added on this call. Approve the display name and
verify the number by SMS or voice code. **Add a payment method to the account**, which is mandatory
before sending. Capture the WhatsApp Business Account ID, the Phone Number ID, and the temporary
access token, and validate them with a live test call before moving on.

**Step 3. Create a system user and a permanent token.** Production needs this, not the temporary
token. Business Settings, System users, Add, name it, role Admin. **Assign assets**: add the WhatsApp
app and the WhatsApp Business Account to this system user with full control. Generate a token,
selecting the app, and enable **`whatsapp_business_management` and `whatsapp_business_messaging`**.
The permanent token is shown once. It goes straight into the deployment configuration under
`META_WHATSAPP_SYSTEM_USER_TOKEN`, and nowhere else.

**Step 4. Request Advanced Access and submit App Review.** This is the Tech Provider unlock. App
Dashboard, App Review, Permissions and Features. Request Advanced Access for
`whatsapp_business_management` and `whatsapp_business_messaging`, fill each permission's use
description, and upload the video walkthrough. Complete the checklist and submit. The filing material
lives in [docs/META-APP-REVIEW-PACKAGE.md](META-APP-REVIEW-PACKAGE.md).

**This is an exit gate, not a day-one form.** Each permission needs at least one successful live API
call on record plus a screen recording demonstrating that permission specifically, so the integration
has to be built and working before it can be submitted at all. Filing early is not possible. The
review itself is fast: Meta publishes "typically less than one week, often 2 to 3 days", and the
WhatsApp provider page quotes roughly 24 hours average. Do not promise a date, but do not treat it as
the long pole either.

**Step 4b. Access Verification.** This is a separate submission for the business, taking roughly 5
days. Until it clears, WhatsApp Embedded Signup is capped at **10 coach onboardings per rolling 7
days**. That is a self-serve volume ceiling rather than a demo blocker, and it is worth starting
early precisely because it is cheap.

**Step 5. After approval, which is not part of the setup call.** Integrate Embedded Signup into
SetterFi onboarding: the coach clicks Connect WhatsApp, gets a Meta popup, picks a number, and is
done in two or three minutes. The server exchanges the returned code for a customer-scoped token,
registers the coach's phone number, and subscribes our app to their WhatsApp Business Account
webhooks. **Each coach owns their own WhatsApp Business Account**, which avoids shared-portfolio
messaging-limit pooling.

### 3.3 The four Meta processes

"Meta review" is not one clock. It is four distinct processes with different owners and durations.

1. **Business Verification.** The client's action, not ours. On the 2026-09-02 call Alec showed
   the portfolio's Security Center reading Verified; the Meta reference and date still have to be
   entered in `docs/META-APP-REVIEW-PACKAGE.md` before its ledger row moves.
2. **Access Verification.** Roughly 5 days. It lifts the 10-onboardings-per-rolling-7-days cap on
   WhatsApp Embedded Signup, so it gates coach self-serve volume rather than the demo. It needs an
   owner and a submission date.
3. **App Review and Advanced Access.** An exit gate rather than a day-one form, for the reason given
   in step 4 above. Meta publishes "typically less than one week, often 2 to 3 days" for the review
   itself.
4. **Tech Provider and Solution Partner onboarding** for the WhatsApp Embedded Signup path.

### 3.4 Policy caveat, worth saying out loud

WhatsApp bars payday loans, peer-to-peer lending, debt collection, and high-risk or misleading
financial claims. Keep the agent's WhatsApp messaging to **appointment setting and qualification**:
no approval guarantees, no credit-repair claims. The agent's hard gates already enforce this, and the
credit and funding subject matter still needs a compliance read against WhatsApp policy before live
coaches are onboarded.

### 3.5 What to hand over for validation

When the client owner completes steps 2 and 3, three values need validating immediately against the
Cloud API: the WhatsApp Business Account ID, the Phone Number ID, and the token. Fire a test call,
get the phone number back, send a test message, and confirm the credentials work before moving on.
**Every completion claim needs a provider receipt, meaning a response ID and a readback, not an HTTP
200.** The IDs land in `META_WABA_ID` and `META_WHATSAPP_PHONE_NUMBER_ID`; the token lands in
`META_WHATSAPP_SYSTEM_USER_TOKEN`, in the deployment configuration only.

**State on 2026-09-02.** The WABA ID and Phone Number ID from the call were added to the Vercel
production environment that day (the WABA's last digit is to be confirmed against the account page).
No Meta token or app credential of any name exists in production yet, so the validation call has not
been fired; it runs the moment `META_WHATSAPP_SYSTEM_USER_TOKEN` is entered by hand. On the call Alec
also added a payment card to the WhatsApp account and assigned the system user to it.

---

## Chapter 4. A2P 10DLC registration for SMS

### 4.1 What has to happen, and how long it takes

SMS numbers are provisioned per sub-account through GoHighLevel, and every one of them needs **per
client A2P 10DLC registration**. This is not one wait but a sequence: brand registration, which is
fast and often same-day, then brand vetting, then campaign submission, then **campaign vetting by the
carriers, which is the long pole at roughly two to three weeks** and is a gate nobody controls. Plan
on roughly three weeks end to end. Until the campaign is approved the number exists but outbound SMS
is blocked.

Sequencing to respect in onboarding: Meta channels can be live immediately, SMS follows when A2P
clears. Never promise instant texting.

### 4.2 There is no status API, so readiness is probed

GoHighLevel's published API exposes **no A2P brand or campaign state and emits no A2P webhook**,
verified across all published specifications, operations, and webhook events. A failed send comes
back as a bare status word, `failed` or `undelivered`, with no error code and no reason. So "campaign
not approved" is indistinguishable from a landline, a disconnected number, or a carrier drop.

Two consequences shape the whole mechanism.

**Readiness is detected by a probe send to a phone number we own and have verified**, never against
live lead traffic. Controlling the destination is what makes a failure attributable, because it
eliminates every other explanation by construction. On success, the coach's SMS auto-flips to live.
The probe target is pinned by `SETTERFI_A2P_PROBE_TARGET` and `SETTERFI_A2P_PROBE_TARGET_HASH`.

**Never infer readiness from `capabilities.sms` on the number object.** That flag is true from the
moment the number is provisioned, long before any campaign is approved.

Because there is no registration API either, the submission calls throw
`GHL_A2P_SUBMISSION_API_UNVERIFIED` (`src/lib/integrations/ghl.ts:815`) rather than guessing at an
endpoint, and the "registering, day N" counter is a human-maintained number until a surface exists to
drive it.

### 4.3 What the product shows

Honest amber, a real day counter, and no invented dates. The interface says the coach is registering,
states the real roughly three week expectation on screen, and says it flips on automatically. **Never
a percentage, never a predicted date, never "all set" while anything is pending.**

**Flag for human review at roughly 21 days, not 10.** Ten days sits inside the normal window and
would page a human on healthy registrations.

**Terminal rejection is a separate event with its own immediate path**, not the same timer. The
provisioning tracker carries `blocked_permanent` as a terminal state with no retry affordance and no
timer, because a wait and a permanent refusal are two different conversations with the coach.

### 4.4 Content eligibility, which some coaches will fail permanently

Carrier policy **permanently refuses** A2P campaigns for credit repair, direct loan marketing, and
debt reduction, and those rejections are documented as not eligible for resubmission. A rejected
campaign is finished, not fixable. Toll-free verification is closed on the same grounds, so there is
no fallback route.

Coaching and education are not on the prohibited list, so a defensible registration exists for a
coaching business booking consultations. But the reviewer reads the coach's own website and sample
messages, and this industry routinely advertises the exact vocabulary that triggers the refusal, over
copy we do not control.

So onboarding runs a **deterministic keyword scan, not a model call**, over the coach's website and
their offer-layer free text against the carrier refusal vocabulary, before the campaign is filed. A
clean screen files automatically and the flow stays zero-touch. A hit puts the step at
`awaiting_coach` with the matched phrases quoted and the page named. The coach may fix the page and
re-run, or acknowledge and proceed, and proceeding queues **one admin confirmation before filing**,
recorded as `onboarding.a2p_filing_confirmed` with the actor. That is a deliberate carve-out from the
no-human-clicks rule, and the trade is one admin click against burning a coach's single
non-refilable shot at SMS.

Meta DM channels are governed by entirely separate rules and are unaffected, which is the argument
for keeping SMS strictly secondary in how the product is described.

### 4.5 The EIN branch

**A2P registration branches on whether the coach has an EIN**, and it is an eligibility branch rather
than a preference. Sole Proprietor registration is restricted to businesses **without** an EIN, and
any US LLC has one and is therefore ineligible for it.

The two paths differ sharply downstream. Sole Proprietor allows one campaign and one number, caps
sending at roughly 1,000 messages a day, and verifies by a one-time code sent to the coach's personal
mobile. **That code can only be used three times across all A2P registrations anywhere, ever**, so a
shared or support number leaking into that field burns a global allowance. Onboarding asks about the
EIN, routes on the answer, and shows sole proprietors their real sending cap.

### 4.6 The opt-in artifact

**Campaign registration will not proceed without a compliant opt-in artifact.** The requirements are
specific: consent checkboxes separate for marketing and non-marketing, never pre-ticked, optional to
submit even when the phone field is required; a terms page carrying an explicit clause about not
sharing with third parties or affiliates; and campaign description language that matches the consent
language.

That artifact is rendered and version-hashed from template input and confirmed before filing. Terms
and privacy pages are served from the persisted confirmed version at `/opt-in/[tenantSlug]/terms` and
`/opt-in/[tenantSlug]/privacy`, and the campaign description is generated from the same template
data, so consent language and campaign language cannot drift apart.

**What is deliberately not built is the wording itself.** Every body is a
`SETTERFI_DEMO_PLACEHOLDER_*` value carrying a visible unapproved label, and the real filing path
rejects a placeholder outright. The client owner and counsel owe the approved consent, terms,
privacy, and campaign-description copy, plus the sample messages for the campaign. When it arrives it
is entered as approved template data. It is not written by the build and not invented. Until then a
coach can walk the whole lane and see exactly where their own approved language will sit, and no
campaign can be filed with placeholder text.

### 4.7 Fees, minimums, and throughput

These are real per-coach cost lines. Rates are GoHighLevel's, passed through from the registry
without markup, current as of 2025-08-01, US only.

| Item | Cost |
|---|---|
| One-time registration, Sole Proprietor and Low Volume Standard | roughly $24.50, covering brand registration, campaign vetting, and fast-track |
| One-time registration, High Volume Standard | $71.91 |
| Monthly per campaign, standard use cases | $10 |
| Monthly per campaign, Sole Proprietor | $2 |
| Monthly per campaign, Low Volume Mixed | $1.50 |
| Additional campaigns under the same brand | $15 each |
| Carrier per-segment surcharge, outbound | $0.001 to $0.005 |
| Secondary (Standard) vetting, to raise throughput | $41.50 |

**Every campaign carries an irreversible three-month minimum**, so a coach who churns in month one
still costs three months of campaign fees, and deactivation cannot be undone. A coach who leaves and
comes back is a fresh registration, a fresh fee, and a fresh clock. Price tiers and write cancellation
terms knowing that, and do not let the provisioning tracker offer a deactivate action without a hard
confirmation.

**Default throughput is low, and lifting it costs money and does not apply retroactively.** A new
brand starts in the Low tier: 2,000 T-Mobile segments a day shared across every campaign under that
EIN, and AT&T Class E and F at 240 SMS per minute per campaign. Sole Proprietor is worse, at 1,000 a
day and 15 a minute. Secondary vetting is what moves a brand up, and a campaign registered before the
vet completes has to be resubmitted to inherit the new score. This is the ceiling on how fast a
coach's follow-up cadence can go out, and the cadence engine has to know it rather than assume
unlimited send.

---

## Chapter 5. Stripe and Google Calendar

### 5.1 Stripe

**What the model is, as built.** Coach subscriptions on outcome-based tiers: $297 a month up to 25
booked calls, $597 up to 75, $997 beyond, with an admin-editable fair-use cap on the top tier.

**There are no Stripe Billing Meters and no metered usage reporting.** The tiers are fixed recurring
Prices, and SetterFi counts booked calls locally against the allowance, so nothing round-trips to
Stripe inside a billing window and a late webhook can never lose a billable event. Crossing an
allowance raises a notice and an owner or admin decision, never a silent extra charge. A coach can
dispute a count from their own billing page with a reason, and an owner or admin decides it on the
record, writing an offsetting event plus an audit row.

Subscription state lives in a local `billing_subscriptions` mirror, and every read surface reads the
mirror rather than Stripe directly.

**Affiliate commission** accrues per invoice at 10% of collected revenue, excluding tax and net of
discounts, for twelve months from the referred coach's first positive invoice. Every reversal, whether
clawback, refund, or dispute, is an **offsetting ledger row and never a status flip** on a row that
was already paid, because flipping a paid row destroys the record that the money was sent.
Cancellation and refund stay separate events. Payout has exactly two recorded states, **approved for
payout** and **recorded sent** with an external reference and date, and no surface claims SetterFi
moved the money. A first failed payment marks the tenant overdue and alerts; **suspension is only ever
a human owner or admin action carrying a reason.**

**Environment names.** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are the two credentials
(`src/lib/integrations/stripe/selector.ts`). `CRON_SECRET` authenticates the webhook replay job.

**Flags.** `SETTERFI_PHASE6_LIVE` is the parent. `SETTERFI_PHASE6_STRIPE_LIVE`
(`src/lib/env-contract.ts:357`) gates the Stripe path specifically, `SETTERFI_PHASE6_AFFILIATES_LIVE`
gates affiliates, and `SETTERFI_CHECKOUT_ATTEMPTS_LIVE` gates the checkout attempt lane. The driver
selector is `SETTERFI_STRIPE_DRIVER`, taking `mock` or `real` under the rule in section 1.3.

**All of those stay off until three things arrive**: real Stripe keys, an approved server-side Price
allowlist, and approved billing copy. An explicit real driver without its key throws a value-free
`DriverConfigurationError`, real Checkout without the allowlist throws
`STRIPE_PRICE_ALLOWLIST_REQUIRED` before any provider call, and real dispatch of an unapproved notice
fails closed as `BILLING_COPY_UNAPPROVED`.

**Checkout refuses on the mock driver.** `createHostedCheckoutProvider` throws
`BILLING_CHECKOUT_MOCK_DRIVER_REFUSED` when the selector reads `mock`
(`src/lib/billing/checkout.ts:97-98`). That decision sits at the authoritative selector rather than
in a caller, because a real-tenant checkout has no mock success lane even outside production: a
browser could mistake it for payment. Demo tenants are separately routed to the mock arm before the
selector is consulted, so a labelled tenant can never construct a real arm.

**The webhook path** is `/api/webhooks/stripe`, which writes a receipt, plus
`/api/jobs/stripe-webhooks`, which replays claimed receipts on `CRON_SECRET` in bounded 25-row
batches. An invalid signature, a stale or duplicate delivery, and events arriving out of order all
converge on replay rather than corrupting the mirror. The events consumed are subscription created
and updated for mirror sync, invoice paid for commission accrual and SaaS metrics, payment failed for
the overdue mark and alert, and subscription canceled for churn.

**Margin renders absent, not zero,** while any cost rate is missing, and it is admin-only. Messaging
and embedding rates are still owed, so production margin is genuinely incomplete and says so.

### 5.2 Google Calendar

**The connection model is our own Google app, not Google through GoHighLevel.** Coaches split between
a GoHighLevel calendar and Google, and both modes are supported.

**Four routes, all behind one flag.** `/api/calendars/google/connect`, `/callback`, `/select`, and
`/disconnect` sit behind `SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE`
(`src/lib/env-contract.ts:240`), which is unset by default and **keeps all four routes at 404** and
the Connect button off the onboarding calendar page. This is the one flag that changes the
reachability of a route rather than the behaviour behind one, and with a single client-owned
environment it is the only thing standing between an unreviewed OAuth flow and a coach who can reach
it. The credentials are `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET`.

**What the coach does:** press one button and type nothing. The grant is stored as encrypted
credential envelopes in `google_calendar_grants`, and a `calendar_connections` row is written only
once a calendar is picked, reaching `ready` only after a free/busy read came back clean for that
calendar. The booking URL the agent may send is `calendar_connections.booking_url`, provider-derived
and never coach-typed.

**Testing publishing status, and the seven-day expiry.** Google's app is still in **Testing**
publishing status, which means two things Google states plainly: only listed test users can complete
the consent screen, and "Authorizations by a test user will expire seven days from the time of
consent" (`https://support.google.com/cloud/answer/15549945`, read 2026-09-02). So a real coach
cannot connect a calendar yet, and the `expired` state is the normal operating condition rather than
an edge case until the app is published.

**Leaving Testing is a chain, not a form.** Google's Branding page requires home page, privacy policy,
and terms links, and states that an app missing these links cannot be submitted for verification. The
home page must be on a verified domain the client owns, must describe the app's functionality rather
than being only a login page, and must itself link the privacy policy at the same URL given on the
consent screen. **Branding must be published before scope verification can be requested**
(`https://support.google.com/cloud/answer/10311615`, read 2026-09-02). The piece that is not ours to
wave through is the privacy policy: it needs the public consumer privacy URL, on the same domain as
the home page.

So the verification chain, in order: publish a home page on a verified domain that describes the app
and links the privacy policy, publish the privacy policy and terms at those URLs, publish Branding,
then request scope verification.

**How the agent uses the calendar.** Two booking modes, both supported. `direct`, the default,
proposes two or three real slots and writes the appointment in-thread, sending no link. `link`
qualifies fully, asks for the commitment, and then sends the derived booking URL inside a sentence
naming the lead's situation. Never a bare URL on its own line, never a URL as the whole message, and
never before qualification completes. What that rule protects against is throwing away the
qualification and moving the lead to a surface we cannot see.
