# Launch checklist

Date: 2026-09-02, commit `fb4b01f1`. Companion to `platform-diagram/PLATFORM-DIAGRAM.mmd` and
`platform-diagram/EVIDENCE.md`. Every row names the fix and the proof (a `file:line` at this
commit, or a live measurement from `platform-diagram/EVIDENCE.md` section 1). Owner "build" is the
engineering side; "client" is the owner, Live Legacy Strong.

Four sections: demo-mode behaviours to switch off (A), build gaps (B), code defects to fix before
real money or real data (C), and inputs owed by the client (E). A row leaves this list when its
proof changes, not when somebody says it is done.

## A. Demo-mode behaviours to switch off before real coaches arrive

| # | Behaviour | Fix | Proof |
| --- | --- | --- | --- |
| A1 | Production demo logins: one-click owner/admin/coach/affiliate buttons with a live password in the HTML, behind the shared access password | Unset `SETTERFI_PRODUCTION_DEMO_LOGINS` and `SETTERFI_DEMO_LOGINS`; rotate `SETTERFI_DEMO_LOGIN_PASSWORD`; then decide the entry policy | `src/lib/auth/demo-logins.ts:70-79`; `src/lib/env-contract.ts:250-252`; live `/login` 307 to `/access` shows the password branch is active |
| A2 | Shared access password gate wraps every page | Remove `SETTERFI_ACCESS_PASSWORD` once demo logins are off, so the Supabase gate alone decides | `src/proxy.ts:101-118`; live 307s in `EVIDENCE.md` section 1 |
| A3 | Build gate disarmed: production builds succeed with missing provider credentials and print a DISARMED banner | Delete `SETTERFI_FIRST_CUSTOMER_ENFORCE` (any value but the literal `false` re-arms) once section E is filled | `scripts/verify-env-contract.mjs:346-349` |
| A4 | Five demo tenants exist in production and route provisioning, email, Slack and Stripe to mock arms by tenant flag | Keep (they are excluded from analytics) but confirm none is reachable from a real coach account; document the list | `src/lib/demo-tenant.ts:21`; `src/lib/onboarding/runner.ts:81-84`; `src/lib/integrations/email/selector.ts:32` |
| A5 | Hand-inserted alert rule `phase8.demo.slack:tenant` with no migration behind it | Delete it, or add the migration that creates it | `scripts/seed-phase8-demo.mjs:194` inserts it for demos; no migration under `supabase/migrations/` creates it; `src/app/api/notification-preferences/handler.ts:65` records the hand insert |

## B. Build gaps (in scope, not built or not surfaced)

| # | Gap | Fix | Proof |
| --- | --- | --- | --- |
| B1 | Signup quotes no plan: `tier_offer_terms` and `account_terms_versions` have zero rows, so `/signup` is disabled | Client supplies prices and terms (E1, E7); build writes them through the offer-term writer and account-terms tables | live `GET /api/onboarding/signup` `{"tiers":[]}`; live `/signup` "No named plan is available"; validity rule `src/app/api/onboarding/signup/handler.ts:276-291` |
| B2 | Notification bell exists but no page renders it | Mount `NotificationBell` in the workspace top bar for coach and admin | `src/components/workspace/live/notification-bell.tsx:31` (test-only importers) |
| B3 | Account security (password change, sessions, MFA, email change) and teammate invites have server routes but no page calls them | Wire the settings page to `/api/account/security/*` and `/api/tenant/members/*` | no non-test `.tsx` references those paths; flags at `src/lib/env-contract.ts:290,465,479,493` |
| B4 | `/coach/tips` renders a component with no data source | Either feed it from Notion per `docs/PRODUCT.md:126-127` or remove the top-bar link | `src/app/(workspace)/coach/tips/page.tsx:14-21,32`; `app-topbar.tsx:139` |
| B5 | Coach view of Meet Your Agent is a hard-coded script, not the model | Label it as a scripted preview on screen, or route coaches to the sandbox once E5 lands | `src/components/meet-your-agent/coach-agent-preview.tsx:58,99,298,352`; `src/app/meet-agent/page.tsx:100` |
| B6 | Affiliate partner terms copy comes from a placeholder sentinel; real copy has no source | Client supplies terms (E7); replace the sentinel read | `src/app/(workspace)/affiliate/page.tsx:15,57` |
| B7 | Consent-link issuance, Meta embedded signup (WhatsApp), message templates, provider reconnect/test/disconnect commands have no product caller | Decide whether these ship at launch; otherwise mark them later-phase in the diagram | routes exist with no page caller: `src/app/api/contacts/[id]/consent-link/`, `src/app/api/channels/meta/embedded-signup/handler.ts`, `src/app/api/message-templates/handler.ts`, `src/app/api/channel-actions/` |
| B8 | Google Calendar OAuth is built but off; Google app is in Testing and needs a verified domain and privacy page | Client supplies domain and privacy page (E8); then run the live proof and set `SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE=true` | `src/app/api/calendars/google/*`; `docs/CONTEXT.md` (Google OAuth verification) |
| B9 | Channel health table has no export menu; the "every table exports" rule has exceptions | Add the export menu or amend the rule | `src/components/workspace/live/admin-channel-health.tsx:821`; `src/lib/exports/rendered-tables.ts:29-99` |
| B10 | Two operator walkthrough recordings are shot lists only | Record them before handover | `docs/operations/recording-01-diagnose.md:3`; `docs/operations/recording-02-brain-publish-rollback.md:3` |
| B11 | Affiliate portal and payouts never exercised with a real affiliate session | One demo-affiliate load, then a payout dry run | no test or recording exercises `/affiliate` with a real session; payout ledger `supabase/migrations/20260822000001_phase6_money.sql:322-343` |

## C. Code defects to fix before real money or real data

| # | Defect | Fix | Proof |
| --- | --- | --- | --- |
| C1 | Brain retrieval cannot run in production: the embeddings selector is unset (throws) or `mock` (throws under `NODE_ENV=production`). Every grounded turn fails until an OpenAI key and `SETTERFI_EMBEDDINGS_DRIVER=real` exist | Set the key and selector (E5); add a readiness line naming embeddings | `src/lib/env-contract.ts:528-545`; `src/lib/integrations/embeddings/selector.ts:13-20`; `src/lib/brain/retrieval.ts:222-223`; live `/api/health/ready` `requiredProviders:false` |
| C2 | `calendar_connection_secrets` stores access and refresh tokens in plain text while every other custody table has the AES-256-GCM envelope constraint | Migration: envelope columns plus CHECK, re-encrypt existing rows, drop plaintext | `supabase/migrations/20260817000002_phase1_review_fixes.sql:149`; constraint pattern `20260905000010_backend_security_sagas.sql:119`; asymmetry noted `20261008000001_google_calendar_oauth.sql:14` |
| C3 | Credential envelope falls back to a public mock key from the repo whenever the Meta driver is not `real`, even in production; Google Calendar grants would sit behind it | Throw on a missing `SETTERFI_CREDENTIAL_ENCRYPTION_KEY` in production regardless of driver | `src/lib/integrations/credential-envelope.ts:19,52`; `scripts/verify-env-contract.mjs:35-42` |
| C4 | Failed scheduled jobs notify nobody; receipts only reach the system health page and readiness | Emit an alert-rule event on a job failure or a stale receipt | `src/lib/repositories/job-receipts.ts:69`; `src/lib/operations/system-health.ts:11-43` |
| C5 | Notification delivery job throws out of the whole batch when an email or Slack driver is unconfigured (503) instead of failing one delivery | Wrap `notificationDriversForClaim` per delivery | `src/app/api/jobs/notification-deliveries/handler.ts:120-129` |
| C6 | `capi-events` job has no phase flag; it drains the moment `CRON_SECRET` exists (fails closed today on the purchase-value gate, but ungated) | Add a gate consistent with the other jobs | `src/app/api/jobs/capi-events/handler.ts:22,34,46` |
| C7 | Meta connect leaves an orphaned `connecting` row on failure after insert; a retry inserts another | Clean up or reuse the pending row | `src/app/api/channels/meta/connect/handler.ts:101-111,322-328` |
| C8 | Onboarding runner substitutes literal `mock-...` strings for missing `GHL_AGENCY_COMPANY_ID`, `GHL_SNAPSHOT_ID`, `GHL_NUMBER_POOL_ID` rather than failing; harmless only while the driver's own check runs first | Fail loudly on the real arm | `src/app/api/onboarding/run/handler.ts:151-153` |
| C9 | Eval bench `/admin/brain/testing` is hidden from success and build by the nav but the page only checks workspace access, so a typed URL serves it | Add the `BRAIN_MUTATION_ROLES` check to the page | `src/lib/workspace-navigation.ts:216` vs `src/app/(workspace)/admin/brain/testing/page.tsx:83` |
| C10 | `/api/admin/compliance/registry` returns 401, not 403, for a wrong role; the role set lives only in the injected loader | Add the role predicate in the handler | `src/app/api/admin/compliance/registry/handler.ts:12,26-28,55` |
| C11 | Twenty authenticated routes carry no in-handler role check and rely on RLS alone | Audit each against the RLS policies; add explicit predicates where a role matters | `src/lib/auth/actors.ts:60-86` |
| C12 | Kanban "Move" menu and inbox agent switch render disabled with only a hover title when their flags are off | Hide them or print the reason inline, matching every other surface | `src/components/workspace/live/kanban-card.tsx:218`; `coach-conversations.tsx:1821` |
| C13 | Build role is offered three money destinations and 403s on all of them | Remove `build` from `MONEY_ROLES` or grant it | `src/lib/workspace-navigation.ts:133` vs `view-models.ts:538-539` |
| C14 | Nav `matchPaths` names `/admin/tiers-billing`, a path with no route | Fix the path | `src/lib/workspace-navigation.ts:195-199` |
| C15 | `.env.example` shows every driver selector blank, which is the one value that always throws | Document `mock`/`real`/`offline` and the production ban on `mock` | `src/lib/env-contract.ts:544`; `.env.example` |
| C16 | Lead message bodies are stored raw with no redaction outside the eval promotion path | Decide retention and redaction policy; at minimum a retention window | `src/lib/evals/redaction.ts:126` |


## E. Inputs owed by the client

| # | Input | Unblocks | Proof |
| --- | --- | --- | --- |
| E1 | Plan names, prices, allowance and dated terms per tier | Signup (B1), billing page, admin tiers | `tier_offer_terms` writer `supabase/migrations/20261003000002_tier_offer_term_writer.sql`; live `GET /api/onboarding/signup` `{"tiers":[]}` |
| E2 | Live Stripe keys: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SETTERFI_STRIPE_DRIVER=real` | Card payment, webhook confirmation, go-live subscription check | `src/lib/billing/checkout.ts:95-100`; live `/api/webhooks/stripe` 503 |
| E3 | Meta app credentials: `META_APP_ID`, `META_APP_SECRET`, `META_SYSTEM_USER_TOKEN`, `META_WEBHOOK_VERIFY_TOKEN`, `META_LOGIN_CONFIG_ID`, `SETTERFI_META_DRIVER=real`, plus Meta app review | Instagram and Facebook connect, inbound DMs, replies | `src/lib/integrations/selector.ts:72-78,199`; live `/api/webhooks/meta` 503 |
| E4 | Resend account, `RESEND_API_KEY`, `RESEND_WEBHOOK_SIGNING_SECRET`, `SETTERFI_EMAIL_FROM`, `SLACK_WEBHOOK_URL`, both drivers `real` | Alerts by email and Slack | `src/lib/integrations/email/selector.ts:38`; `slack/selector.ts:37` |
| E5 | `OPENAI_API_KEY`, `SETTERFI_EMBEDDINGS_DRIVER=real` | Brain retrieval, test pass, Meet Your Agent (C1) | `src/lib/integrations/embeddings/selector.ts:20` |
| E6 | `GHL_SNAPSHOT_ID`, `GHL_NUMBER_POOL_ID` from the GoHighLevel portal, `SETTERFI_GHL_PROVISIONING_DRIVER=real`; the agency marketplace install on a call (2FA on Alec's phone) | Automatic sub-account and phone number per coach; A2P probe | `src/lib/integrations/selector.ts:86-90,138`; `docs/SETUP.md` (GoHighLevel chapter, install day) |
| E7 | Approved legal copy: account terms, privacy policy, A2P campaign and sample messages, affiliate terms | Signup terms step, campaign filing, affiliate portal | `src/app/api/onboarding/run/handler.ts:88-115`; `src/lib/env-contract.ts:510` |
| E8 | Public website on a verified domain and a privacy page at the consent-screen URL, then Google app publication | Google Calendar sign in (B8) | `docs/CONTEXT.md` (Google OAuth verification) |
| E9 | Purchase-value ruling for Meta conversion events | CAPI on real bookings | `src/lib/capi/worker.ts:114-285` fails closed until the ruling exists |
| E10 | Named escalation contacts and five provider cost rates | Operations pack | `docs/operations/escalation-path.md:6-10`; `docs/operations/running-costs.md:3-13` |
| E11 | Sign-off on the open product decisions (Brain sync cadence, qualification matrix values, affiliate commission terms and signup, tier names and prices, plan presentation) and on D1 to D9 in `platform-diagram/EVIDENCE.md` | Release hold | `platform-diagram/EVIDENCE.md`, "What you still owe"; `docs/CONTEXT.md`, "Remaining external inputs and decisions" |
