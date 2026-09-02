# SetterFi operator guide

This document is generated verbatim from the in-product admin guide registry. It is source
evidence only: it does not prove deployment, provider delivery, a recording, or live UAT.

## Admin navigation coverage

- `/admin/affiliates` — Review affiliate records
- `/admin/agent-performance` — Read platform measurement
- `/admin/alerts` — Review alert preferences
- `/admin/audit` — Use the audit log
- `/admin/billing` — Review tiers and billing
- `/admin/brain` — Publish the Brain safely
- `/admin/channel-health` — A2P and channel health
- `/admin/compliance` — Review compliance and DNC evidence
- `/admin/corrections` — Decide a billing correction
- `/admin/help` — Use the handover package
- `/admin/overview` — Read platform measurement
- `/admin/platform-clients` — Manage the client book
- `/admin/provisioning` — Operate the provisioning tracker
- `/admin/settings` — Read platform alert settings
- `/admin/support` — Work the support inbox
- `/admin/system` — Read System health
- `/admin/tiers` — Review tiers and billing

---

## Publish the Brain safely

Take a draft from diff review to every agent without publishing more than you checked.

**Outcome:** Every agent inherits exactly the change you read in the diff, and the publish is on the record.

1. **Read the diff before anything else.** The Brain header carries the DRAFT and PUBLISHED lifecycle with version history beside it. Open the diff and read what actually changed — qualification outcomes, objection responses, compliance language — rather than trusting the section you happened to edit.
2. **Check the eval status on the publish button.** The button surfaces the latest suite result. A failing safety suite soft-warns instead of hard-blocking, which means the decision to continue is yours and it is attributed to you.
3. **Try the change on the Brain Testing tab.** Ask the lead question the edit was meant to fix and compare the draft against the published version. The grounding receipt shows the retrieval behind the answer before any coach sees it.
4. **Publish to all agents.** One action pushes the published version to every agent. The confirmation names what propagated; anything still sitting in draft stays in draft and keeps saying so.
5. **Confirm the audit entry.** A brain publish is a privileged action, so it writes an entry with the actor, the version, and the timestamp. That entry is what settles a later question about when a behavior changed.

### Verify

- The Brain header reads PUBLISHED at the new version with no draft badge left behind.
- The version history shows your publish with your name and the diff attached.
- A test-bench run on the edited topic returns the new passage, not the previous one.

### If verification fails

If an agent still answers the old way, check whether the section you edited was saved into the same draft — an unsaved section never reaches a publish.

---

## Run an eval suite before publish

Prove a brain or model change against the safety and regression suites first.

**Outcome:** You can say which suite passed, on which configuration, before the change went out.

1. **Pick the configuration under test.** Brain Testing runs against draft, published, or a candidate configuration, with a client-overlay picker and channel simulation. Choose the one you intend to publish, not the one already live.
2. **Run the safety suite first.** Qualification, compliance, and prompt-injection cases are the gate. They matter more than tone cases because they are the ones that create a real incident.
3. **Read the failures as receipts, not scores.** Each case opens to the grounding receipt: the rule that fired and the passage it drew from. That is where you see whether the case failed on knowledge or on the decision table.
4. **Add the case that caused the change.** Any production conversation can be added as an eval case. A fix you add a case for stays fixed across later prompt and model swaps.
5. **Carry the result into the publish.** The publish button reads the latest suite status. Run the suite last so the status the operator sees at publish time is the one you just produced.

### Verify

- The suite run shows the configuration you are about to publish, not the live one.
- Every failing case opens to a receipt naming the rule and passage it used.
- All eval traffic stays labeled as test data and never lands in client analytics.

### If verification fails

If a suite passes here but a coach reports the old behavior, the run was against the published configuration rather than your draft — re-run with draft selected.

---

## Read a conversation trace

Work back from a bad reply to the retrieval and the decision-table row behind it.

**Outcome:** You can name the cause of a specific reply instead of guessing at the model.

1. **Open the trace from the conversation.** Any lead conversation offers view trace. Start from the exact message that was wrong rather than the thread in general, because the trace is per exchange.
2. **Read the retrieval before the prompt.** The trace shows what the brain retrieved for that turn. A wrong answer with the right passage is a prompt problem; a wrong answer with the wrong passage is a knowledge problem, and the two get fixed in different places.
3. **Find the decision-table row that fired.** Qualification outcomes come from the first matching row of the decision table. The trace names that row, which is how you tell a bad rule apart from a bad answer.
4. **Check latency and token cost on the same view.** Slow replies and expensive replies show up here beside the content, so a complaint about the agent being slow gets answered from the trace rather than from the model page.
5. **Turn the finding into an eval case.** Add the exchange as an eval case before you edit anything. Then the fix is provable, and the same failure cannot come back unnoticed.

### Verify

- The trace names both the retrieved passage and the decision-table row for the turn you opened.
- The activity log carries the same event code you can search by client or lead.
- The case you added appears in the eval suite you intend to run before the next publish.

### If verification fails

If the trace shows no retrieval, the turn was handled by a hard-gated response — pricing and guarantees answer from the offer layer rather than from a passage.

---

## A2P and channel health

Tell a carrier review in progress apart from a channel that is actually broken.

**Outcome:** You know which clients are genuinely blocked and which are simply waiting out a clock.

1. **Start from the System health grid.** Per-client heartbeats cover the Meta token, the A2P probe with its last test-send result, and webhook freshness. One row tells you whether the problem is one client or the platform.
2. **Read registering as pending, not failed.** A2P 10DLC registration is a carrier review that normally runs 2–3 weeks per client. It shows amber for the whole window and must never be reported to a coach as ready.
3. **Separate token expiry from carrier state.** An expiring Meta token disconnects Instagram and Messenger and is fixable today by asking the client to reconnect. A carrier review is not fixable by anyone here, so the two need different messages.
4. **Replay the webhook queue when freshness slips.** Stale webhook freshness with healthy channels usually means delivery, not connection. The retry queue supports manual replay, and replaying is safe because delivery is idempotent per event.
5. **Tell the client what is true.** Alerts already fire on channel disconnected and A2P cleared. Confirm the alert went out and that the client-facing state still reads amber where the clock has not cleared.

### Verify

- Every amber channel on the grid maps to an open carrier review or an in-flight verification, not a silent failure.
- A client whose token expired shows a reconnect path rather than a registration state.
- After a replay, webhook freshness moves and the missing conversations appear in the client's Inbox.

### If verification fails

If a registration stays open past the stated 2–3 week carrier window, check the registration record for an outstanding business detail or a terminal rejection.

---

## Rescue a stalled signup

Find where a self-serve onboarding stopped and move it forward without taking it over.

**Outcome:** The client resumes at the step that blocked them, and the intervention is attributed.

1. **Take it from the attention queue.** Overview leads with the at-risk queue, and onboarding stalled at a named step is one of its entries. The named step is the whole diagnosis — start there rather than opening the client cold.
2. **Read the onboarding progress on client detail.** Client detail shows exactly which step a signup stalled at alongside channel health and the offer snapshot. A stall on a channel step is usually a permission the client could not grant.
3. **Nudge before you impersonate.** Nudge stalled onboarding and resend signup link are the light actions and they keep the client in control of their own account. Reach for them first.
4. **View-as only when you must reproduce.** Impersonation is logged with your name and the client's account. Use it to see what they see, and edit their offer on their behalf only when they have asked for it.
5. **Leave the internal note.** The activity timeline is how the next success owner picks this up. One line naming the blocker and what you did saves the client repeating themselves.

### Verify

- The client's onboarding progress advances past the step named in the queue entry.
- Any view-as session appears in the audit log with your name and the time.
- The at-risk queue drops the entry once the step completes, without anyone clearing it by hand.

### If verification fails

If the stall repeats at the same step after a nudge, the step is genuinely blocked — check channel health for a permission the client cannot grant from their side.

---

## Adjust a metered count

Settle a disputed booked-call count with a reasoned, audited correction.

**Outcome:** The count matches the evidence, and the correction carries a reason anyone can read later.

1. **Reconcile before you adjust.** Open the per-client metering table on Tiers and billing and compare booked calls against the conversations behind them. Only confirmed bookings count; a proposed slot the lead never accepted does not.
2. **Export the cycle the client is disputing.** Every table exports CSV and JSON with the rows currently filtered and sorted. A disagreement about a number gets settled from the same rows both sides can read.
3. **Adjust with a reason, not a silent edit.** The metered-count adjustment requires a written reason. Outcome billing produces disputes, so the reason field is the product feature, not paperwork around it.
4. **Confirm the audit trail entry.** Meter adjustments are privileged and write an entry with the actor, the client, the old and new counts, and the reason. Check it landed before you reply to the client.
5. **Answer the client in their own terms.** Coaches never see platform economics. Explain the corrected count and what it means for their allowance, and keep cost-versus-revenue inside this console.

### Verify

- The client's usage meter and the metering table agree after the adjustment.
- The audit entry names you, the reason, and both counts.
- Nothing about margin or platform cost appears in what you send the client.

### If verification fails

If the counts still disagree after an adjustment, check whether test-data conversations were counted — segregated test traffic never meters, and a mismatch there is a fixture problem, not a billing one.

---

## Work the support inbox

Reply to coach support threads without mixing them with lead conversations.

**Outcome:** The coach receives a persisted reply and the next operator can see who owns the thread.

1. **Choose My clients or All clients.** My clients narrows the queue to your assigned book; All clients is an operating view, not a wider permission. Open the thread in Support and keep internal notes separate from the reply the coach will read.
2. **Reply from the support thread.** Use Reply for coach-visible text and Internal note for staff context. Support messages live in their own system and never become lead-conversation messages.
3. **Confirm the persisted read-back.** A successful reply reappears with its author and time. Reassignment reads Reassigned only after the owner and audit receipt both match the request.

### Verify

- The reply appears in the same support thread with the operator and timestamp.
- The coach view contains the reply and no internal note.
- Any ownership change appears in Audit with the assigning operator and assignee.

### If verification fails

If the reply does not read back, leave the thread unchanged and use System to check the current service state before retrying.

---

## Manage the client book

Review client ownership and make a reasoned, audit-backed reassignment.

**Outcome:** The intended success owner is persisted and the reassignment has one matching audit receipt.

1. **Open Clients and compare the two books.** My clients shows the current operator assignment; All clients shows the platform book. Use the persisted support and account states to decide whether ownership needs to change.
2. **Choose the assignee and write the reason.** Reassignment is privileged. The reason should explain the operating need without copying lead or credential data into the audit trail.
3. **Wait for Reassigned and Logged.** Both labels come from the returned owner and audit read-back. If either receipt is missing, the previous owner remains the displayed truth.

### Verify

- The client appears under the new owner's My clients view.
- Audit shows tenant.success_owner.reassigned with the same tenant and assignee.

### If verification fails

If the owner does not change, keep the prior assignment and check the audit reason and assignee eligibility before trying again.

---

## Review alert preferences

Change optional destinations while leaving required notices locked and visible.

**Outcome:** The account's bell, email, and Slack choices match the persisted registry read-back.

1. **Open Alerts and read the rule before changing it.** The event, scope, audience, and default destinations come from the alert registry. Required billing consequences remain enabled and their controls read Required.
2. **Change one optional destination.** The control is committed only after the service returns the persisted preference. A failed save restores the prior value rather than leaving an optimistic state on screen.
3. **Confirm delivery separately.** A saved preference proves intent, not provider delivery. Use the bell receipt and System delivery queue for the actual destination state.

### Verify

- A reload shows the same optional destination state.
- Every nonsuppressible row remains visible, enabled, and locked as Required.

### If verification fails

If a preference reverts, the write did not persist; keep the returned value and inspect System rather than toggling repeatedly.

---

## Read platform alert settings

Inspect the shared rule registry without treating configuration as delivery evidence.

**Outcome:** You can name the event, audience, required state, and intended destinations for a platform rule.

1. **Open Settings and find the event.** Search by the named event rather than by display copy. Scope separates tenant rules from platform rules, and audience shows who can receive each one.
2. **Check Required before interpreting a control.** Required rows cannot be suppressed. Optional rows still need an account preference before a destination is selected.
3. **Export the current registry when handing it over.** The server export uses the same columns and sort as the rendered table and writes an audit start and finish pair.

### Verify

- The event and scope match the generated alert-rule registry.
- The export has both audit receipts and the same visible column set.

### If verification fails

If the registry is unavailable, do not infer defaults from a previous export; use the generated package as dated evidence and escalate the current read failure.

---

## Diagnose delivery queue and retries

Separate queued, accepted, delivered, retrying, and terminal notification states.

**Outcome:** You can state what the platform attempted and which receipt is still missing.

1. **Start with the queue evidence.** Queue depth and terminal attempts come from persisted delivery rows. Unknown evidence stays Unavailable and must not be summarized as healthy.
2. **Read the destination-specific state.** Email acceptance reads Sent until a signed receipt arrives; Slack requires its documented success response; a bell is delivered by the database commit.
3. **Let the bounded retry policy own retries.** Do not create a second send from the UI. A leased attempt and its retry time keep the provider call idempotent and visible.

### Verify

- The attempt count and last-attempt time advance only after a persisted attempt.
- Email never reads Delivered without a matching signed receipt.
- A terminal row has a named safe error code and no further due time.

### If verification fails

If queue evidence is unavailable, do not retry manually; preserve the current rows and use the escalation path for a database or worker read failure.

---

## Read System health

Assess queue, jobs, and provider mode from receipts without exposing configuration values.

**Outcome:** You can distinguish a current receipt, an explicit failure, and an unknown state.

1. **Read queue evidence first.** Delivery queue depth, terminal attempts, and the latest attempt time are persisted facts. Unavailable means the evidence could not be read, not that the count is zero.
2. **Check each job receipt.** A job is current only when a stored run receipt exists inside its expected window. A configured schedule with no receipt remains Unavailable.
3. **Use provider mode as configuration state only.** System shows mock, real, or unavailable plus environment variable names. It never displays a key, webhook address, sender value, or other configuration value.

### Verify

- Every Healthy or Failed label points to a persisted receipt and time.
- Unknown queue, job, or provider evidence renders Unavailable.
- No configuration value or mutation control appears on the page.

### If verification fails

If the evidence read itself fails, capture the named unavailable section and follow the escalation path; do not infer platform health from provider mode.

---

## Use the audit log

Trace a privileged action through its actor, target, reason, and time.

**Outcome:** You can answer who did what, to which target, and whether test data was involved.

1. **Filter by the registered action.** Action keys come from the audit registry. Search the exact key so similarly worded actions do not collapse into one explanation.
2. **Read actor, target, reason, and test lineage together.** A human action requires an actor; a system action does not borrow a human identity. Missing lineage remains unavailable rather than being called Real.
3. **Match paired operations.** Exports have start and finish rows. A start without a finish means the stream may have ended after some bytes and is an operating signal, not a completed export.

### Verify

- The action exists in the generated audit-action registry.
- The row contains the actor shape required by that registry entry.

### If verification fails

If an action expected to read Logged has no row, treat the action as unverified and escalate the missing receipt.

---

## Export a rendered table

Download the current server-side table scope with an auditable start and finish pair.

**Outcome:** The CSV or JSON matches the visible filter, sort, and columns, with a recorded byte and row count.

1. **Set the table state first.** Choose the filter and sort you intend to hand over. The export route applies that same closed scope rather than serializing only the browser's current page.
2. **Choose CSV or JSON.** The server streams the full authorized result and neutralizes spreadsheet formula prefixes in CSV. Cross-client exports require a tenant and a reason.
3. **Check the audit pair.** The start records resource, filter, columns, and actor; the finish records row and byte counts after the final byte.

### Verify

- The file columns and ordering match the rendered table.
- Audit contains one matching start and finish pair.

### If verification fails

If the file is truncated, keep the unmatched start as evidence and repeat only after the source read is available.

---

## Review compliance and DNC evidence

Separate active suppression from the authoritative record retained after deletion.

**Outcome:** You can explain whether a contact is currently suppressed and what durable evidence remains.

1. **Open Compliance and identify the record type.** Current suppression entries drive send refusal. Suppression tombstones retain the protected proof after contact deletion; one cannot substitute for the other.
2. **Check provider confirmation.** Provider-confirmed and provider-unconfirmed are different states. An unconfirmed clear or push remains an escalation and must not resume messaging.
3. **Export the compliance artifact when required.** Use the reason-required server export and retain its audit pair. Do not copy identifiers into an internal note or hand-written spreadsheet.

### Verify

- The current send decision and the durable tombstone are read from their named sources.
- No provider-unconfirmed record is presented as cleared.

### If verification fails

If provider read-back is missing, leave the local suppression in place and follow the STOP or tripwire failure procedure.

---

## Operate the provisioning tracker

Find the exact step owner and evidence before retrying a stalled setup.

**Outcome:** The setup advances through a persisted retry or remains honestly blocked on its named owner.

1. **Read the step state and owner.** The tracker separates coach action, platform action, and external-provider waiting. A registering A2P row stays amber for the 2–3 week carrier window.
2. **Retry only eligible work.** A retry is a privileged action backed by the current step lease and audit receipt. A permanent 10DLC rejection remains permanently blocked and has no retry control.
3. **Verify the next persisted state.** The row must read back the new attempt, state, and evidence time. A queued step is not complete and must never read 100 percent or all set.

### Verify

- The row identifies who or what owns the next action.
- Registering copy says 2–3 weeks and terminal rejection remains blocked.

### If verification fails

If the same eligible step fails again, stop retrying and use the onboarding-stall failure procedure with the recorded error code.

---

## Read platform measurement

Interpret platform and agent-performance metrics only when their named evidence is complete.

**Outcome:** You can state the definition, window, denominator, and availability reason for a displayed metric.

1. **Start from the metric definition.** Overview and Agent performance use the committed metric registry. The definition and the query must agree on population, attribution window, and exclusion of Demo and Test rows.
2. **Treat absent evidence as absent.** Unavailable, Still filling, and Needs more history are evidence states. They never become zero, a dash, or a cached result presented as current.
3. **Use the role boundary.** Success operators receive operational evidence only. Platform economics remain owner/admin-only and incomplete margin has no renderable field.

### Verify

- The metric definition names the same window and population as the rendered view.
- Demo and Test rows are excluded from real analytics and labelled in test-only views.

### If verification fails

If a definition and number disagree, treat the metric as unavailable and escalate the projection rather than explaining the number from memory.

---

## Review tiers and billing

Operate fixed tiers and subscription state without exposing platform economics to coaches.

**Outcome:** The displayed tier, allowance, and account state match the persisted billing mirror.

1. **Read the subscription mirror.** The billing page uses persisted subscription and invoice evidence. A provider identifier on its own is not an active subscription receipt.
2. **Separate overdue from suspended.** Overdue keeps the agent operating while dunning continues. Suspension is a reasoned human action that stops new conversations and follow-ups without silencing in-flight conversations.
3. **Keep operating cost inside admin.** The platform cost rollup and running-cost handover are for the owner/operator. Coach replies contain allowance and account facts, never margin or cost-versus-revenue detail.

### Verify

- Tier, allowance, period, and account state have persisted source evidence.
- Incomplete cost sources render absent rather than a partial margin.

### If verification fails

If provider and mirror states disagree, preserve the mirror as the application truth and follow the billing-failure procedure before changing access.

---

## Decide a billing correction

Review a requested count correction and preserve the offset and audit evidence.

**Outcome:** The request is approved or rejected with a reason and an immutable read-back.

1. **Open Corrections and read the source event.** Compare the request with the billable event and supporting appointment evidence. Do not change the original ledger row.
2. **Approve or reject with a reason.** Approval writes an offset event; rejection records the decision. Both paths require the persisted decision and audit receipt before the UI confirms them.
3. **Confirm the resulting count.** The current allowance view must reflect the original event plus its offset. A decision label without that read-back is incomplete.

### Verify

- The decision and audit ids match the request.
- An approved request has one offset event and leaves the original event immutable.

### If verification fails

If the read-back does not reconcile, keep the request open and escalate rather than adding a second correction.

---

## Review affiliate records

Separate referral attribution, commission accrual, payout approval, and recorded send evidence.

**Outcome:** Each affiliate amount has a persisted attribution and its payout state is described without implying a transfer we did not make.

1. **Start from referral attribution.** The affiliate record is immutable after signup. The portal exposes only business name, account status, and commission earned, never referred-coach performance.
2. **Read the ledger events.** Collected revenue accrues commission and refunds or disputes create offsets. The current amount is the append-only sum, not an editable balance.
3. **Distinguish approved from recorded sent.** Approved for payout is an internal decision. Recorded sent requires an external reference and date, and says only that the transfer was recorded.

### Verify

- The amount reconciles to the immutable ledger entries.
- Recorded sent has the required reference, date, event, and audit receipt.

### If verification fails

If the ledger does not reconcile, stop before payout approval and escalate the specific referral or invoice evidence gap.

---

## Use the handover package

Open the generated operating package and verify its source metadata before relying on it.

**Outcome:** You are using the committed package whose file hashes match its manifest.

1. **Open Help for the task you are performing.** The in-product guide is the operating source for screen procedures. The generated operator guide contains the same guide text for offline use.
2. **Check the manifest metadata.** Generated at, source commit, registry counts, and file hashes identify the exact package. They are injected build evidence, not a claim about deployment or provider state.
3. **Use the escalation path when evidence is absent.** The package labels missing cost, contact, recording, provider, and deployment inputs. Do not replace those labels with an operator guess.

### Verify

- Every generated file hash matches MANIFEST.md.
- The manifest source commit is the package source you intended to use.

### If verification fails

If a hash differs, stop using the edited copy and regenerate from the committed source metadata.
