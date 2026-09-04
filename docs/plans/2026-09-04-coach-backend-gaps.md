# Coach console backend gap audit - round 1

Scope: every figure, list, and action on the redesigned coach-console artboards
(`design/coach/*.dc.html`) against the actual read/write paths in `src/lib` and
`src/app/api`. Write scope for this round was `src/lib/**`, `src/app/api/**`,
`supabase/migrations/**` (new files only), and `scripts/**`. UI (`src/components/**`,
`src/app/(workspace)/**`) was other agents' work and is not touched here.

Method: for each artboard, find the existing function first, then implement only genuine
gaps. The console turned out to already have a mature backend from prior rounds, so most
rows below say "already complete" - that is the honest finding, not a shortcut. A metric
with no evidence renders absent, never zero, per `src/lib/repositories/measurement-evidence.ts`;
that rule shaped every judgement call below.

## Home (`Main.dc.html`, `HomeFirstRun.dc.html`)

| element | data/action | function or GAP | this round |
|---|---|---|---|
| Six KPI bubbles (booked, new, DQ, conversion, avg time-to-book) | `coach.*` metric set | `loadCoachMeasurement` (`src/lib/repositories/analytics.ts`) + `metric-definitions.ts` | Already complete |
| Active leads, split into agent-handling vs needs-you | two counts, not one | `coach.active_leads` (`metric-definitions.ts:197`) is a single total; no metric or RPC field separates it by `conversations.status` | **GAP, deferred.** `conversations.status` (`agent`/`needs_human`/`human`/`nurture`/`closed`/`opted_out`, `20260813000001_init.sql:54`) is exactly the signal needed. Round 2 should add `coach.active_leads_agent_handling` and `coach.active_leads_needs_you` to `read_coach_measurement`'s metric set in a new migration (`create or replace function`, never editing the applied one), joining each active-cohort contact's latest conversation status, with the two counts summing to `coach.active_leads` as a conservation check the same way the keyword rows already sum to their total. Not attempted this round: it touches a shared RPC several other consumers read, and round 1's priority list was the trend and keyword table specifically. |
| Cohort-attributed conversion rate | denominator = contacts created in window, numerator = same contacts ever booked, still-filling flagged | `coach.conversion_rate` in `read_coach_measurement` RPC, `cohort_state` flag, documented in `metric-definitions.ts:238-248` | Verified matches spec exactly. No change. |
| Six-month trend, metric switcher (booked / qualified / total / booked rate) | per-month total, qualified, booked, partial flag | `loadCoachLeadComposition` → `read_coach_lead_composition` RPC (`20261009000003_coach_composition_booked_by_period.sql`) | `months[]` carries total/qualified/partial; `bookedByPeriod[]` carries booked. Booked rate is a per-month division derivable from the two at the view-model layer - no new backend surface needed. No change. |
| Keyword table, "No keyword" row | per-row denominator = conversations, covers whole population | `read_coach_measurement` SQL groups on `coalesce(nullif(btrim(first_touch_keyword),''),'No keyword')` (`20260823000001_phase7_measurement.sql:1371-1390`); `loadCoachMeasurement` passes it through | Already complete - the RPC already emits the row, sorted last. Fixed a stale comment in `analytics.ts` that read as if the row were suppressed; it only refuses to *manufacture* one when the window has zero conversations (honest-absence, has a regression test). (Note: an earlier parallel worker on this round misread a different, unrelated function, `app.phase13_keyword_measurement` in `20261007000001_keyword_goals_capi.sql`, as the one backing this table and reported this as a gap - it is not; `read_coach_measurement` is the function `loadCoachMeasurement` actually calls, and it already carries the row.) |
| Keyword table, rates suppressed under 10 senders | per-row rate blanks below a minimum sample | none in the repository layer | **GAP, deferred but low-risk.** `CoachKeywordRow` returns raw counts (`conversations`, `qualifiedContacts`, `respondedConversations`, `bookedContacts`) with no rate fields computed server-side, so there is nothing today enforcing "rates absent under 10 senders" anywhere. This is safe to apply at the presentation layer directly off `row.conversations < 10` without a backend change, since the repository already exposes the exact denominator needed; flagging here so the count is not reinvented as a second source of truth, and so whichever surface renders this table applies the threshold. |
| Top objections (moved to Agent tab in round 2) | ranked, booked rate, hard-gate | `loadCoachTopObjections` → `read_coach_top_objections_for_actor` (`analytics.ts:557`) | Already complete |
| Setup rungs, carrier day counter, blocked step, channel states (HomeFirstRun) | `provisioning_steps`, real elapsed days | `src/lib/repositories/onboarding-steps.ts`, `onboarding-evidence.ts` | Not audited in depth this round - pre-existing onboarding repositories cover this surface; no report of a gap from prior work. Flagged for a closer pass in round 2 if the UI agents surface a mismatch. |

## Inbox (`Inbox.dc.html`)

| element | data/action | function or GAP | this round |
|---|---|---|---|
| Three views (needs you / agent handling / everything) | server-side filter | `listConversations`/`listConversationSet`, `CONVERSATION_VIEWS` (`src/lib/repositories/conversations.ts`) | Already server-side. No change. |
| Thread list: channel chip, age | `channel`, `lastActivityAt` | `ConversationRead` | Already present. No change. |
| Agent on/off toggle → in-thread handover line | one audited write, "Automation paused · [name] took over" | `claim_conversation` RPC via `src/lib/audit.ts:claim` | **GAP, fixed.** The RPC inserted a generic "A person joined this conversation." with no name. New migration `supabase/migrations/20261012000003_takeover_named_handover_line.sql` redefines `claim_conversation` to look up the actor's `full_name` (falling back to email) and insert `'Automation paused · ' || actor_name || ' took over'` as a `direction='system'` message, inside the same audited transaction. |
| Reply vs. internal note | two distinct writes | `sendHumanReply` vs `writeHumanMessage` (`send_human_message`, kind=`internal_note`) | Already two separate write paths. No change. |
| Lead Details rail - qualification | credit range, funding goal, timeline, **business** | `ConversationRead.qualification` | **GAP, fixed.** Added `contact.business_stage` to the select and `qualification.business` (optional field). |
| Lead Details rail - booking state | proposed slots / confirmed | `ConversationRead.appointment` | **GAP, fixed.** Added `proposed_slots`/`proposed_slots_at` read, a local slot-set validator mirroring `src/lib/consumer/booking.ts`, and `proposedSlots` on `ConversationRead`. |
| Lead Details rail - live AI summary | 3–5 sentence generated summary | none | **Deferred.** No summary generation pipeline exists anywhere in the repo (no column, no LLM call). This needs an inference pipeline, not a repository read - out of round-1 scope (repository + small migration). Needs its own round. |
| Questions-answered count, decision | qualification capture | `ConversationRead.qualification` (existing fields) | Already present via the same qualification block. No change. |

## Leads (`Leads.dc.html`, `LeadsBoard.dc.html`)

| element | data/action | function or GAP | this round |
|---|---|---|---|
| Leads list | name, channel, stage, last activity, outcome | `listContacts` (`src/lib/repositories/contacts.ts`) | Already complete. No change. |
| Board by stage / "Move to stage" | audited stage write, non-drag equivalent of drag, human's move wins | `setPipelineStage` (`contacts.ts`) → audited `setPipelineStage` (`src/lib/audit.ts`) → `set_contact_pipeline_stage` RPC; `POST /api/contacts/[id]/pipeline-stage` | Already complete end to end - the route always sends `setBy: "user"`, so a manual move already always wins, matching "human's move wins." Shared allow/deny logic in `src/lib/pipeline/transitions.ts` backs both drag and the button. No change. |
| "Report a duplicate" | support record, lead + coach + note, never mutates the contact | `support.ts` had a coach-to-platform thread (`create_support_thread`) with no way to tag a lead | **GAP, fixed.** Added nullable `related_contact_id` to `support_threads` (`supabase/migrations/20261012000004_support_thread_related_contact.sql`), threaded `p_related_contact_id` through `create_support_thread` / `createCoachSupportThread` / `createSupportService.createCoachThread`, validated against tenant with `app.assert_expected_tenant` like every other RPC in the file. New route `POST /api/contacts/[id]/support-request` composes the thread and never touches `contacts`. |
| "Request deletion" | same shape, human review only, never performs the deletion | same gap as above | **GAP, fixed.** Same route, `type: "deletion"` in the body. Does not call the admin-side `/admin/compliance` cascade - this only files the request. |

## Notifications

| element | data/action | function or GAP | this round |
|---|---|---|---|
| One preference (email / text / both) replacing the coach's per-rule matrix | read/write, coach role only | none existed; the general matrix (`src/app/api/notification-preferences`) has no coach-collapsed view | **GAP, fixed.** New `src/lib/repositories/coach-notification-preference.ts`: `readCoachNotificationPreference(userId, role)` derives one of `email`/`text`/`both` from every coach-suppressible tenant-scoped rule's email and text destination state, and renders `null` (absent, never guessed) if the rows disagree rather than manufacture an answer. `writeCoachNotificationPreference(userId, role, preference, audit)` writes only the destinations that actually need to change, through the same `set_notification_preference` RPC and the existing `writePreferenceAuditEvent` audit path the general matrix already uses. New route `GET`/`PUT /api/coach/notification-preference` (`src/app/api/coach/notification-preference/`), restricted to `coach`/`coach_member`, not impersonated. |
| Platform-required rules stay intact | a coach's choice must never disable a non-suppressible rule | `alert_rules.suppressible` | Verified and enforced: the repository only ever reads and writes rows where `suppressible = true`; a non-suppressible rule is filtered out before the coach's rows are even built, so it cannot appear in what the coach's single control governs, and its own destinations (whatever an admin configured) are never touched by this write path. |
| Bell (in-app) notifications | left out of the coach's choice | `alert_rules.default_destinations` bell entries | Deliberately not part of this preference. The bell needs no provider and every coach-suppressible rule already defaults it on, so the coach's one choice governs only the two destinations that cost anything to reach them on. |
| Text (SMS) as a real destination | a value the system can store a preference against | none: `notification_destination` enum only had `bell`/`email` | **GAP, fixed at the storage layer; delivery itself deferred.** New additive migration `supabase/migrations/20261012000005_notification_destination_text.sql` adds `'sms'` to the `notification_destination` enum (`alter type ... add value`, no rename/rebuild needed since nothing is removed). This value is deliberately *not* added to the shared `NotificationDestination` TypeScript union in `src/lib/notifications/events.ts` (that type feeds the general admin/success matrix, `notification-view-models.ts`, and every rule resolver - widening it there was tried first and broke the matrix's own typed `destinations` field, which is intentionally `"email" | "bell"` only). Instead `coach-notification-preference.ts` declares its own local `CoachNotificationDestination = "email" | "sms"`, and the one boundary that must talk to the general matrix's typed audit writer (`src/app/api/coach/notification-preference/route.ts`) adapts across the two types explicitly rather than widening either one. **What is not built:** an actual SMS delivery provider and worker. `claim_notification_deliveries` still only claims `destination = 'email'`, so a coach who picks "text" or "both" gets their intent stored and audited honestly, but no text message is sent until a delivery worker exists for it - the same honest-pending state the email destination already carries before any provider confirms delivery. That worker is a distinct round-2+ item (provider selection, phone-number resolution for the recipient, delivery-attempt constraint work), not a gap in this preference store. |

## Agent (`Agent.dc.html`) - audited, not implemented this round

Read-only pass over `src/lib/repositories/offer-layer.ts` and `coach-questions.ts` to
confirm coverage before deferring further work. All of the following already have a
repository function and an audited RPC path: prices rows and the six qualification bounds
(`offer-layer.ts` - `CoachOfferDraftInput`/`saveDraft`/`publishDraft`, versioned draft/publish
with content-hash guards), the three-stop voice slider plus three voice questions (same offer
draft), question order with per-question enable/reorder (`coach-questions.ts` - 
`readCoachQuestions`/`reorderCoachQuestions`/`setCoachQuestionEnabled`), and the ordered top
objections read (`loadCoachTopObjections`, see Home). Keyword-to-reply-with-follow-up settings
live under `src/app/api/coach/keyword-goals`, not audited line-by-line this round - no reported
gap from the design side, deferred to round 2 for a closer read against `Agent.dc.html`'s
"Keywords and questions" panel. Follow-up purpose per touch and asked/skipped per-question state
were not independently re-verified this round; flagging for round 2 confirmation rather than
claiming either complete or missing without reading the code.

## Billing (`Billing.dc.html`) - audited, not implemented this round

`src/lib/repositories/billing.ts` already carries: plan/price/period/allowance-used-of-total
with reset date (`account_state`, `call_allowance`), recent bookings, a Showed/No-show
attendance write (`appointment.attendance_set`, audited), and "This count looks wrong" as a
correction-request write (`billing_correction_requests` / `billing_correction_decisions`,
owner/admin decides, a coach never edits a count). The demo-tenant `is_test` exclusion
invariant referenced in `correctionSeedLabel` and elsewhere is intact and was not changed.
No gap found; no code touched.

## Deferred to round 2 (needs schema/engine work beyond a repository function + small migration)

- Home KPI: the active-leads agent-handling/needs-you split (needs a new metric pair on the
  shared `read_coach_measurement` RPC, precisely specified above).
- Home keyword table: rate suppression under 10 senders is safe to apply directly off
  `row.conversations` at the presentation layer; flagged so it is not skipped, not because it
  needs backend work.
- Inbox: the live AI conversation summary (needs an LLM generation pipeline and a storage
  column, not just a read).
- Notifications: actual SMS delivery (provider integration, phone-number resolution, a
  delivery-attempt constraint update, and extending `claim_notification_deliveries` to claim
  `sms` rows). The preference itself is stored and audited now; nothing sends yet.
- Agent tab: a full line-by-line audit of keyword-to-reply mapping, follow-up purpose per
  touch, and per-question asked/skipped state - not disproven as gaps, just not re-verified
  this round; do that read before claiming either way.
- Home first-run setup rungs / carrier day counter: not re-audited this round beyond
  confirming the repositories exist; worth a dedicated pass if the UI agents report a
  mismatch against `onboarding-steps.ts`.
- (Optional, team-lead request) An advisory LLM classification pass at conversation close that
  reads an unmatched objection from `unmatched_objections` and writes a suggested
  `brain_objection_id` onto that row for admin confirmation. This stays advisory only: the
  suggestion is a new nullable column an admin reviews and accepts or rejects on the objections
  queue, never an automatic match, so the counted source for objection stats stays the admin's own
  deterministic confirmation rather than a model's guess. Needs its own round: a new additive
  migration for the suggestion column plus confidence/model-version metadata, a classification
  call wired to conversation close, and an admin-side accept/reject affordance before it can move
  a number.

## Files changed this round

- `src/lib/repositories/analytics.ts` (comment fix only - no logic, schema, or type change)
- `src/lib/repositories/conversations.ts`, `src/lib/repositories/conversations.test.ts`
- `src/app/api/conversations/[id]/claim/handler.ts`
- `src/app/api/conversations/[id]/route.test.ts`
- `supabase/migrations/20261012000003_takeover_named_handover_line.sql` (new)
- `src/lib/repositories/support.ts`, `src/lib/repositories/support.test.ts`
- `src/lib/support/service.ts`
- `src/app/api/contacts/[id]/support-request/handler.ts` (new)
- `src/app/api/contacts/[id]/support-request/route.ts` (new)
- `src/app/api/contacts/[id]/support-request/route.test.ts` (new)
- `supabase/migrations/20261012000004_support_thread_related_contact.sql` (new)
- `src/lib/repositories/coach-notification-preference.ts` (new)
- `src/lib/repositories/coach-notification-preference.test.ts` (new)
- `src/app/api/coach/notification-preference/handler.ts` (new)
- `src/app/api/coach/notification-preference/route.ts` (new)
- `src/app/api/coach/notification-preference/route.test.ts` (new)
- `supabase/migrations/20261012000005_notification_destination_text.sql` (new)

`src/lib/notifications/events.ts` was touched and then reverted: a first attempt widened the
shared `NotificationDestination` union to `"bell" | "email" | "sms"` so the new repository could
reuse it, and `tsc --noEmit` caught that this broke `src/app/api/notification-preferences/handler.ts`'s
`DESTINATIONS` array and, more importantly, `src/components/workspace/live/notification-view-models.ts`
(a UI file, out of this round's write scope) whose `AlertRuleView.destinations` field is typed
`readonly ("email" | "bell")[]`. Reverted to keep that shared type exactly as the matrix and its
UI consumer already declare it; the coach preference module carries its own local
`CoachNotificationDestination` type instead (see the Notifications table above).

## Verification run this round

- `npx vitest run src/lib/repositories/analytics.test.ts` - 22/22 pass
- `npx vitest run src/lib/repositories/conversations.test.ts "src/app/api/conversations/[id]/route.test.ts" "src/app/api/conversations/[id]/write-gates.test.ts" src/app/api/channel-actions/routes.test.ts` - 4 files, 41 tests pass
- Spot-check of `ConversationRead` consumers (`coach-inbox.test.tsx`, `coach-inbox-toggle.test.tsx`, `escalation-queue.test.ts`, `view-models.test.ts`, `src/app/api/routes.test.ts`) - 5 files, 108 tests pass, new fields are optional and don't break existing fixtures
- Contacts/support test files (7 files, 63 tests) - pass
- `npx vitest run src/lib/repositories/coach-notification-preference.test.ts src/app/api/coach/notification-preference/route.test.ts src/lib/notifications src/app/api/notification-preferences src/app/api/coach/keyword-goals src/components/workspace/live/notification-view-models.test.ts` - 16 files, 127 tests pass, confirming the notifications matrix, its resolver, and its UI view-model consumer are all unaffected
- `npx tsc --noEmit` (whole project, run standalone in the foreground at the end of the round,
  after the `events.ts` revert above) - **clean, exit 0, zero errors**

## Round 2 intake (from the surface rebuilds, appended by the lead as lanes report)

- Billing: a period-level correction request that takes a reason with no eventId and no
  quantityDelta; the overage rate on the coach billing projection; the billing interval on the
  projection so cadence is not inferred from period dates; settled attendance rows so the list can
  show bookings already answered. The login coach's seeded period runs Oct 2025 to Oct 2026, which
  is the seed-demo-history anchoring, not a read defect.
