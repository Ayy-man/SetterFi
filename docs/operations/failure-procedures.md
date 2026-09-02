# Failure procedures

SetterFi has one environment. These procedures name the evidence, reversibility, verification,
and undo before an operator acts. Any step that requires database access belongs on the escalation
path rather than being improvised here.

## Provider outage or credential rotation

### Detection evidence

- System shows a failed or unavailable provider receipt.
- The affected queue rows retain their attempt and safe error codes.

### Reversible

Partly — selector changes are reversible; a provider-side rotation cannot be undone after the old credential is revoked.

### Action

1. Keep the affected real driver disabled until the provider account and intended asset are confirmed.
2. Rotate the credential in deployment custody without copying its value into a ticket, document, log, or screenshot.
3. Run the named rotation verifier and one allowlisted test-recipient probe before restoring the real selector.

### Verify

- The verifier names the intended provider and receipt class without printing a value.
- The allowlisted probe has a provider receipt and persisted read-back; an email acceptance is still Sent until its signed delivery receipt arrives.

### Undo

1. If the former credential is still valid, restore its deployment reference and rerun the same verifier.
2. If it was revoked, keep the driver disabled and escalate; do not invent a replacement value.

---

## CRM webhook delivery disabled after sustained failures

### Detection evidence

- Channel health shows stale webhook freshness while the connection itself remains present.
- The provider account shows delivery disabled after sustained low success.

### Reversible

Yes — after the endpoint is healthy, the provider webhook can be re-enabled.

### Action

1. Confirm the deployed callback responds successfully before changing the provider account.
2. Re-enable delivery for the intended location only.
3. Replay only the provider's eligible retained events through the idempotent receipt path.

### Verify

- Webhook freshness advances from a newly signed event.
- Replayed events have one persisted receipt and do not duplicate messages.

### Undo

1. Disable the webhook again if the callback resumes failing, and keep the connection state unavailable until the endpoint is repaired.

---

## Meta review or asset status changes

### Detection evidence

- Channel health shows the persisted review or asset state and its last evidence time.
- The filing package records the affected permission and required read-back.

### Reversible

No — review decisions and provider asset states are external facts.

### Action

1. Read the current provider status for the intended app and asset without changing a connection.
2. If more information is requested, update the filing evidence and resubmit through the provider console.
3. Keep the channel pending or unavailable until a current provider read-back supports a ready state.

### Verify

- The persisted state matches the current provider response and names its evidence time.
- No pending or rejected asset is rendered ready or live.

### Undo

1. There is no local undo for a provider review decision; restore only a local display error, never the external state.

---

## STOP, suppression, or tripwire incident

### Detection evidence

- Compliance shows the current suppression or provider-unconfirmed state.
- The conversation trace and audit log name the keyword, scope refusal, or tripwire event.

### Reversible

Only with authoritative opt-in or provider confirmation; a tripwire hold requires a named human release.

### Action

1. Keep outbound messaging refused while suppression or provider confirmation is unresolved.
2. Review the exact trace and durable suppression evidence without copying lead data into a support note.
3. Use the registered correction or human-release action only when its required evidence is present.

### Verify

- No provider call occurs while the refusal remains active.
- Any correction has its audit receipt and provider read-back before messaging resumes.

### Undo

1. Reapply suppression if a correction was based on incomplete evidence; never clear a durable tombstone by editing a display row.

---

## Notification delivery queue backlog

### Detection evidence

- System shows persisted due depth, terminal attempts, and the last job receipt.
- Attempt rows name retry times and safe error codes.

### Reversible

Yes — bounded retries remain idempotent while the queue lease and attempt records are intact.

### Action

1. Confirm the delivery job has a current persisted receipt before changing provider mode.
2. Resolve the named provider or configuration state and let due attempts retry through the worker.
3. Do not create a second manual send for an existing attempt.

### Verify

- Queue depth falls through persisted finishes rather than row deletion.
- Attempt numbers remain unique and terminal rows receive no new due time.

### Undo

1. Disable the affected real driver if errors increase, preserving all rows for later retry and audit.

---

## Onboarding or provisioning stall

### Detection evidence

- Provisioning names the stalled step, owner, state, and last evidence time.
- A2P registering stays amber during the 2–3 week carrier window; terminal rejection is permanently blocked.

### Reversible

Eligible step retries are reversible; a terminal carrier rejection is not retryable.

### Action

1. Identify whether the next action belongs to the coach, the platform, or an external provider.
2. Retry only an eligible current step and record the resulting audit receipt.
3. For a terminal rejection, leave the blocked state in place and escalate the carrier evidence.

### Verify

- The same row reads back the next attempt and state.
- No provisioning row reads done, 100 percent, or all set while work is queued or registering.

### Undo

1. Return an incorrectly advanced step to its last persisted evidence state through the owning service; never edit the tracker display.

---

## Billing failure or disputed count

### Detection evidence

- Billing shows the persisted subscription mirror, invoice event, and correction state.
- Allowance and account state are sourced without incomplete margin data.

### Reversible

Corrections use immutable offset events; suspension and reactivation require separate reasoned actions.

### Action

1. Reconcile the provider event with the persisted mirror before changing access.
2. Keep a failed payment overdue while dunning continues; do not automatically suspend the tenant.
3. For a valid count dispute, approve one correction with a reason and matching offset receipt.

### Verify

- The mirror and current allowance reflect the persisted event plus any single offset.
- The decision has its audit receipt and no original ledger row was edited.

### Undo

1. Reverse a mistaken correction with a new reasoned offset; reactivate a mistaken suspension through the registered action.

---

## Truncated or abandoned export

### Detection evidence

- Audit contains export.started without the matching export.finished row.
- The downloaded file ends before the expected row or JSON framing is complete.

### Reversible

Yes — the source query is read-only and a fresh export receives a new audit pair.

### Action

1. Keep the unmatched start row as evidence and discard the partial file.
2. Confirm the original filter, sort, columns, tenant, and reason before retrying.
3. Run a new export only after the source read is available.

### Verify

- The replacement file has complete framing and the expected visible columns.
- Its own start and finish rows agree on actor, target, row count, and byte count.

### Undo

1. Delete the incomplete local download; audit rows remain append-only and are not removed.
