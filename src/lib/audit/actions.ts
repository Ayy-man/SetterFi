/**
 * Typed mirror of the Phase 1 audit registry seed.
 *
 * CLOSED TO NEW KEYS, with one narrow exception. This is the Plan 01 seed as it was frozen, not
 * the list of audit actions that exist. Its own test pins it byte-for-byte against a literal
 * inventory, so adding a key here fails the suite even when that key is real and a migration
 * writes it. Every action added after Plan 01 — the `tenant.membership.*`, `tenant.ownership.*`
 * and `account.terms.*` families among them — lives in its own migration and in the `AUDIT_KEYS`
 * array in `supabase/tests/phase1-schema.test.ts`, and nowhere else. Put a new key there.
 *
 * The exception is `POST_SEED_UI_ACTIONS` below: a post-Plan-01 key whose action has a control in
 * the interface needs its microcopy in TypeScript, because `LoggedPill` and `LoggedButton` take an
 * `AuditActionKey` and read their words from this map. Those keys are still declared in a
 * migration and in the `AUDIT_KEYS` array first; the block below mirrors the migration's own
 * `microcopy` and `aria_label` text, and `actions.test.ts` holds it to that. It is a mirror of
 * something already true, not a second place to invent a key.
 *
 * UI accountability copy comes from this registry contract only. Keeping action keys closed makes
 * an invented key fail at compile time, while the sorted-set test catches seed/type drift.
 */

type AuditActionDefinition = {
  actorKind: "human" | "system";
  scope: "tenant" | "platform";
  reasonRequired: boolean;
  coachVisible: boolean;
  microcopy: string;
  ariaLabel: string;
};

const SEED_AUDIT_ACTIONS = {
  "appointment.attendance_set": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Attendance logged", ariaLabel: "Attendance action recorded in the audit log",
  },
  "appointment.attendance_set.system": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Attendance logged", ariaLabel: "Attendance recorded from the calendar provider in the audit log",
  },
  "appointment.canceled": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Cancellation logged", ariaLabel: "Cancellation recorded in the audit log",
  },
  "appointment.created": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Booking logged", ariaLabel: "Booking recorded in the audit log",
  },
  "appointment.rescheduled": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Reschedule logged", ariaLabel: "Reschedule recorded in the audit log",
  },
  "brain.import.accepted": {
    actorKind: "human", scope: "platform", reasonRequired: false, coachVisible: false,
    microcopy: "Import acceptance logged", ariaLabel: "Brain import acceptance recorded in the audit log",
  },
  "brain.published": {
    actorKind: "human", scope: "platform", reasonRequired: true, coachVisible: false,
    microcopy: "Publish logged", ariaLabel: "Brain publish recorded in the audit log",
  },
  "brain.rolled_back": {
    actorKind: "human", scope: "platform", reasonRequired: true, coachVisible: false,
    microcopy: "Rollback logged", ariaLabel: "Brain rollback recorded in the audit log",
  },
  "calendar.connected": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Connection logged", ariaLabel: "Calendar connection recorded in the audit log",
  },
  "calendar.disconnected": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Disconnection logged", ariaLabel: "Calendar disconnection recorded in the audit log",
  },
  "capi.dataset.provisioned": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Conversion tracking setup logged",
    ariaLabel: "Conversion tracking dataset setup recorded in the audit log",
  },
  "channel.connect.completed": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Connection logged", ariaLabel: "Channel connection completion recorded in the audit log",
  },
  "channel.connect.started": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Connection start logged", ariaLabel: "Channel connection start recorded in the audit log",
  },
  "channel.disconnected": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Disconnection logged", ariaLabel: "Channel disconnection recorded in the audit log",
  },
  "channel.provider.switched": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Provider switch logged", ariaLabel: "Channel provider switch recorded in the audit log",
  },
  "channel.went_live": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Channel activation logged", ariaLabel: "Channel activation recorded in the audit log",
  },
  "compliance.control_reply.published": {
    actorKind: "human", scope: "platform", reasonRequired: false, coachVisible: false,
    microcopy: "Publication logged", ariaLabel: "Control reply publication recorded in the audit log",
  },
  "consent.opt_in": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Consent logged", ariaLabel: "Consent action recorded in the audit log",
  },
  "consent.opt_out": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Opt-out logged", ariaLabel: "Opt-out action recorded in the audit log",
  },
  "contact.created.manual": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Contact logged", ariaLabel: "Manual contact creation recorded in the audit log",
  },
  "contact.delete": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Deletion logged", ariaLabel: "Contact deletion recorded in the audit log",
  },
  "contact.imported": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Import logged", ariaLabel: "Contact import recorded in the audit log",
  },
  "contact.merged": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Merge logged", ariaLabel: "Contact merge recorded in the audit log",
  },
  "contact.note.added": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Note logged", ariaLabel: "Contact note recorded in the audit log",
  },
  "contact.pipeline_stage.set": {
    actorKind: "human",
    scope: "tenant",
    reasonRequired: false,
    coachVisible: true,
    microcopy: "Logged",
    ariaLabel: "Change the pipeline stage. This change is recorded in the audit log.",
  },
  "contact.tag.added": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Tag logged", ariaLabel: "Contact tag addition recorded in the audit log",
  },
  "contact.tag.removed": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Tag removal logged", ariaLabel: "Contact tag removal recorded in the audit log",
  },
  "contact.unmerged": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Undo logged", ariaLabel: "Contact merge undo recorded in the audit log",
  },
  "conversation.channel_continued": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Continuation logged", ariaLabel: "Channel continuation recorded in the audit log",
  },
  "conversation.closed": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Closure logged", ariaLabel: "Conversation closure recorded in the audit log",
  },
  "conversation.closed.stale": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Stale closure logged", ariaLabel: "Stale conversation closure recorded in the audit log",
  },
  "conversation.escalated": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Escalation logged", ariaLabel: "Conversation escalation recorded in the audit log",
  },
  "conversation.guardrail.cleared": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Guardrail clear logged", ariaLabel: "Guardrail clear recorded in the audit log",
  },
  "conversation.internal_note.added": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Internal note added", ariaLabel: "Internal conversation note recorded in the audit log",
  },
  "conversation.message.sent.human": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Message sent", ariaLabel: "Human-authored message recorded in the audit log",
  },
  "conversation.scope_blocked": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Scope block logged", ariaLabel: "Scope block recorded in the audit log",
  },
  "conversation.takeover.claimed": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Takeover logged", ariaLabel: "Takeover recorded in the audit log",
  },
  "conversation.takeover.released": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Hand-back logged", ariaLabel: "Hand-back recorded in the audit log",
  },
  "export.finished": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Export completion logged", ariaLabel: "Export completion recorded in the audit log",
  },
  "export.started": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Export start logged", ariaLabel: "Export start recorded in the audit log",
  },
  "impersonation.ended": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "View-as session end logged", ariaLabel: "View-as session end recorded in the audit log",
  },
  "impersonation.started": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: false,
    microcopy: "View-as session logged", ariaLabel: "View-as session recorded in the audit log",
  },
  "keyword_goal.deactivated": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Keyword goal deactivation logged",
    ariaLabel: "Keyword goal deactivation recorded in the audit log",
  },
  "keyword_goal.saved": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Keyword goal saved",
    ariaLabel: "Keyword goal change recorded in the audit log",
  },
  "message_template.rejected": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Template rejection logged", ariaLabel: "Message template rejection recorded in the audit log",
  },
  "message_template.submitted": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Template submission logged", ariaLabel: "Message template submission recorded in the audit log",
  },
  "onboarding.a2p_blocked_permanent": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Permanent registration block logged", ariaLabel: "Permanent registration block recorded in the audit log",
  },
  "onboarding.a2p_filing_confirmed": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Registration filing logged", ariaLabel: "Registration filing recorded in the audit log",
  },
  "onboarding.step_failed": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Provisioning failure logged", ariaLabel: "Provisioning failure recorded in the audit log",
  },
  "onboarding.step_retried": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Retry logged", ariaLabel: "Provisioning retry recorded in the audit log",
  },
  "onboarding.step_unblocked": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Unblock logged", ariaLabel: "Provisioning unblock recorded in the audit log",
  },
  "offer.published": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Offer publish logged", ariaLabel: "Offer publish recorded in the audit log",
  },
  "platform_export.finished": {
    actorKind: "human", scope: "platform", reasonRequired: true, coachVisible: false,
    microcopy: "Platform export completion logged", ariaLabel: "Platform export completion recorded in the audit log",
  },
  "platform_export.started": {
    actorKind: "human", scope: "platform", reasonRequired: true, coachVisible: false,
    microcopy: "Platform export start logged", ariaLabel: "Platform export start recorded in the audit log",
  },
  "quiet_hours.window.change": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Quiet-hours change logged", ariaLabel: "Quiet-hours change recorded in the audit log",
  },
  "referral.code_rejected": {
    actorKind: "system", scope: "platform", reasonRequired: false, coachVisible: false,
    microcopy: "Referral refusal logged", ariaLabel: "Referral refusal recorded in the audit log",
  },
  "send.refused.no_consent": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Consent refusal logged", ariaLabel: "Consent refusal recorded in the audit log",
  },
  "send.refused.suppressed": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Suppression refusal logged", ariaLabel: "Suppression refusal recorded in the audit log",
  },
  "send.refused.window_expired": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Window refusal logged", ariaLabel: "Expired provider-window refusal recorded in the audit log",
  },
  "suppression.correct": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Suppression correction logged", ariaLabel: "Suppression correction recorded in the audit log",
  },
  "suppression.insert.manual": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Suppression logged", ariaLabel: "Suppression action recorded in the audit log",
  },
  "suppression.push.failed": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Provider suppression failure logged", ariaLabel: "Provider suppression failure recorded in the audit log",
  },
  "suppression.push.provider": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Provider suppression logged", ariaLabel: "Provider suppression recorded in the audit log",
  },
  "tenant.billing_contact_changed": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Billing contact change logged", ariaLabel: "Billing contact change recorded in the audit log",
  },
  "tenant.demo_flag.changed": {
    actorKind: "human", scope: "platform", reasonRequired: true, coachVisible: false,
    microcopy: "Demo flag change logged", ariaLabel: "Demo flag change recorded in the audit log",
  },
  // Phase 8
  "tenant.success_owner.reassigned": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: false,
    microcopy: "Reassignment logged", ariaLabel: "Success owner reassignment recorded in the audit log",
  },
  "tenant.went_live": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Go-live logged", ariaLabel: "Go-live recorded in the audit log",
  },
  // Phase 3
  "contact.delete.preview": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Deletion preview logged", ariaLabel: "Contact deletion preview recorded in the audit log",
  },
  "conversation.tripwire.refused": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Tripwire refusal logged", ariaLabel: "Tripwire refusal recorded in the audit log",
  },
  "followup.canceled.inbound": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Follow-ups canceled", ariaLabel: "Inbound follow-up cancellation recorded in the audit log",
  },
  "followup.claimed": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Follow-up claim logged", ariaLabel: "Follow-up worker claim recorded in the audit log",
  },
  "followup.completed": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Follow-up completion logged", ariaLabel: "Follow-up completion recorded in the audit log",
  },
  "followup.deferred.quiet_hours": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Follow-up deferral logged", ariaLabel: "Quiet-hours deferral recorded in the audit log",
  },
  "followup.discarded.window_closed": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Follow-up discard logged", ariaLabel: "Provider-window discard recorded in the audit log",
  },
  "provider.rotation.verified": {
    actorKind: "human", scope: "platform", reasonRequired: false, coachVisible: false,
    microcopy: "Rotation verification logged", ariaLabel: "Provider credential rotation recorded in the audit log",
  },
  "suppression.clear.provider": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Provider suppression cleared", ariaLabel: "Provider-confirmed suppression clear recorded in the audit log",
  },
  "suppression.insert.keyword": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Opt-out logged", ariaLabel: "Keyword opt-out recorded in the audit log",
  },
  "suppression.provider.confirmed": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Provider suppression confirmed", ariaLabel: "Provider suppression confirmation recorded in the audit log",
  },
  "suppression.provider.unconfirmed": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: false,
    microcopy: "Provider suppression unconfirmed", ariaLabel: "Provider suppression failure recorded in the audit log",
  },
  "test_recipient.registered": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Test recipient logged", ariaLabel: "Verified test recipient recorded in the audit log",
  },
  // Phase 5
  "consent.web_form_recorded": {
    actorKind: "system", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Consent recorded", ariaLabel: "Hosted form consent evidence recorded in the audit log",
  },
  "onboarding.artifact_confirmed": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Consent page confirmation logged", ariaLabel: "Consent page confirmation recorded in the audit log",
  },
  "onboarding.content_acknowledged": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Content acknowledgement logged", ariaLabel: "Registration content acknowledgement recorded in the audit log",
  },
  "onboarding.content_admin_confirmed": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Content confirmation logged", ariaLabel: "Registration content confirmation recorded in the audit log",
  },
  "onboarding.signup_completed": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Signup logged", ariaLabel: "Onboarding signup recorded in the audit log",
  },
  // Phase 6
  "affiliate.payout.approved": {
    actorKind: "human", scope: "platform", reasonRequired: true, coachVisible: false,
    microcopy: "Payout approval logged", ariaLabel: "Affiliate payout approval recorded in the audit log",
  },
  "affiliate.payout.sent": {
    actorKind: "human", scope: "platform", reasonRequired: false, coachVisible: false,
    microcopy: "Payout sent record logged", ariaLabel: "Affiliate payout sent record recorded in the audit log",
  },
  "billing.checkout.created": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Checkout logged", ariaLabel: "Billing checkout creation recorded in the audit log",
  },
  "billing.correction.approved": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Correction approval logged", ariaLabel: "Billing correction approval recorded in the audit log",
  },
  "billing.correction.rejected": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Correction rejection logged", ariaLabel: "Billing correction rejection recorded in the audit log",
  },
  "billing.correction.requested": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Correction request logged", ariaLabel: "Billing correction request recorded in the audit log",
  },
  "billing.tenant.suspended": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Suspension logged", ariaLabel: "Tenant billing suspension recorded in the audit log",
  },
  "billing.tenant.unsuspended": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Reactivation logged", ariaLabel: "Tenant billing reactivation recorded in the audit log",
  },
  "billing.tenant_override.updated": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Price override logged", ariaLabel: "Tenant price override recorded in the audit log",
  },
  "billing.tier.updated": {
    actorKind: "human", scope: "platform", reasonRequired: true, coachVisible: false,
    microcopy: "Tier update logged", ariaLabel: "Billing tier update recorded in the audit log",
  },
  // Phase 7
  "eval.case.promoted": {
    actorKind: "human", scope: "platform", reasonRequired: false, coachVisible: false,
    microcopy: "Eval case promotion logged", ariaLabel: "Eval case promotion recorded in the audit log",
  },
  "eval.model_config.created": {
    actorKind: "human", scope: "platform", reasonRequired: false, coachVisible: false,
    microcopy: "Challenger model configuration created", ariaLabel: "Challenger model configuration creation recorded in the audit log",
  },
} as const satisfies Record<string, AuditActionDefinition>;

/**
 * Post-Plan-01 keys the interface has to render copy for, mirrored from their own migrations.
 *
 * `auth.signed_out` is seeded by `20260909000001_auth_recovery_audit_actions.sql` and written by
 * `/auth/signout`; `notification.preference.changed` by
 * `20261010000001_notification_preference_audit_action.sql` and by the notification-preferences
 * PUT. Both carry a control in the account panel, and a control that claims a record has to say
 * which words the record uses. Every field here is copied from the migration that seeds it.
 *
 * `offer.draft.saved` is seeded by `20260929000001_offer_change_trail.sql` and written inside the
 * `save_offer_draft` function itself, not by the route -- the row, the `offer.changed` row beside
 * it and the `offer_change_trail` entry that foreign-keys to both are one statement in one
 * transaction, so the save and its record land together or neither does. That is why the coach
 * offer route has no audit insert of its own to add: a second write here would log the same save
 * twice. Scope is tenant, unlike the two above, because an offer belongs to a tenant.
 *
 * `coach.question_order.saved` and `coach.question.enabled.changed` are both seeded by
 * `20261009000004_tenant_question_settings.sql` and written inside `save_coach_question_order` and
 * `set_coach_question_enabled`, in the same statement as the `tenant_question_settings` row each
 * one upserts. They stay two keys rather than one because a coach reading their own log needs to
 * tell a reordering apart from a question being switched off, which are different decisions about
 * what a lead is asked. Tenant scope, because the settings row is per tenant.
 *
 * `conversation.rehearsal.played` is seeded by `20261013000005_rehearsal_audit.sql` and written by
 * `record_rehearsal_turn`, which the rehearsal calls between persisting the lead's receipt and
 * running the processor on it, so the line is logged before it has any effect. The Inbox shows
 * the receipt under the "Rehearse as the lead" control. Tenant scope and coach visible, because
 * the coach on the demo workspace is the one rehearsing.
 *
 * `followup_copy.*` is seeded by `20261013000009_followup_copy_authoring.sql`. The coach's draft
 * and submission controls, and the platform approval controls, all return the persisted receipt
 * from the same RPC that wrote the row, so these are the words each control is allowed to claim.
 */
const POST_SEED_UI_ACTIONS = {
  "auth.signed_out": {
    actorKind: "human", scope: "platform", reasonRequired: false, coachVisible: false,
    microcopy: "Sign-out logged", ariaLabel: "Sign-out recorded in the audit log",
  },
  "coach.question.enabled.changed": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Question setting logged",
    ariaLabel: "Qualification-question setting recorded in the audit log",
  },
  "coach.question_order.saved": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Question order logged",
    ariaLabel: "Qualification-question order recorded in the audit log",
  },
  "conversation.rehearsal.played": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Rehearsal logged",
    ariaLabel: "Rehearsal turn recorded in the audit log",
  },
  "followup_copy.approved": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Follow-up copy approval logged", ariaLabel: "Follow-up copy approval recorded in the audit log",
  },
  "followup_copy.draft.saved": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Follow-up copy draft logged", ariaLabel: "Follow-up copy draft recorded in the audit log",
  },
  "followup_copy.rejected": {
    actorKind: "human", scope: "tenant", reasonRequired: true, coachVisible: true,
    microcopy: "Follow-up copy rejection logged", ariaLabel: "Follow-up copy rejection recorded in the audit log",
  },
  "followup_copy.submitted": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Follow-up copy submission logged", ariaLabel: "Follow-up copy submission recorded in the audit log",
  },
  "notification.preference.changed": {
    actorKind: "human", scope: "platform", reasonRequired: false, coachVisible: true,
    microcopy: "Notification change logged",
    ariaLabel: "Notification preference change recorded in the audit log",
  },
  "offer.draft.saved": {
    actorKind: "human", scope: "tenant", reasonRequired: false, coachVisible: true,
    microcopy: "Offer draft save logged",
    ariaLabel: "Offer draft save recorded in the audit log",
  },
} as const satisfies Record<string, AuditActionDefinition>;

export type PostSeedUiActionKey = keyof typeof POST_SEED_UI_ACTIONS;

export const POST_SEED_UI_ACTION_KEYS = Object.keys(POST_SEED_UI_ACTIONS).sort() as PostSeedUiActionKey[];

export const AUDIT_ACTIONS = { ...SEED_AUDIT_ACTIONS, ...POST_SEED_UI_ACTIONS };

export type AuditActionKey = keyof typeof AUDIT_ACTIONS;

export const CAPI_DATASET_AUDIT_ACTION = {
  key: "capi.dataset.provisioned",
  ...AUDIT_ACTIONS["capi.dataset.provisioned"],
} as const;

export const AUDIT_ACTION_KEYS = Object.keys(AUDIT_ACTIONS).sort() as AuditActionKey[];

export const PHASE7_AUDIT_KEYS = [
  "eval.case.promoted",
  "eval.model_config.created",
] as const satisfies readonly AuditActionKey[];

export const PHASE8_AUDIT_KEYS = [
  "tenant.success_owner.reassigned",
] as const satisfies readonly AuditActionKey[];
