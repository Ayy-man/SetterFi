# Audit action registry

Generated from the migrated `audit_actions` table in sorted key order. A UI may render Logged
only from a persisted receipt for one of these registered actions.

| Key | Actor | Scope | Reason required | Coach visible | Microcopy | Accessibility label |
| --- | --- | --- | --- | --- | --- | --- |
| affiliate.payout.approved | human | platform | Yes | No | Payout approval logged | Affiliate payout approval recorded in the audit log |
| affiliate.payout.sent | human | platform | No | No | Payout sent record logged | Affiliate payout sent record recorded in the audit log |
| appointment.attendance_set | human | tenant | No | Yes | Attendance logged | Attendance action recorded in the audit log |
| appointment.attendance_set.system | system | tenant | No | Yes | Attendance logged | Attendance recorded from the calendar provider in the audit log |
| appointment.canceled | system | tenant | No | Yes | Cancellation logged | Cancellation recorded in the audit log |
| appointment.created | system | tenant | No | Yes | Booking logged | Booking recorded in the audit log |
| appointment.rescheduled | system | tenant | No | Yes | Reschedule logged | Reschedule recorded in the audit log |
| billing.checkout.created | human | tenant | No | Yes | Checkout logged | Billing checkout creation recorded in the audit log |
| billing.correction.approved | human | tenant | Yes | Yes | Correction approval logged | Billing correction approval recorded in the audit log |
| billing.correction.rejected | human | tenant | Yes | Yes | Correction rejection logged | Billing correction rejection recorded in the audit log |
| billing.correction.requested | human | tenant | Yes | Yes | Correction request logged | Billing correction request recorded in the audit log |
| billing.tenant_override.updated | human | tenant | Yes | Yes | Price override logged | Tenant price override recorded in the audit log |
| billing.tenant.suspended | human | tenant | Yes | Yes | Suspension logged | Tenant billing suspension recorded in the audit log |
| billing.tenant.unsuspended | human | tenant | Yes | Yes | Reactivation logged | Tenant billing reactivation recorded in the audit log |
| billing.tier.updated | human | platform | Yes | No | Tier update logged | Billing tier update recorded in the audit log |
| brain.import.accepted | human | platform | No | No | Import acceptance logged | Brain import acceptance recorded in the audit log |
| brain.published | human | platform | Yes | No | Publish logged | Brain publish recorded in the audit log |
| brain.rolled_back | human | platform | Yes | No | Rollback logged | Brain rollback recorded in the audit log |
| calendar.connected | human | tenant | No | Yes | Connection logged | Calendar connection recorded in the audit log |
| calendar.disconnected | human | tenant | No | Yes | Disconnection logged | Calendar disconnection recorded in the audit log |
| channel.connect.completed | system | tenant | No | Yes | Connection logged | Channel connection completion recorded in the audit log |
| channel.connect.started | human | tenant | No | Yes | Connection start logged | Channel connection start recorded in the audit log |
| channel.disconnected | human | tenant | No | Yes | Disconnection logged | Channel disconnection recorded in the audit log |
| channel.provider.switched | human | tenant | Yes | Yes | Provider switch logged | Channel provider switch recorded in the audit log |
| channel.went_live | system | tenant | No | Yes | Channel activation logged | Channel activation recorded in the audit log |
| consent.opt_in | human | tenant | No | Yes | Consent logged | Consent action recorded in the audit log |
| consent.opt_out | human | tenant | No | Yes | Opt-out logged | Opt-out action recorded in the audit log |
| consent.web_form_recorded | system | tenant | No | Yes | Consent recorded | Hosted form consent evidence recorded in the audit log |
| contact.delete | human | tenant | Yes | Yes | Deletion logged | Contact deletion recorded in the audit log |
| contact.delete.preview | human | tenant | No | Yes | Deletion preview logged | Contact deletion preview recorded in the audit log |
| contact.merged | human | tenant | Yes | Yes | Merge logged | Contact merge recorded in the audit log |
| contact.unmerged | human | tenant | Yes | Yes | Undo logged | Contact merge undo recorded in the audit log |
| conversation.channel_continued | system | tenant | No | No | Continuation logged | Channel continuation recorded in the audit log |
| conversation.closed | human | tenant | Yes | Yes | Closure logged | Conversation closure recorded in the audit log |
| conversation.closed.stale | system | tenant | No | No | Stale closure logged | Stale conversation closure recorded in the audit log |
| conversation.escalated | system | tenant | No | Yes | Escalation logged | Conversation escalation recorded in the audit log |
| conversation.guardrail.cleared | human | tenant | Yes | Yes | Guardrail clear logged | Guardrail clear recorded in the audit log |
| conversation.internal_note.added | human | tenant | No | Yes | Internal note added | Internal conversation note recorded in the audit log |
| conversation.message.sent.human | human | tenant | No | Yes | Message sent | Human-authored message recorded in the audit log |
| conversation.scope_blocked | system | tenant | No | No | Scope block logged | Scope block recorded in the audit log |
| conversation.takeover.claimed | human | tenant | No | Yes | Takeover logged | Takeover recorded in the audit log |
| conversation.takeover.released | human | tenant | No | Yes | Hand-back logged | Hand-back recorded in the audit log |
| conversation.tripwire.refused | system | tenant | No | No | Tripwire refusal logged | Tripwire refusal recorded in the audit log |
| eval.case.promoted | human | platform | No | No | Eval case promotion logged | Eval case promotion recorded in the audit log |
| eval.model_config.created | human | platform | No | No | Challenger model configuration created | Challenger model configuration creation recorded in the audit log |
| export.finished | human | tenant | No | No | Export completion logged | Export completion recorded in the audit log |
| export.started | human | tenant | No | No | Export start logged | Export start recorded in the audit log |
| followup.canceled.inbound | system | tenant | No | No | Follow-ups canceled | Inbound follow-up cancellation recorded in the audit log |
| followup.claimed | system | tenant | No | No | Follow-up claim logged | Follow-up worker claim recorded in the audit log |
| followup.completed | system | tenant | No | No | Follow-up completion logged | Follow-up completion recorded in the audit log |
| followup.deferred.quiet_hours | system | tenant | No | No | Follow-up deferral logged | Quiet-hours deferral recorded in the audit log |
| followup.discarded.window_closed | system | tenant | No | No | Follow-up discard logged | Provider-window discard recorded in the audit log |
| impersonation.ended | human | tenant | No | No | View-as session end logged | View-as session end recorded in the audit log |
| impersonation.started | human | tenant | Yes | No | View-as session logged | View-as session recorded in the audit log |
| message_template.rejected | system | tenant | No | Yes | Template rejection logged | Message template rejection recorded in the audit log |
| message_template.submitted | human | tenant | No | Yes | Template submission logged | Message template submission recorded in the audit log |
| offer.published | human | tenant | No | Yes | Offer publish logged | Offer publish recorded in the audit log |
| onboarding.a2p_blocked_permanent | system | tenant | No | Yes | Permanent registration block logged | Permanent registration block recorded in the audit log |
| onboarding.a2p_filing_confirmed | human | tenant | No | Yes | Registration filing logged | Registration filing recorded in the audit log |
| onboarding.artifact_confirmed | human | tenant | No | Yes | Consent page confirmation logged | Consent page confirmation recorded in the audit log |
| onboarding.content_acknowledged | human | tenant | No | Yes | Content acknowledgement logged | Registration content acknowledgement recorded in the audit log |
| onboarding.content_admin_confirmed | human | tenant | No | Yes | Content confirmation logged | Registration content confirmation recorded in the audit log |
| onboarding.signup_completed | human | tenant | No | Yes | Signup logged | Onboarding signup recorded in the audit log |
| onboarding.step_failed | system | tenant | No | No | Provisioning failure logged | Provisioning failure recorded in the audit log |
| onboarding.step_retried | human | tenant | No | Yes | Retry logged | Provisioning retry recorded in the audit log |
| onboarding.step_unblocked | human | tenant | Yes | Yes | Unblock logged | Provisioning unblock recorded in the audit log |
| platform_export.finished | human | platform | Yes | No | Platform export completion logged | Platform export completion recorded in the audit log |
| platform_export.started | human | platform | Yes | No | Platform export start logged | Platform export start recorded in the audit log |
| provider.rotation.verified | human | platform | No | No | Rotation verification logged | Provider credential rotation recorded in the audit log |
| quiet_hours.window.change | human | tenant | No | Yes | Quiet-hours change logged | Quiet-hours change recorded in the audit log |
| referral.code_rejected | system | platform | No | No | Referral refusal logged | Referral refusal recorded in the audit log |
| send.refused.no_consent | system | tenant | No | No | Consent refusal logged | Consent refusal recorded in the audit log |
| send.refused.suppressed | system | tenant | No | No | Suppression refusal logged | Suppression refusal recorded in the audit log |
| send.refused.window_expired | system | tenant | No | No | Window refusal logged | Expired provider-window refusal recorded in the audit log |
| suppression.clear.provider | system | tenant | No | No | Provider suppression cleared | Provider-confirmed suppression clear recorded in the audit log |
| suppression.correct | human | tenant | Yes | Yes | Suppression correction logged | Suppression correction recorded in the audit log |
| suppression.insert.keyword | system | tenant | No | Yes | Opt-out logged | Keyword opt-out recorded in the audit log |
| suppression.insert.manual | human | tenant | No | Yes | Suppression logged | Suppression action recorded in the audit log |
| suppression.provider.confirmed | system | tenant | No | No | Provider suppression confirmed | Provider suppression confirmation recorded in the audit log |
| suppression.provider.unconfirmed | system | tenant | No | No | Provider suppression unconfirmed | Provider suppression failure recorded in the audit log |
| suppression.push.failed | system | tenant | No | No | Provider suppression failure logged | Provider suppression failure recorded in the audit log |
| suppression.push.provider | system | tenant | No | No | Provider suppression logged | Provider suppression recorded in the audit log |
| tenant.billing_contact_changed | human | tenant | No | Yes | Billing contact change logged | Billing contact change recorded in the audit log |
| tenant.demo_flag.changed | human | platform | Yes | No | Demo flag change logged | Demo flag change recorded in the audit log |
| tenant.success_owner.reassigned | human | tenant | Yes | No | Reassignment logged | Success owner reassignment recorded in the audit log |
| tenant.went_live | human | tenant | No | Yes | Go-live logged | Go-live recorded in the audit log |
| test_recipient.registered | human | tenant | No | Yes | Test recipient logged | Verified test recipient recorded in the audit log |
