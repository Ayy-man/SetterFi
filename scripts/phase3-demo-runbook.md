# Phase 3 compliance and safety demo runbook

This runbook keeps source, local database, mock demo, authenticated browser, provider, and
deployment evidence separate. The local demo uses synthetic test rows and Mock drivers only; it
does not prove a provider mutation, a deployed schedule, or a signed-in browser workflow.

## Local sequence

1. Confirm the shared local `SetterFi` stack is running. Never use `supabase db reset`.
2. Run `npm run db:migrate`; an already-applied migration reports no pending files.
3. Run `npm run demo:seed`. The read-back must show demo/test Phase 3 contacts, conversations,
   follow-ups, suppressions, one deletion tombstone, and verified test-recipient registration.
4. Run `npm run demo:run`. The runner uses port 3218, Mock dispatch only, and a runtime-only
   suppression pepper. It must print `STOP confirmation refused — copy_unapproved`, prove an
   outbound delta of zero, and retain `approved=false` for platform copy.
5. Run `npm run demo:reset` twice. Each reset deletes only deterministic demo IDs under the guarded
   demo tenant, retains immutable audit rows, reseeds the baseline, and preserves Phase 4's exact
   counts: conversations 2, identities 6, connections 4, templates 10, candidates 1, and test
   recipients 0.
6. Run `npm run verify`, `npm run test:rls`, and `npm run build`.

The seeded states are suppressed-confirmed, suppressed-provider-unconfirmed, deferred once for
quiet hours, refused for no consent, escalated, scope-blocked, nurture, stale, re-opened, deletion
preview, immediate deletion with tombstone read-back, durable/window-bound/none capabilities, and
CSV/JSON follow-up export. All labels describe synthetic local state.

## Authenticated browser UAT

Browser UAT requires an authenticated coach and platform-admin session against the same demo
tenant. If those sessions are unavailable, record every step as `BLOCKED — authenticated browser
session unavailable`; source inspection or an HTTP response is not a substitute.

1. On `/coach/agent`, inspect SMS as durable, a Meta channel as window-bound, and the empty/closed
   capability as no automated follow-up. Confirm the visible text never promises a send.
2. On `/coach/conversations`, inspect deferred, no-consent, escalated, scope-blocked, nurture,
   stale, and re-opened rows. Confirm Demo and Test labels are visible.
3. Export the follow-up table as CSV and JSON as a coach. Confirm platform-only fields are absent.
4. On `/admin/compliance`, inspect confirmed and unconfirmed suppressions and the deletion
   tombstone. Confirm `Provider suppression confirmed` appears only with persisted confirmation.
5. Open contact deletion, confirm focus enters the dialog, Tab stays inside, Escape/cancel restores
   focus, preview counts are announced, and the final deletion result announces the audit receipt
   and tombstone count.
6. Export current suppressions as CSV and JSON. For tombstones, enter a reason and confirm the
   platform-only export gate; coach access must remain denied.
7. Inspect every `Logged` action label and confirm it comes from the audit registry-backed control.

No authenticated browser session was available to this executor, so these observations remain
human-owed and are not part of the local green gate.

## Real and deployment arms

- GHL Real is `SKIPPED` unless `SETTERFI_GHL_DRIVER=real` and the named configuration
  `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_WEBHOOK_PUBLIC_KEY`,
  `SETTERFI_GHL_TEST_ACCESS_TOKEN`, `SETTERFI_GHL_TEST_LOCATION_ID`,
  `SETTERFI_GHL_TEST_CALENDAR_ID`, and `SETTERFI_GHL_TEST_CONTACT_ID` is usable. The provider must
  originate the signed receipt; a synthetic webhook is not evidence.
- Meta Real is `SKIPPED` unless `SETTERFI_META_DRIVER=real` and `META_APP_ID`, `META_APP_SECRET`,
  `META_SYSTEM_USER_TOKEN`, `META_WEBHOOK_VERIFY_TOKEN`,
  `SETTERFI_CREDENTIAL_ENCRYPTION_KEY`, `META_WHATSAPP_SYSTEM_USER_TOKEN`, `META_WABA_ID`, and
  `META_WHATSAPP_PHONE_NUMBER_ID` are usable with named sandbox identities.
- OpenRouter Real is `SKIPPED` unless `SETTERFI_OPENROUTER_DRIVER=real` and `OPENROUTER_API_KEY` is
  usable. A skip is never recorded as a pass.
- `SETTERFI_PHASE3_LIVE` remains off when absent. Enabling it locally does not prove a deployed
  environment, provider setup, or scheduler receipt.
- The unconditional daily `compliance-reconcile` schedule is source-proven. Its deployed execution
  receipt is blocked until the orchestrator supplies deployment evidence.
- Five-minute follow-up precision is deployment-gated. The Phase 2 nightly/pre-publish
  reconciliation invocation remains blocked until its route/test receipt exists.
- Client STOP/HELP/START and scope copy remains unapproved. The approved-copy unit fixture proves
  the confirmation branch, while the demo stays visibly blocked on `copy_unapproved` pending
  Alec's wording.
