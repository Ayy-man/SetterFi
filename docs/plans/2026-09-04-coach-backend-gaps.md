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

## Round 2 (2026-09-04)

Priority list from the team lead's round-2 brief, in order.

### 1. Active leads split (agent-handling vs needs-you) - GAP CLOSED

`coach.active_leads_agent_handling` and `coach.active_leads_needs_you` added to
`read_coach_measurement_pre_phase13` in `supabase/migrations/20261012000006_active_leads_agent_split.sql`.
Both partition the exact active-cohort population `coach.active_leads` already counts (nonterminal
`pipeline_stage`), bucketed by each contact's most recent `conversations.status`: `needs_human`/
`human` count as needs-you, `agent`/`nurture`/`closed`/`opted_out` and no conversation at all count
as agent-handling. `COACH_METRIC_KEYS` is now 22 rows (was 20); `METRIC_DEFINITIONS` documents both
new keys. `loadCoachMeasurement` (`src/lib/repositories/analytics.ts`) enforces the two counts sum
to `coach.active_leads` as a conservation check, the same shape as the existing keyword-row check.
Tests added in `metric-definitions.test.ts` and `analytics.test.ts` (conservation pass and fail
cases). Documented in `docs/BACKEND-SPEC.md` §9.

### 2. Agent tab line-by-line audit - mostly already complete; one real gap closed

Confirmed a read and a write exist under `src/lib`/`src/app/api` for every field on
`design/coach/Agent.dc.html`:

- Prices, six qualification bounds (credit score min, funding goal min/max, monthly revenue min,
  needs-credit-repair, refund posture), voice slider + three voice answers: all on
  `CoachOfferDraftInput` (`src/lib/offer/types.ts`), already fully covered by
  `saveCoachOfferDraft`/`publishCoachOfferDraft` (`src/lib/offer/service.ts`).
- Follow-up purpose per touch: `cadencePurposes` on the same offer draft. Already covered.
- Question order with per-question enabled/disabled (rendered as Asked/Skipped in the mock):
  `readCoachQuestions`/`reorderCoachQuestions`/`setCoachQuestionEnabled`
  (`src/lib/repositories/coach-questions.ts`). Already covered.
- Keyword-to-reply mapping (keyword, reply link/message, ordered questions):
  `src/app/api/coach/keyword-goals`. Already covered.
- Top objections: `loadCoachTopObjections`. Already covered (see round 1).

**GAP, closed:** `docs/SIMPLIFICATION-SPEC.md` Q4's chosen default is one Save with no
coach-facing draft state - platform review still runs, the coach never takes "publish" as its own
step. The offer layer's actual API shape was still the explicit two-step `PUT /api/coach/offer`
(save) then `POST /api/coach/offer/publish` (publish), which is exactly the shape Q4 replaces.
Added `saveAndPublishCoachOffer` (`src/lib/offer/service.ts`), composing save then publish in one
call, and `POST /api/coach/offer/save-and-publish` (new route, same body shape as the existing
`PUT`), so a Save button can do both in one request. The two-step routes are untouched for any
caller still on the explicit shape. `COACH_OFFER_KEYS` extracted to
`src/app/api/coach/offer/keys.ts` so both routes validate against the same key list.

**Not done:** a single backend transaction across the offer layer, question order, and
keyword-goals. These stay three separately audited resources with their own RPCs
(`save_offer_draft`/`publish_offer_draft`, `reorder_coach_questions`/`set_coach_question_enabled`,
the keyword-goal CRUD). Whichever UI wires the Agent screen's Save button decides whether to call
all three in one client-side action; nothing about the backend shape blocks that, and a true
cross-resource atomic transaction was judged out of scope for this round given the concurrent UI
work on that screen.

**New finding, not fixed this round:** `read_coach_measurement`'s `keywords` output is not what
`read_coach_measurement_pre_phase13` computes. The wrapper (`20261007000001_keyword_goals_capi.sql`)
unconditionally overwrites `keywords` with `app.phase13_keyword_measurement`'s result, which is
scoped to keyword-goal-attributed conversations only and carries no "No keyword" row. Round 1's
audit of the keyword table read `read_coach_measurement_pre_phase13` in isolation and concluded the
"No keyword" row was already complete; that is true of the function in isolation but not of what
the coach dashboard actually receives. Flagging for a product decision (is the keyword table meant
to show only keyword-goal campaigns, or every conversation grouped by first-touch keyword) before
anyone touches it; not fixed here since it needs that decision, not a repository change.

### 3. Rate suppression under ten senders - GAP CLOSED

Added `senderCount` (distinct `contact_id`, not a conversation-row count) to
`app.phase13_keyword_measurement`'s per-keyword aggregation
(`supabase/migrations/20261012000007_keyword_sender_count.sql` - this is the function whose output
actually reaches the coach dashboard, see the finding above). `CoachKeywordRow.senderCount` added
to `src/lib/repositories/analytics.ts`, validated `<= conversations`. Typed optional
(`senderCount?: number`) rather than required, for source compatibility with UI-owned fixtures
written before this field existed (`src/components/workspace/live/measurement-view-models.test.ts`,
out of this round's write scope) - the repository itself always populates it from the RPC and
requires it on every row the RPC returns. Tests added in `analytics.test.ts`.

### 4. Advisory objection classification hook - GAP CLOSED (interface + storage only, as scoped)

`unmatched_objections` gets three new nullable columns -
`suggested_brain_objection_id`/`suggestion_confidence`/`suggestion_model_version`/`suggested_at` -
in `supabase/migrations/20261012000008_unmatched_objection_suggestion.sql`, written only through
the new `write_unmatched_objection_suggestion` RPC, which never touches the confirmed
`brain_objection_id`/`resolved_by`/`resolved_at` fields an admin sets on resolving a row. Every
objection stat counted anywhere still reads only the confirmed fields.
`src/lib/brain/objection-classifier.ts` defines the `ObjectionClassifier` interface, a
`noopObjectionClassifier` default provider that always declines, and `suggestObjectionMatch` to
run a classifier and write its result through the RPC. Tests in
`src/lib/brain/objection-classifier.test.ts`.

**Deliberately not done, per the round's own scoping:** no model call, and no caller wired at
conversation close - there is no conversation-close hook anywhere in this repository to attach to
(the turn engine described in `BACKEND-SPEC.md` §3 is not implemented here yet). No admin-side
accept/reject UI either. All three are round-3+ items.

### 5. Round 2 intake

The lead's "Round 2 intake" heading above (from the surface rebuilds) landed while this round was
already underway; read at the end as instructed. It lists four billing items:

- A period-level correction request that takes a reason with no `eventId` and no `quantityDelta`.
- The overage rate on the coach billing projection.
- The billing interval on the projection, so cadence is not inferred from period dates.
- Settled attendance rows, so the list can show bookings already answered.

**Deferred to round 3, not attempted this round.** `src/lib/repositories/billing.ts` is 1,500
lines and every write on it goes through named RPCs behind receipt checks (`BillingCorrectionProjection`,
`CoachBillingRead` and their SQL projections were not read this round). The correction-request item
in particular changes a write invariant (`billing_correction_requests` currently keys a request to
one `billableEventId` and one `quantityDelta`; a reason-only request needs to know what that means
for `offsetEventId` and for how `record_billing_correction_decision` computes the credit) on a
financial surface the brief calls out for extra care. Doing that correctly needs to start by
reading the existing correction RPCs and the coach billing projection's SQL in full, which this
round's remaining time did not have room for after items 1-4 above. Flagging with the specific
questions rather than a vague "later": what should `record_billing_correction_decision` credit for
a reason-only request with no event or quantity behind it, and is "overage rate" a stored tier
field or a projection computed from usage - both need an answer before either read is added
honestly rather than guessed.

## Files changed this round

- `supabase/migrations/20261012000006_active_leads_agent_split.sql` (new)
- `supabase/migrations/20261012000007_keyword_sender_count.sql` (new)
- `supabase/migrations/20261012000008_unmatched_objection_suggestion.sql` (new)
- `src/lib/analytics/metric-definitions.ts`, `src/lib/analytics/metric-definitions.test.ts`
- `src/lib/repositories/analytics.ts`, `src/lib/repositories/analytics.test.ts`
- `src/lib/brain/objection-classifier.ts` (new), `src/lib/brain/objection-classifier.test.ts` (new)
- `src/lib/offer/service.ts`, `src/lib/offer/service.test.ts`
- `src/app/api/coach/offer/keys.ts` (new)
- `src/app/api/coach/offer/handler.ts`
- `src/app/api/coach/offer/save-and-publish/handler.ts` (new)
- `src/app/api/coach/offer/save-and-publish/route.ts` (new)
- `src/app/api/coach/offer/save-and-publish/route.test.ts` (new)
- `docs/BACKEND-SPEC.md`

## Verification run this round

- `npx vitest run src/lib/analytics/metric-definitions.test.ts src/lib/repositories/analytics.test.ts src/lib/offer/service.test.ts src/app/api/coach/offer src/lib/brain/objection-classifier.test.ts src/app/em-dash.test.ts` - 7 files, 82 tests pass
- `npx vitest run src/app/api/exports/routes.test.ts src/components/workspace/live/measurement-view-models.test.ts` - 2 files, 214 tests pass (confirms the new optional `senderCount` field and the two new metric keys don't break existing consumers)
- `npx tsc --noEmit` (whole project) - zero errors traceable to files touched this round; remaining errors are pre-existing, unrelated, in-progress UI work by other agents (`coach-dashboard.tsx`, `coach-agent.test.tsx`, `coach-billing.test.tsx`, `coach-setup.tsx`, `coach-leads.test.tsx`, `coach-tips.test.tsx`, `coach-support-bubble.test.tsx`, `coach-home-months.tsx`, `home/loading.test.tsx`)

## A note on a mid-round git incident

Partway through this round a diagnostic `git stash` (run to compare tsc output against a clean
tree) stashed every uncommitted change in the shared working tree, not just this agent's own -
several other agents' concurrent edits were sitting uncommitted at the time. The `git stash pop`
then conflicted against newer edits four other agents had made to the same files in the interim
(`get-started/page.tsx`, `integrations/page.tsx`, `coach-billing.tsx`, `coach-billing.test.tsx`)
and aborted cleanly rather than overwriting anything. Recovered by checking out each non-conflicting
file from the stash individually (`git checkout stash@{0} -- <path>`), leaving the four newer
on-disk versions untouched, then dropping the stash once every file was accounted for. No content
was lost; `git stash`/`pop` without a path scope is unsafe on this shared tree and should not be
run again without `--` pathspecs limited to files a single agent actually owns.

## Round 3 intake (lead, 2026-09-04)

**Keyword table scope, ruled.** The table is every conversation in the window grouped by
first-touch keyword, with the "No keyword" row last, exactly as `docs/PRODUCT.md` states under the
measurement section: the denominator is conversations and the rows have to cover the whole
population or the percentages lie. The phase 13 wrapper overwriting `keywords` with the
keyword-goal-only aggregation is the defect. Fix it in a new migration: keep the phase 13
per-keyword figures (they carry the CAPI attribution and now `senderCount`) for rows that have a
keyword goal, but union in the remaining first-touch keywords and the "No keyword" row from the
pre-phase-13 grouping, so the row set is the whole population and the shared columns agree with
`read_coach_measurement_pre_phase13`. `senderCount` must be populated on every row, not only the
goal-attributed ones. Regression test: a window with two goal keywords, one stray keyword and a
no-keyword conversation returns four rows, "No keyword" last, conversations summing to the window
total.

**Billing intake from the Billing lane still stands** (period-level correction request, overage
rate and billing interval on the read, settled attendance rows). Any gaps the remaining lanes
record under their "what shipped" sections in `docs/plans/2026-09-04-coach-rehaul-notes.md` join
this round.

## Round 3 (2026-09-04)

### 1. Keyword table scope - GAP CLOSED

`supabase/migrations/20261012000009_keyword_table_whole_population.sql` replaces
`public.read_coach_measurement`. It keeps `app.phase13_keyword_measurement`'s per-keyword figures
(CAPI attribution, `senderCount`) for keywords that have a keyword goal, and unions in every
remaining first-touch keyword plus the "No keyword" row from the pre-phase-13 grouping, so the row
set is the whole population and `senderCount` is populated on every row, not only the
goal-attributed ones. "No keyword" sorts last. The metric tile `coach.keyword.conversations` stays
goal-scoped, per the round-3 ruling, so it and the table's own row sum are legitimately different
numbers now; the RPC also returns a new `keywordConversationTotal` (the population's own total),
and `loadCoachMeasurement` (`src/lib/repositories/analytics.ts`) was moved onto it for the table's
conservation check instead of the metric. `read_coach_measurement_pre_phase13` and
`app.phase13_keyword_measurement` are untouched. Tests: `supabase/tests/keyword-goals-capi.test.ts`
(two goal keywords, one stray keyword, one no-keyword conversation - four rows, "No keyword" last,
conservation against `keywordConversationTotal`), `supabase/tests/phase7-measurement.test.ts`
(key-set assertions), `src/lib/repositories/analytics.test.ts`.

**Known, not fixed here (flagged in `20261012000007_keyword_sender_count.sql`'s own comment,
confirmed again this round):** `app.phase13_keyword_measurement` hard-excludes `is_demo` tenants
and `is_test` conversations with no visibility override, unlike every other measurement read on
this tenant. A demo tenant's keyword rows can never carry goal-attribution figures no matter what
`platform_demo_visible()` or `app.phase7_demo_tenant` say; they always fall back to the
population-only figures this round's migration adds. This is a real product inconsistency, not
introduced by this round, and needs its own migration once someone decides whether demo tenants
should see goal-attributed keyword rows at all.

### 2. Billing intake - GAP CLOSED (request side); decision side explicitly refused, not silently broken

`supabase/migrations/20261012000010_billing_period_correction_and_settled_attendance.sql`:

- `billing_correction_requests` now accepts a period-level shape (`period_start`/`period_end`, no
  `billable_event_id`/`quantity_delta`) alongside the existing event-level shape; a check
  constraint requires exactly one of the two shapes.
- New RPC `request_period_billing_correction(p_expected_tenant, p_reason)` for the coach-facing
  "something about this period looks wrong" flow that carries no event id and no quantity delta.
- `decide_billable_correction` (the platform-side approve/reject RPC) now refuses a period-level
  request with a named error, `BILLING_CORRECTION_PERIOD_LEVEL_DECISION_NOT_SUPPORTED`, instead of
  hitting an opaque constraint violation. Deciding a period-level request needs a "floating" credit
  not anchored to a real `billable_events` row, which `billable_events_shape_chk` forbids outright;
  making that work is a real schema change and was judged out of scope for this round. Flagging as
  the next round's item: either give period-level corrections their own settlement path, or fold
  them into event-level ones at intake time.
- `coach_billing_projection(uuid)` gained a `settled_attendance` output: up to 20 current-period
  appointments with `attendance_source is not null`, most recent first.

**Overage rate and billing interval - deliberately not added.** Neither has a stored field or a
write path anywhere in the schema; `20261005000002_signup_tier_call_allowance.sql`'s own comment
says both are pending Alec's commercial decision. Adding either to a read this round would mean
inventing a number with nothing behind it, which the engineering brief's honest-states rule
forbids. Once a tier's overage rate and billing interval have a real column and a real write path,
`coach_billing_projection` is the function to extend.

`src/lib/repositories/billing.ts`, `src/lib/billing/operations.ts`, and
`src/app/api/billing/corrections/handler.ts` all carry the new period-level request path end to
end (`requestPeriodCorrection`), with tests in `billing.test.ts`, `operations.test.ts`, and
`corrections/route.test.ts`.

### 3. Inbox - GAP CLOSED

- `countConversationsByView(tenantId, source)` (`src/lib/repositories/conversations.ts`) returns
  the three `CONVERSATION_VIEWS` counts (needs-you, agent-handling, everything) off one status
  read, so the tab figures no longer cost a full-set read.
- `getConversation` gained a `questionSetSize` field, sourced from `read_coach_questions` (already
  granted directly to service_role, no actor needed), so the rail can say "3 of 6 answered" instead
  of "3 of 4."

Tests: `src/lib/repositories/conversations.test.ts` (two new `describe` blocks, five tests).

### 4. Setup and onboarding - GAP CLOSED

- `supabase/migrations/20261012000011_a2p_registration_approved_at.sql` adds `approved_at` to
  `read_coach_a2p_registration`, sourced from `provisioning_steps.completed_at` on the `sms_live`
  step (the same clock every other finished Setup step already ticks on), null unless that step is
  actually `done`. `CoachA2pRegistrationProjection.approvedAt` is optional
  (`src/lib/repositories/onboarding-evidence.ts`) so the two UI fixtures outside this round's write
  scope (`src/components/onboarding/*.test.ts`) that predate the field stay green.
- New `src/lib/repositories/coach-profile.ts`: `readCoachOwnEmail(actor, source)`, a
  tenant-and-user-scoped read of the coach's own `users.email`, for Settings' "Sent to the address
  on your account." Wired into `GET /api/coach/notification-preference`
  (`src/app/api/coach/notification-preference/handler.ts` and `route.ts`), which now returns
  `{ preference, email }` in one round trip.

Tests: `src/lib/repositories/coach-profile.test.ts` (new, four tests),
`src/lib/repositories/onboarding-evidence.test.ts`, `src/app/api/coach/notification-preference/route.test.ts`.

### 5. Seeding - written, not run

`scripts/seed-coach-rebuild-demo.mjs` (new, not run per the brief). Targets the login demo coach's
tenant, `87000000-0000-4000-8000-000000000001`, which `seed-phase7-demo.mjs` already owns for
measurement fixtures but never gave a published offer, a keyword table, a business profile, a
mid-review A2P registration, an expired channel connection, or a support thread - exactly what this
round's brief named. (The brief's literal id,
`87000000-0000-0000-0000-000000000001`, does not exist anywhere in the codebase or match any
tenant convention; the real login demo tenant at that first segment is
`87000000-0000-4000-8000-000000000001`, `seed-phase7-demo.mjs`'s `PHASE7_DEMO_IDS.tenant`, "Avery
Morgan (demo)" - treated as the intended target.)

The script refuses to run against anything but that already-seeded tenant, writes every new id
under its own `92000000-0000-4000-8000-` namespace (checked empty against `scripts/`, `src/`,
`supabase/` before use), and is idempotent the same way the other demo seeders are (`on conflict`
upserts, or a lookup-then-reuse check before any RPC with no natural upsert path). It adds:

- A business profile row (direct insert, same shape as `seed-phase5-demo.mjs`'s).
- `sms_live` and `a2p_campaign` provisioning steps in `awaiting_provider` state, the campaign's
  `external_ref->>'submittedAt'` dated 14 days back, so `read_coach_a2p_registration` reads a real
  mid-review registration with no `approved_at`.
- One `channel_connections` row, `instagram`/`meta_direct`, `state = 'expired'`, with a past
  `token_expires_at`.
- Two keyword goals (`funding`, `credit`, mode `book`) via `save_keyword_goal`, and four new
  contacts/conversations/messages carrying matching `first_touch_keyword` and `keyword_goal_id`, so
  the Home keyword table has real rows to render. (Goal-attributed figures on those rows are
  subject to the known phase13/demo-tenant gap in item 1 above; the whole-population side of the
  table renders regardless.)
- A support thread via `create_support_thread`, assigned to a named "success" responder
  (`set_support_thread_assignee`) with a reply message and a `waiting_on_coach` status
  (`set_support_thread_status`) - a plain pricing-copy question, unrelated to the trainings
  surface, so it does not read as a stand-in for the (unbuilt) trainings feature.
- A published offer layer via `save_offer_draft`/`publish_offer_draft`: two qualifier-shaped
  fields (`creditMin`, `fundingGoalMinCents`/`fundingGoalMaxCents`, `monthlyRevenueMinCents`,
  `creditRepair`), a closed-vocabulary `products` selection, and two prices. `contentHash` is a
  real sha256 hex digest (`offer_layers_content_hash_chk` requires the 64-hex-character shape);
  `products`/`creditRepair` are drawn from the closed vocabularies
  `offer_layers_products_chk`/`credit_repair`'s check constraint actually allow, not free text.

Every billable or analytics-visible row (`contacts`, `conversations`, `messages`,
`support_threads`, `support_messages`) is `is_test = true`; the tenant itself is `is_demo = true`.

Run order: `node scripts/seed-phase7-demo.mjs --acknowledge-stale-rollups`, then
`node scripts/seed-coach-rebuild-demo.mjs [--target <url>] [--confirm-hosted]`.

### 6. Other lane gaps reviewed

- **No SMS delivery** (`claim_notification_deliveries` claims email only) - needs a real delivery
  worker; out of scope for a backend-only round.
- **No coach guide catalogue** / **no trainings store** - both need real authored content (guide
  text, training videos) the intake never captured, not just a repository and a route; a schema
  with nothing behind it would be worse than no schema. Left open.
- **Support threads have no unread state** - real gap, but genuinely ambiguous without a product
  call: unread since the coach last opened the thread, since their last reply, or since the
  responder's last reply, and marking-as-read needs its own write path. Left open rather than
  guessing the semantics; needs one line in `docs/PRODUCT.md` or `docs/BACKEND-SPEC.md` before a
  migration is worth writing.
- **Leads lane** reported "nothing was blocked" in its own "what shipped" section - no backend
  action needed.

### File list

Migrations (apply in this order):

1. `supabase/migrations/20261012000009_keyword_table_whole_population.sql`
2. `supabase/migrations/20261012000010_billing_period_correction_and_settled_attendance.sql`
3. `supabase/migrations/20261012000011_a2p_registration_approved_at.sql`

Repositories / lib: `src/lib/repositories/analytics.ts`, `src/lib/repositories/billing.ts`,
`src/lib/billing/operations.ts`, `src/lib/repositories/conversations.ts`,
`src/lib/repositories/onboarding-evidence.ts`, `src/lib/repositories/coach-profile.ts` (new).

API routes: `src/app/api/billing/corrections/handler.ts`,
`src/app/api/coach/notification-preference/handler.ts`,
`src/app/api/coach/notification-preference/route.ts`.

Scripts: `scripts/seed-coach-rebuild-demo.mjs` (new, not run).

Tests touched: `src/lib/repositories/analytics.test.ts`,
`supabase/tests/keyword-goals-capi.test.ts`, `supabase/tests/phase7-measurement.test.ts`,
`src/lib/repositories/billing.test.ts`, `src/lib/billing/operations.test.ts`,
`src/app/api/billing/corrections/route.test.ts`, `src/lib/repositories/conversations.test.ts`,
`src/lib/repositories/onboarding-evidence.test.ts`, `src/lib/repositories/coach-profile.test.ts`
(new), `src/app/api/coach/notification-preference/route.test.ts`.

### Verification

`npx tsc --noEmit -p .`: zero errors. `npx vitest run src/lib src/app/api`: 352 files passed, 4
pre-existing skips, 3604 tests passed, 13 pre-existing skips, zero failures. A scoped run of every
file this round touched plus the two `supabase/tests` files and `src/app/em-dash.test.ts`: 9 files,
117 tests, all passed. No migration in this round was applied to any database; all three are
written only, for the team lead to apply in the listed order.
