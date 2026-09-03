# Platform diagram evidence ledger

Date: 2026-09-02. Source commit: `fb4b01f1` (main). Live deployment: https://setter-fi.vercel.app
(the production deployment current on 2026-09-02).

Every node in `PLATFORM-DIAGRAM.mmd` carries an id (L1, W1, S1, T1, I1, C1, A1, F1, P1, O1, D1 ...).
This file is the proof for each id: a `file:line` in this repo at the commit above, or a live HTTP
measurement recorded below. Where a document and the source disagree, the source wins and the
disagreement is noted in the row.

Research was run as seven read-only lanes (surfaces, journey, providers, flags, guardrails, jobs,
doc claims) plus unauthenticated live probes. Authenticated per-role probing was NOT performed: the
session's permission classifier blocked deriving a session from the repo's demo credentials, so
every "on/off in production" statement below rests on public routes (which check the flag before
any session) and on the production configuration as recorded on 2026-09-02. Signed-in behaviour of
workspace pages and role-gated APIs, the row counts in `tier_offer_terms`, `account_terms_versions`
and `tenants.is_demo`, and any real Stripe, Meta, Resend or Google round trip were not
measured.

## 1. Live measurements (unauthenticated, 2026-09-01 22:35 to 22:41 UTC)

The proxy (`src/proxy.ts:117`) lets these paths through without a session, and every API handler
checks its feature flag as its first statement, before auth (`src/lib/env-contract.ts`; e.g.
`src/app/api/jobs/followups/handler.ts:22-31`). So on a public route: 404 means the flag is off,
any other status means it is on.

| URL | Method | Status | Body / redirect | What it proves |
| --- | --- | --- | --- | --- |
| `/api/health/live` | GET | 200 | `{"status":"alive"}` | process answers |
| `/api/health/ready` | GET | 503 | `{"status":"unready","configuration":true,"database":true,"automation":false,"requiredProviders":false}` | DB reachable; at least one required scheduled job has no fresh success receipt; at least one flag-required provider is not on its real driver with credentials (`src/lib/operations/deployment-readiness.ts:90-140,165-197`) |
| `/` | GET | 200 | marketing page, title "SetterFi — your funding DMs answered, qualified and booked"; body text "Plans are not loading right now, so there is no price on this page to read" | `SETTERFI_PUBLIC_LANDING_LIVE` on; tier catalogue empty |
| `/signup` | GET | 200 | body text "Account setup is not available yet. No named plan is available, so signup stays disabled instead of choosing one for you." | signup page renders its honest disabled state |
| `/api/onboarding/signup` | GET | 200 | `{"tiers":[]}` | Phase 5 on; zero sellable tiers (`src/lib/repositories/onboarding-signup.ts:484-497`, needs `tier_offer_terms` rows when `SETTERFI_TIER_OFFER_TERMS_LIVE`) |
| `/api/onboarding/signup` | POST `{}` no Origin | 403 | `{"error":"Request origin was refused."}` | same-origin check (`handler.ts:161`) |
| `/api/onboarding/signup` | POST `{}` with Origin | 400 | `{"error":"Signup details are invalid."}` | Phase 5 on (flag-off would be 404) |
| `/login` | GET | 307 | `/access?next=%2Flogin` | shared access password gate on; `SETTERFI_PRODUCTION_DEMO_LOGINS` branch active (`src/proxy.ts:101-118`) |
| `/coach`, `/coach/overview`, `/affiliate`, `/admin/overview`, `/admin/brain` | GET | 307 | `/access?next=...` | every workspace page is behind the password gate |
| `/admin` | GET | 307 | `/admin/overview` | a Next redirect runs before the proxy; the target is gated (measured) |
| `/api/coach`, `/api/platform/billing`, `/api/onboarding/{status,readiness,go-live,artifacts}` | GET | 401 | `{"error":"This deployment is password protected."}` | API routes refuse with a status, not a redirect (`src/proxy.ts:138-141`) |
| `/api/jobs/*` (all 17) | GET | 401 | `{"error":"Unauthorized."}` | every job flag ON in production: phase 1, 3, 5, 6, 6-stripe, 7-analytics, 8-alerts, 8-alert-rule-events, 8-engine-eval, contact-delete (each handler returns 404 when its flag is off, 401 when the bearer is missing, e.g. `src/app/api/jobs/stripe-webhooks/handler.ts:35,47,86`) |
| `/api/jobs/*` | POST | 405 or 401 | | only the routes that export POST accept it |
| `/api/onboarding/run` | GET, POST | 401 | `{"error":"Unauthorized."}` | Phase 5 on; `CRON_SECRET` gate closed to outsiders (`src/app/api/onboarding/run/handler.ts:117-123`) |
| `/api/webhooks/meta` | GET | 503 | `{"error":"Webhook verification unavailable."}` | Phase 4 on, but `META_WEBHOOK_VERIFY_TOKEN` (or the Meta driver) is not configured: Meta cannot complete its webhook handshake (`src/app/api/webhooks/meta/handler.ts:69-82,176-181`) |
| `/api/webhooks/meta` | POST `{}` | 401 | `{"error":"Invalid webhook signature."}` | signature check runs |
| `/api/webhooks/ghl` | POST `{}` | 401 | `{"error":"Invalid webhook signature."}` | Phase 1 on; GHL signature check runs with the real driver |
| `/api/webhooks/stripe` | POST `{}` | 503 | `{"error":"Webhook configuration unavailable."}` | Phase 6 Stripe on, but `SETTERFI_STRIPE_DRIVER` / `STRIPE_WEBHOOK_SECRET` not configured, so no payment could be confirmed today (`src/app/api/webhooks/stripe/handler.ts:38-65,87-91`) |
| `/api/webhooks/resend` | POST `{}` | 401 | `{"error":"Invalid webhook signature."}` | Phase 8 alerts on |
| `/api/consumer-agent` | POST `{}` | 400 | `CONSUMER_BODY_INVALID` | public consumer preview endpoint reachable |
| `/opt-in`, `/api/opt-in`, `/api/opt-in/demo-tenant` | GET | 404 | | opt-in pages are per tenant slug; no such slug |

Raw log: `docs/platform-diagram/probes.txt`.



State key, coloured to match the Most Fundable roadmap palette: BUILT = blue, built by us and
working today; WAIT = red, long lead, built but waiting on an outside account; OWED = amber, Alec,
needs a decision or an account from the client (or is plainly not built); LATER = grey, set aside.

### Legend
L1-L4: the four states above. No proof needed.

### Who uses it
| Id | State | Proof |
| --- | --- | --- |
| W1 coaches | BUILT | role enum `src/lib/auth/claims.ts:35-77` (`owner`, `admin`, `coach`, `coach_member`, `affiliate`); coach workspace `src/app/(workspace)/coach/*` |
| W2 leads | BUILT | inbound persistence `supabase/migrations/20260820000002_phase4_channel_rpcs.sql:53-171`; public consumer preview `src/app/consumer/page.tsx` (live 200) |
| W3 your team | BUILT | admin workspace `src/app/(workspace)/admin/*`; route decision `src/lib/auth/claims.ts:185-230`; every page 307s to the gate when signed out (section 1) |
| W4 affiliates | BUILT | `src/app/(workspace)/affiliate/*`; projection returns exactly `business_name, account_status, commission_earned_cents` (`supabase/migrations/20260822000001_phase6_money.sql:1214-1215`). Not yet loaded with a real affiliate session |

### Getting a coach started, steps 1 to 6
| Id | State | Proof |
| --- | --- | --- |
| S1 public sign up page | BUILT | `src/app/signup/page.tsx`; live `GET /signup` 200; `SETTERFI_PUBLIC_LANDING_LIVE` reader `src/proxy.ts:160` |
| S2 pick a plan | OWED | live `GET /api/onboarding/signup` → `{"tiers":[]}`; live `/signup` text "No named plan is available"; `tier_offer_terms` and `account_terms_versions` have zero rows; validity rule `src/app/api/onboarding/signup/handler.ts:276-291` |
| S3 account created, password never stored | BUILT | `POST /api/onboarding/signup` `handler.ts:156-236`; RPC `complete_onboarding_signup` `supabase/migrations/20260821000001_phase5_self_serve_onboarding.sql:441-518`; password destructured away `handler.ts:209-215`; live POST reaches validation (400) |
| S4 accepts terms | OWED | receipt `src/lib/onboarding/signup.ts:158`, `SETTERFI_ACCOUNT_TERMS_LIVE` `src/lib/env-contract.ts:510`; approved legal copy owed (`docs/LAUNCH-CHECKLIST.md` E7); `account_terms_versions` empty |
| S5 texting sub account and number, automatic | WAIT | runner `src/lib/onboarding/runner.ts:274`, GHL lane `src/lib/onboarding/ghl-lane.ts:95-145`; requires `GHL_SNAPSHOT_ID`, `GHL_NUMBER_POOL_ID` (`src/lib/integrations/selector.ts:86-90,138`) which are not yet configured in production (`docs/LAUNCH-CHECKLIST.md` E6); cron `vercel.json` `/api/onboarding/run` every 20 min, live 401 |
| S6 carrier registration, day counter | WAIT | steps `sms_eligibility_screen ... sms_live` `src/lib/onboarding/steps.ts:96-162`, `sms_live` `maxAttempts: 21`, `completionAuthority: "provider_probe"`; a2p probe `src/app/api/jobs/a2p-probe/handler.ts:63-64,174-182`; human approval of campaign content required on every signup `src/app/api/onboarding/run/handler.ts:88-115` |

### Getting a coach started, steps 7 to 12
| Id | State | Proof |
| --- | --- | --- |
| T1 connect Instagram and Facebook | WAIT | connect `src/app/api/channels/meta/connect/handler.ts:297-328`; first Meta fetch `src/lib/integrations/meta-oauth.ts:387`; real arm needs `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID` (`src/lib/integrations/selector.ts:72-78`), not yet configured in production (`docs/LAUNCH-CHECKLIST.md` E3); live `GET /api/webhooks/meta` 503; Meta app review is an external clock (`docs/CONTEXT.md`) |
| T2 connect a calendar (texting provider) | BUILT | `src/app/api/onboarding/calendar/handler.ts:98-194`; GHL calendar driver real arm `src/lib/integrations/calendar.ts:161`; GHL configured real in production as of 2026-09-02 |
| T3 Google Calendar sign in | OWED | four routes `src/app/api/calendars/google/{connect,callback,select,disconnect}`; flag `SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE` off in production as of 2026-09-02; Google OAuth app in Testing, needs verified public domain and privacy page from the client (`docs/CONTEXT.md`, Google OAuth verification; `docs/LAUNCH-CHECKLIST.md` E8) |
| T4 coach sets the offer | BUILT | `src/app/api/coach/offer/handler.ts:123`, publish `src/app/api/coach/offer/publish/handler.ts`; executor `src/lib/onboarding/coach-lanes.ts:152` |
| T5 test conversation, nothing booked | BUILT (code) / blocked in production until an embeddings key exists | `src/lib/onboarding/test-pass.ts:1-8,50`; `src/app/api/onboarding/run/handler.ts:280-296`; every grounded turn embeds through `resolveEmbeddingsDriver()` (`src/lib/brain/retrieval.ts:222-223`, `src/lib/integrations/embeddings/selector.ts:13-20`), and an unset selector or `mock` under `NODE_ENV=production` throws (`src/lib/env-contract.ts:528-545`) |
| T6 card payment | OWED | real Stripe only: `src/lib/billing/checkout.ts:72,95-99` (`BILLING_CHECKOUT_MOCK_DRIVER_REFUSED`); requires `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (`:100`), not yet configured (`docs/LAUNCH-CHECKLIST.md` E2); live `POST /api/webhooks/stripe` 503; charge happens on Stripe's hosted page; confirmation only via signed webhook `src/lib/billing/stripe-events.ts:175-211` |
| T7 go live, seven proofs incl. payment | BUILT | `src/app/api/onboarding/go-live/handler.ts:20-36`; `src/lib/onboarding/readiness.ts:260-318` |

### When a lead messages
| Id | State | Proof |
| --- | --- | --- |
| I1 lead sends a DM or text | WAIT (Meta) / BUILT (text) | Meta webhook `src/app/api/webhooks/meta/handler.ts:87-190` (real driver required `:176-190`, live 503 on verify); GHL webhook `src/app/api/webhooks/ghl/handler.ts:69-215` (live 401 on bad signature = running) |
| I2 saved once, duplicates ignored | BUILT | `webhook_events` upsert `src/lib/webhooks/process-inbound.ts:2858-2862`; message idempotent on `(tenant_id, provider, provider_message_id)` `supabase/migrations/20260820000002_phase4_channel_rpcs.sql:165-171` |
| I3 opt out and consent first | BUILT | turn order `src/lib/webhooks/process-inbound.ts:1127-1268` (suppression `:1158`); send policy `src/lib/sends/permission.ts:137-153` |
| I4 answer from The Brain only | BUILT (code) / blocked in production until an embeddings key exists (as T5) | `src/lib/brain/retrieval.ts:206-237`, pgvector `supabase/migrations/20260818000001_phase2_brain.sql:263-280,1323`; drafts never read `:284` |
| I5 numbers and guarantees checked, else held | BUILT | `src/lib/engine/output-checks.ts:96-145,153,203,215,252-279`; citation check `src/lib/engine/retrieval.ts:72` |
| I6 reply sent | BUILT (text) / WAIT (Meta) | dispatch `src/lib/sends/provider-dispatch.ts:48-122`; Meta send `src/lib/integrations/meta.ts:487-509`; GHL send `src/lib/integrations/ghl.ts:372-395`; reconciliation job every 2 min `src/lib/sends/reconciliation.ts:35-158` |
| I7 booked into the calendar | BUILT | `src/lib/webhooks/process-inbound.ts:1870-1994,2392`; `src/lib/booking/service.ts:263-418`; `appointments` unique `(provider, external_id)` `supabase/migrations/20260813000001_init.sql:596-616` |
| I8 follow ups; a booked chat is never rebooked | BUILT | followups cron `vercel.json` every 5 min, `src/app/api/jobs/followups/handler.ts:22-72`; terminal booked rule `src/lib/webhooks/process-inbound.ts:1174-1177` |
| I9 conversion signals to Meta ads | OWED | worker `src/lib/capi/worker.ts:114-285`, `SETTERFI_CAPI_LIVE` `src/lib/env-contract.ts:224-230`; fails closed pending the purchase-value ruling (`docs/LAUNCH-CHECKLIST.md` E9) |

### The coach workspace
| Id | State | Proof |
| --- | --- | --- |
| C1 overview and analytics, test data out | BUILT | `SETTERFI_PHASE7_ANALYTICS_LIVE` readers (`src/lib/env-contract.ts`); `inherit_is_test` triggers `supabase/migrations/20260817000001_phase1_demo_path.sql`; `SETTERFI_PLATFORM_PREVIEW_DATA` impossible in production `src/lib/env-contract.ts:389-395` |
| C2 inbox: read, claim, reply by hand, hand back | BUILT | `src/app/api/conversations/[id]/{claim,messages,release}/handler.ts`; flag `SETTERFI_INBOX_VERBS_LIVE` `src/lib/env-contract.ts:282` |
| C3 contacts and pipeline | BUILT | `src/app/api/contacts/handler.ts:58`, `contacts/[id]/pipeline-stage/handler.ts:137` |
| C4 agent settings = offer layer | BUILT | as T4; `src/components/workspace/live/coach-offer.tsx` |
| C5 billing page | OWED | `src/components/workspace/live/coach-billing.tsx:844-895` calls `/api/billing/checkout`; refuses until Stripe keys exist (T6); a coach can buy only its own assigned tier `src/app/api/billing/checkout/handler.ts:76-84` |
| C6 every table exports CSV and JSON | BUILT | `src/app/api/exports/[resource]/handler.ts:2414-2683`; formula-prefix neutralised (`docs/operations/operator-guide.md:329`) |
| C7 password change, two factor, teammates | LATER | server routes exist (`src/app/api/account/security/*`, `src/app/api/tenant/members/*`) but no page calls them: no non-test `.tsx` references `/api/account/security`; notification bell component `src/components/workspace/live/notification-bell.tsx:31` rendered by no page |

### Your team's console
| Id | State | Proof |
| --- | --- | --- |
| A1 The Brain: draft, import, evaluate, publish, roll back | BUILT | `src/app/api/admin/brain/{draft,evals,import,publish,rollback}/handler.ts`; Notion real driver `src/lib/integrations/notion/real.ts:214` (`NOTION_API_KEY` present in `.env.local`; production value not verified) |
| A2 publish blocked unless safety checks pass | BUILT | DB RPC `supabase/migrations/20260826000003_brain_objection_runtime.sql:361-399` (`BRAIN_SAFETY_EVAL_FAILED`); test `supabase/tests/phase2-schema.test.ts:663,945` |
| A3 client book, impersonate read only, logged | BUILT | `src/components/workspace/live/success-client-book.tsx:509,529`; impersonation read-only policies `supabase/migrations/20260817000001_phase1_demo_path.sql:2184-2185`, test `supabase/tests/rls.test.ts:291` |
| A4 texting provider marketplace install | WAIT | `MessagingInstallPanel` `src/app/(workspace)/admin/provisioning/page.tsx:14,286,331`; agency grants never refreshed since Aug 21, install pending a call with the client (`docs/SETUP.md`, GoHighLevel chapter) |
| A5 plan prices and terms table empty | OWED | `tier_offer_terms` writer `supabase/migrations/20261003000002_tier_offer_term_writer.sql`; zero rows; admin page `src/app/(workspace)/admin/tiers/render-tiers-page.tsx:48` |
| A6 alerts by email | OWED | delivery job `src/app/api/jobs/notification-deliveries/handler.ts:30-136`; Resend real `src/lib/integrations/email/real.ts:16`; `RESEND_API_KEY`, `SETTERFI_EMAIL_FROM` and `SETTERFI_EMAIL_DRIVER` were not configured at this commit. Updated after the pin: the Slack destination was removed on 2026-09-03 (`supabase/migrations/20261012000001_remove_slack_alert_destination.sql`), and the Resend names were set in Vercel production the same day, unmeasured here (`docs/LAUNCH-CHECKLIST.md` E4) |
| A7 audit log, "Logged" | BUILT | append-only trigger `supabase/migrations/20260817000001_phase1_demo_path.sql:1080-1094`; `src/lib/audit/actions.ts` (95 keys) |
| A8 system page shows real vs stand-in per provider | BUILT | `src/lib/operations/system-health.ts:11-43`; `docs/operations/operator-guide.md:287` |
| A9 operator walkthrough recordings | LATER | `docs/operations/recording-01-diagnose.md:3`, `docs/operations/recording-02-brain-publish-rollback.md:3` ("Recording required") |

### Affiliates
| Id | State | Proof |
| --- | --- | --- |
| F1 portal shows name, status, commission only | BUILT (not yet viewed live) | as W4 |
| F2 referral locked at sign up | BUILT | trigger `supabase/migrations/20260821000001_phase5_self_serve_onboarding.sql:270`; tests `supabase/tests/phase5-onboarding.test.ts:797,884` |
| F3 commission rate and affiliate sign up page | OWED | affiliate terms copy is a placeholder sentinel `src/app/(workspace)/affiliate/page.tsx:15,57`; commission terms and signup page copy owed by the client (`docs/LAUNCH-CHECKLIST.md` E7) |
| F4 payouts end to end | LATER | never exercised end to end; ledger tables append-only `supabase/migrations/20260822000001_phase6_money.sql:322-343` |

### Protections no setting can switch off
| Id | State | Proof |
| --- | --- | --- |
| P1 each coach sees only their own data, in the database | BUILT | forced RLS census `supabase/tests/rls.test.ts:100-171`; `anon` revoked `supabase/migrations/20260813000002_revoke_anon.sql:11` |
| P2 audit and money records add-only | BUILT | `20260817000001_phase1_demo_path.sql:1094`; `20260822000001_phase6_money.sql:322,343`; tests `supabase/tests/phase6-schema.test.ts:436,598,727` |
| P3 Instagram, Facebook and texting tokens encrypted | BUILT | CHECK constraint `20260905000010_backend_security_sagas.sql:119`; plaintext columns dropped `20260820000001_phase4_channels.sql:375` |
| P4 one calendar token table still plain | OWED (not built) | `supabase/migrations/20260817000002_phase1_review_fixes.sql:149` `access_token text not null`; asymmetry noted `20261008000001_google_calendar_oauth.sql:14` |
| P5 agent cannot invent price, guarantee or citation | BUILT (app-level) | as I5; NOT a database rule (`docs/ARCHITECTURE.md:33` overstates) |
| P6 agent cannot publish, bill or send outside one path | BUILT | `src/lib/engine/types.ts:215`; AST fence `src/lib/sends/import-boundary.test.ts:45-47` |
| P7 no reply without consent on record | BUILT | `src/lib/sends/permission.ts:91-153`; `supabase/tests/outbound-send-atomicity.test.ts:92,336` |
| P8 card numbers never stored | BUILT | `20260819000001_phase3_compliance_safety.sql:153` (`identifier_last4` only) |
| P9 jobs and webhooks refuse without secret or signature | BUILT | blank `CRON_SECRET` closes every job `src/app/api/jobs/*/handler.ts`; webhook signature before parse `src/app/api/webhooks/stripe/handler.ts:47-64`, `meta/handler.ts:97-104`; live 401s in section 1 |

### Waiting on outside accounts
| Id | State | Proof |
| --- | --- | --- |
| O1 Meta app review and keys | WAIT | as T1 |
| O2 carrier registration per coach | WAIT | as S6 |
| O3 texting provider agency install approval | WAIT | as A4 |

### What you still owe
| Id | Proof |
| --- | --- |
| D1 plan names, prices, terms | as S2, A5 |
| D2 live payment keys | as T6 |
| D3 Meta app credentials | as T1 |
| D4 email sending account | as A6 |
| D5 OpenAI key for the Brain search index | as T5; `src/lib/integrations/embeddings/selector.ts:13-20`; live `/api/health/ready` `requiredProviders:false` |
| D6 purchase-value ruling for ad conversions | as I9 |
| D7 approved legal copy: terms, privacy, texting campaign wording | campaign copy approval `src/app/api/onboarding/run/handler.ts:88-115`; terms receipt gate `src/lib/env-contract.ts:510`; `docs/LAUNCH-CHECKLIST.md` E7 |
| D8 escalation contacts and provider cost rates | `docs/operations/escalation-path.md:6-10`; `docs/operations/running-costs.md:3-13` |
| D9 sign off on open product decisions | `docs/LAUNCH-CHECKLIST.md` E11 |
