# Phase 1 Milestone-2 demo runbook

This runbook proves the credential-independent local path and keeps provider, deployment, database,
and browser evidence separate. A local green run does not prove a provider receipt, a deployed cron,
or a live UI. The phase remains blocked for a real-provider claim while a required Real arm is
SKIPPED.

## Prerequisites and arms

- The shared local Supabase project `SetterFi` is running on API port 54321 and database port 54322.
- `SETTERFI_AUTH_MODE=supabase` is required for signed-in live surfaces; `SETTERFI_PHASE1_LIVE=true`
  enables the Phase 1 backend without changing the empty-environment fixture path.
- The selector names are `SETTERFI_GHL_DRIVER`, `SETTERFI_OPENROUTER_DRIVER`, and
  `SETTERFI_META_DRIVER`. Missing selectors choose Mock. Explicit Real selection with an incomplete
  named configuration fails closed.
- The reset scripts are for a local stack that holds only this phase's fixture; against a populated
  or hosted database use the seeder order in `docs/SETUP.md` section 1.7 instead. Hosted reset
  additionally requires `SUPABASE_DB_PASSWORD`; hosted seed/reset always require
  `SUPABASE_SERVICE_ROLE_KEY`, `--confirm-hosted`, a standard Supabase project hostname, and an
  existing read-back of the deterministic tenant with `is_demo=true`.
- GHL Real requires `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_WEBHOOK_PUBLIC_KEY`,
  `SETTERFI_GHL_TEST_ACCESS_TOKEN`, `SETTERFI_GHL_TEST_LOCATION_ID`,
  `SETTERFI_GHL_TEST_CALENDAR_ID`, and `SETTERFI_GHL_TEST_CONTACT_ID`. The provider must originate
  the signed inbound; the conflict probe uses only those named test resources.
- OpenRouter Real requires `OPENROUTER_API_KEY`. Meta Real requires `META_APP_ID`,
  `META_APP_SECRET`, `META_SYSTEM_USER_TOKEN`, and `META_WEBHOOK_VERIFY_TOKEN` plus a sandbox identity.
- The schedule is named `phase1-appointment-reconcile-daily`. Its deployment schedule and
  Vercel Hobby-versus-Pro cron eligibility/limits are UNVERIFIED until deployment evidence exists.
- The disclosure and eight held replies remain migration-seeded DRAFT content with `approved=false`.
  The demo tenant may execute the DRAFT; non-demo tenants refuse it. Alec must approve this content
  before a non-demo send is eligible. The seed never changes approval.
- A2P remains `registering` while the carrier clock runs; the operator copy says 2–3 weeks. A terminal
  10DLC rejection is permanently blocked and is never rendered as done or all set.

## Solo sequence

Each numbered step contains one command or one on-screen observation.

1. Run `npm run demo:env-check`.
2. Run `npm run demo:seed`.
3. Run `npm run demo:run`.
4. Observe `/coach/conversations` showing the tenant-scoped inbound, system rows, and trace-backed outbound on live data.
5. Observe `/coach/contacts` showing typed BOOK qualification for the demo contact.
6. Observe the provider-ID appointment as test-labelled, with no demo billable or booking-notification row.
7. Observe takeover showing `human`, the held inbound unread, and no agent response.
8. Observe handback showing `agent` and the migration-seeded automated-experience disclosure once.
9. Run `npm run dev` in a second terminal when testing the reconciliation fallback.
10. Run `curl --fail-with-body --silent --show-error -H "Authorization: Bearer ${CRON_SECRET}" http://127.0.0.1:3000/api/jobs/appointment-reconcile`.
11. Observe a successful reconciliation response and persisted appointment read-back; if `CRON_SECRET` or a server is absent, record SKIPPED with that reason.
12. Run `npm run demo:reset`.
13. Run `npm run demo:reset` again to prove idempotency.

The reset calls the calendar cancellation path for every demo-created appointment carrying a
provider external ID before its tenant-scoped transaction deletes local product rows. It retains
immutable audit evidence, restores the deterministic baseline, and prints post-reset counts.

## Evidence boundaries

- **Mock:** proves the full persisted local path and no external provider behavior.
- **OpenRouter Real:** proves only returned provider metadata plus the persisted trace.
- **GHL Real:** proves signed receipt/install/calendar IDs, conflict/re-offer, appointment read-back,
  and reset cancellation. A real booking must include the provider conflict probe.
- **Meta Real:** proves only the sandbox webhook/message arm actually exercised.
- **SKIPPED:** proves nothing beyond the named missing prerequisite.

No external email delivery is claimed by this phase. CSV/JSON export availability is tested
separately from a deployed 100,000-row load; the provisional cap remains UNVERIFIED for production
until that deployed load evidence exists.

## Success-criterion evidence

| Criterion | Automated evidence | Manual or Real evidence | Verdict |
|---:|---|---|---|
| 1 | `npm run demo:run`; timed receipt row below; replay/tenant identity tests in `npm run verify` and `npm run test:rls` | GHL signed receipt is required for a provider claim | Local Mock proved; Real SKIPPED |
| 2 | Engine, qualification, safety, and demo-contract tests in `npm run verify` | OpenRouter provider metadata and persisted trace | Mock proved; Real SKIPPED |
| 3 | Booking/calendar tests plus test appointment read-back in `npm run demo:run` | Eligible GHL provider ID, real appointment/billable read-back, conflict/re-offer, and reset cancellation | Mock test suppression proved; Real SKIPPED |
| 4 | Claim/hold/release/disclosure in `npm run demo:run`; audit/RLS tests | Steps 4, 7, and 8 on live surfaces | Persisted Mock proved; browser observation pending |
| 5 | Seed, runner, and two resets | Solo sequence | Local proved |
| 6 | Prompt and renderer tests in `npm run verify` | None | Automated |
| 7 | Output-check/pipeline tests in `npm run verify` | None | Automated |
| 8 | Number provenance tests in `npm run verify` | None | Automated |
| 9 | Moderator/vendor/trace tests in `npm run verify` | OpenRouter Real trace | Automated; Real SKIPPED |
| 10 | Exact response-key tests in `npm run verify` and demo-contract test | None | Automated |
| 11 | Safety corpus in `npm run verify` | None | Automated |
| 12 | Trace repository and RLS checks in both test suites | Platform UI observation | Automated; browser observation pending |
| 13 | Transactional audit registry and immutability checks in `npm run test:rls` | Logged labels on live surfaces | Automated; browser observation pending |
| 14 | Impersonation route/session/RLS checks in both test suites | Signed-in platform preview | Automated; browser observation pending |
| 15 | Role-matrix and affiliate RLS checks in `npm run test:rls` | None | Automated |
| 16 | Trigger/aggregate RLS checks plus seed read-back | Demo badges on admin surfaces | Database proved; browser observation pending |
| 17 | Engine state-gate tests plus held inbound in `npm run demo:run` | Step 7 | Persisted Mock proved |
| 18 | Qualification progression tests in `npm run verify` | None | Automated |

### Criterion 1 timed receipt

| Start UTC | End UTC | Elapsed ms | Tenant | Provider event ID | Message row ID | Arm |
|---|---|---:|---|---|---|---|
| 2026-08-17T07:54:24.735Z | 2026-08-17T07:54:24.827Z | 92 | `81000000-0000-4000-8000-000000000001` | `81000000-0000-4000-8000-000000000001:demo-event-35035220-de89-4dc3-87e6-c533240305a5:demo-inbound-35035220-de89-4dc3-87e6-c533240305a5` | `28afe93c-c9e5-4fc9-aeb7-2237eaed70bf` | Mock |

## Phase 1 requirement evidence

| Requirement | Evidence | Provider/manual limit |
|---|---|---|
| CHAN-01 | GHL install reconciliation tests and `npm run test:rls` | Real install SKIPPED |
| CHAN-02 | GHL selector, token, and receipt tests | Real token arm SKIPPED |
| CHAN-03 | `npm run demo:run` inbound identity/read-back | Real signed inbound SKIPPED |
| CHAN-04 | GHL replay and tenant-scoping tests | Real provider replay SKIPPED |
| CHAN-05 | GHL send/permission tests | Real test-recipient send SKIPPED |
| CHAN-11 | Meta webhook/driver tests | Real sandbox arm SKIPPED |
| ENG-01 | Model selector/config/pipeline tests | OpenRouter Real SKIPPED |
| ENG-02 | Prompt/retrieval/renderer tests | None |
| ENG-03 | Qualification and pipeline tests | None |
| ENG-04 | Brain retrieval and provenance tests | None |
| ENG-05 | Safety corpus and output-check tests | None |
| ENG-06 | Moderator/vendor tests | OpenRouter Real SKIPPED |
| ENG-07 | Trace repository and RLS tests | Platform browser observation pending |
| ENG-08 | State-gate and held-inbound tests plus runner | None |
| ENG-09 | Step progression tests | None |
| ENG-10 | Exact public response-key tests | None |
| SEC-07 | Impersonation session and write-denial tests | Signed-in preview pending |
| SEC-08 | Role matrix and affiliate RLS tests | None |
| AUD-01 | Audit registry tests | Logged UI observation pending |
| AUD-02 | Transactional claim/release audit tests | None |
| AUD-03 | Immutable audit RLS tests | None |
| AUD-04 | Second-party/reason audit tests | None |
| AUD-05 | Registry-backed microcopy tests | Logged UI observation pending |
| ANL-07 | Demo exclusion and aggregate-source tests | Deployed aggregate observation pending |
| ANL-09 | Pipeline transition/contacts tests | Contacts browser observation pending |
| BOOK-01 | Calendar conflict/re-offer tests | GHL real slot/conflict probe SKIPPED |
| BOOK-02 | Provider-first booking and replay tests | Real appointment ID/read-back SKIPPED |
| BOOK-03 | Appointment billing/notification tests and runner suppression read-back | Real non-test billable/alert SKIPPED |
| BOOK-04 | Appointment reconcile tests | Deployed schedule UNVERIFIED |
| BOOK-05 | Export contract tests | Deployed 100,000-row load UNVERIFIED |
| HAND-01 | Runner claim/held inbound plus claim tests | Browser observation pending |
| HAND-02 | Human reply/note tests | Browser observation pending |
| HAND-03 | Runner release/disclosure plus release tests | Browser observation pending |
| HAND-04 | Guardrail-clear and audit tests | Browser observation pending |
| HAND-05 | CAS/displacement tests | Multi-actor browser observation pending |
| DEMO-01 | `npm run demo:seed`, `npm run demo:run`, `npm run demo:reset` | Real providers SKIPPED |
| DEMO-02 | Runbook, env check, full gate, and evidence tables | Deployment/browser/provider evidence remains separate |

## Gate and evidence record

Record exact pass/fail/skip counts in `01-08-SUMMARY.md` after running:

```text
npm run demo:env-check
npm run demo:seed
npm run demo:run
npm run demo:reset
npm run demo:reset
npm run verify
npm run test:rls
npm run build
```

Mock completion is a code/local-database gate. Phase completion as a real-provider demo remains
blocked until criterion 2 and criterion 3 have eligible Real evidence, and any claimed Meta arm has
its own sandbox receipt and persisted message read-back.
