# Client Demo Cleanup

## Scope And Evidence

This pass covers only the named production UI defects, tier names, signup terms enforcement,
Provisioning Run visibility, and phase/provider consistency. It changes no feature flag, provider
selector, access password, demo login, or deferred security/role behavior.

Production baseline: `fc0f6cb6158ff9adad3bcb7baf92883ff64b9fd1`, Vercel Ready. The production build
log reports GHL, OpenRouter, embeddings and email as real; Meta, provisioning and Stripe as mock.
The first-customer checker remains explicitly disarmed and reports missing Notion configuration.
Sensitive Vercel values are masked by the API, so its environment list proves presence only.
The disagreements below are corroborated by the deployed build's conditional requirements and
provider report, not by treating local environment values as production values.

## Named Defects

| Item | Finding and action |
| --- | --- |
| Inbox Filters | Already replaced by a working channel menu in `coach-inbox.tsx`; options and filtering covered by interaction tests. |
| Agent tone chips | Already real buttons with selected state and editing behavior; existing interaction tests pass. |
| Light-theme Help and bubble | Help's old composer was replaced; the support bubble has a filled launcher and its send action uses the background shorthand. Admin reply uses the kit primary button. Existing targeted tests pass; visual production confirmation remains open. |
| Revenue subscription view and rows | Existing facet changes table filtering; row clicks open the subscription sheet. No new changes needed. |
| Audit subtitle escapes | Current Audit copy contains actual quotation marks, in its context explanation rather than the old subtitle. No new change needed. |
| Affiliate bulk bar | Existing floating toolbar no longer inherits inline-size containment; its layout regression test passes. |
| Affiliate referral link | Existing endpoint suppresses the link when signup cannot quote a plan. This pass additionally requires enabled acceptance and published account terms. |
| Affiliate row count | Current portal counts `referrals.length`; it no longer includes a synthetic Total row in the table. |
| Tier names | Rename only the three contract rows to Starter, Growth and Scale; retain Growth (demo) and Agency (demo) as inactive demo records. Keep raw plan names visible and group by those names, so a demo is not presented as a historical contract version. Update seed names to prevent reintroduction. |
| Signup without terms | Refuse before Supabase Auth or orchestration when acceptance is off or no version is published. Page and referral-link availability agree with that refusal. |
| Provisioning Run | Current receipts are skipped, not failed, because `SETTERFI_GHL_PROVISIONING_DRIVER` is absent. Existing System UI displays amber Not configured, missing variable names and waiting duration. No cron/provider change made. |

## Phase And Provider Audit

| Phase flag | Production configuration finding | Treatment |
| --- | --- | --- |
| PHASE1 | GHL and OpenRouter reported real; no corresponding missing configuration in the build report. | Preserve. Configuration is not delivery proof. |
| PHASE2 | Embeddings real, Notion selector absent. | Warn that Notion knowledge imports cannot run; do not imply the existing published knowledge is absent. |
| PHASE3 | GHL reported real; no corresponding missing configuration in the build report. | Preserve; no consent, deletion or suppression behavior changed. |
| PHASE4 | Meta selector absent; app ID, app secret and webhook verification token missing. | Warn on channel health, Inbox, Agent and setup. Do not wire real OAuth or change CAPI. |
| PHASE5 | Provisioning selector, snapshot ID and number pool ID absent. | Warn on provisioning/client/setup surfaces; System lists all configuration gaps alongside its existing skipped receipt. |
| PHASE6 | Stripe capability enabled, selector and both Stripe credentials absent. | Warn on billing, tiers and affiliate surfaces. Preserve the separate Stripe capability and provider selector. |
| PHASE7 | OpenRouter reported real; no corresponding missing configuration in the build report. | Preserve; synthetic analytics remain separately labelled. |
| PHASE8 | Email and OpenRouter reported real; no corresponding missing configuration in the build report. | Preserve; no job-failure alert work. |
| PHASE9 | GHL reported real; OAuth configuration requirements absent from the missing list. | Preserve. Stored grant validity and successful installs are separate evidence. |

The read-only phase/provider projection checks all nine phases in each running environment and
names unavailable actions on relevant screens. System shows every disagreement with variable
names only. It neither activates providers from credentials nor changes phase settings.

The local development System response was also checked: phases 1 and 3 lack the GHL selector;
phase 2 lacks Notion; phase 4 lacks Meta selection/configuration; phase 5 lacks provisioning
selection/configuration; phase 6 lacks Stripe selection/configuration; phase 8 lacks email
selection/from-address. Phases 7 and 9 have no active provider disagreement in that local
configuration. These are local findings, not substitutes for the production audit above.

## Database Read-Back

The names-only migration was applied to the shared hosted database and recorded in migration
history. A transaction compared every tier's non-name fields before and after (excluding the
automatic update timestamp) and would have rolled back any other change.

Active tiers remain $297 / 25 calls, $597 / 75 calls, and $997 / 75 with `is_uncapped=true`.
Fair-use values and placeholder Stripe IDs are unchanged. Renaming these tiers does not make
them Stripe-backed offers. No offer-term or account-terms rows were authored or published.

## Deliberately Left

No deferred credential, token migration, role, 401/403, alert, CAPI, Meta-orphan, retention or Slack
work was performed. No flag was deleted or flipped, and FIRST_CUSTOMER_ENFORCE was not armed.
Provider credentials, actual Stripe prices and approved account terms remain prerequisites.

Later retirement candidates: PHASE7_LIVE and PHASE9_LIVE are parent rollout switches whose
children retain narrower release authority; consider retiring the parents only after acceptance
and caller review. FIRST_CUSTOMER_ENFORCE is temporary build-policy debt, but removing its
current setting alone would re-arm the build failure, so it is explicitly untouched here.

## Verification Limits

Full suite: 617 test files passed, four skipped; 7,434 tests passed, 13 skipped. Typecheck and
targeted lint passed. Local HTTP reads verified the terms-unavailable signup page and the
names-only configuration notice on the signed-in System page.

The connected browser tool was unavailable. The fallback browser could not launch in this
environment. Signed-in HTTP reads of production were stopped by the existing shared access gate;
the local password did not grant access. It was not changed or bypassed. Source, component tests,
production build logs and database read-back are evidence; production visual acceptance is not
claimed.
