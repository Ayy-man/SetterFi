# Audit action registry

Generated from the migrated `audit_actions` table in sorted key order. A UI may render Logged
only from a persisted receipt for one of these registered actions.

| Key | Actor | Scope | Reason required | Coach visible | Microcopy | Accessibility label |
| --- | --- | --- | --- | --- | --- | --- |
| account.terms.accepted | human | tenant | No | Yes | Account terms acceptance recorded | Account terms acceptance recorded in the audit log |
| account.terms.drafted | human | platform | No | No | Terms draft logged | Account terms draft recorded in the audit log |
| account.terms.published | human | platform | No | No | Terms publication logged | Account terms publication recorded in the audit log |
| affiliate.payout.approved | human | platform | Yes | No | Payout approval logged | Affiliate payout approval recorded in the audit log |
| affiliate.payout.sent | human | platform | No | No | Payout sent record logged | Affiliate payout sent record recorded in the audit log |
| appointment.attendance_set | human | tenant | No | Yes | Attendance logged | Attendance action recorded in the audit log |
| appointment.attendance_set.system | system | tenant | No | Yes | Attendance logged | Attendance recorded from the calendar provider in the audit log |
| appointment.cancel.confirmed | human | tenant | Yes | Yes | Cancellation confirmed | Calendar-confirmed cancellation recorded in the audit log |
| appointment.cancel.failed | human | tenant | Yes | Yes | Cancellation failure logged | Calendar cancellation failure recorded in the audit log |
| appointment.cancel.requested | human | tenant | Yes | Yes | Cancellation request logged | Cancellation request recorded in the audit log |
| appointment.canceled | system | tenant | No | Yes | Cancellation logged | Cancellation recorded in the audit log |
| appointment.created | system | tenant | No | Yes | Booking logged | Booking recorded in the audit log |
| appointment.reschedule.confirmed | human | tenant | Yes | Yes | Reschedule confirmed | Calendar-confirmed reschedule recorded in the audit log |
| appointment.reschedule.failed | human | tenant | Yes | Yes | Reschedule failure logged | Calendar reschedule failure recorded in the audit log |
| appointment.reschedule.requested | human | tenant | Yes | Yes | Reschedule request logged | Reschedule request recorded in the audit log |
| appointment.rescheduled | system | tenant | No | Yes | Reschedule logged | Reschedule recorded in the audit log |
| auth.email_change.confirmed | human | platform | No | No | Email change confirmed | Account email change confirmation recorded in the audit log |
| auth.email_change.diverged | system | platform | No | No | Email change identity divergence logged | Account email change identity divergence recorded in the audit log |
| auth.email_change.refused | human | platform | No | No | Email change refused | Account email change refusal recorded in the audit log |
| auth.email_change.requested | human | platform | No | No | Email change request logged | Account email change request recorded in the audit log |
| auth.email_verification.requested | system | platform | No | No | Verification email request logged | Verification email request recorded in the audit log |
| auth.mfa.activated | human | platform | No | No | Second-factor activation logged | Second-factor activation recorded in the audit log |
| auth.mfa.disabled | human | platform | No | No | Second-factor removal logged | Second-factor removal recorded in the audit log |
| auth.mfa.enrolled | human | platform | No | No | Second-factor enrollment logged | Second-factor enrollment recorded in the audit log |
| auth.mfa.verification_failed | human | platform | No | No | Second-factor verification failure logged | Second-factor verification failure recorded in the audit log |
| auth.password_reset.completed | human | platform | No | No | Password reset logged | Password reset completion recorded in the audit log |
| auth.password_reset.requested | system | platform | No | No | Password reset request logged | Password reset request recorded in the audit log |
| auth.password.changed | human | platform | No | No | Password change logged | Account password change recorded in the audit log |
| auth.session.revoked | human | platform | Yes | No | Session revocation logged | Account session revocation recorded in the audit log |
| auth.sessions.others_revoked | human | platform | Yes | No | Other sessions revocation logged | Other account sessions revocation recorded in the audit log |
| auth.sessions.viewed | human | platform | No | No | Session review logged | Account session review recorded in the audit log |
| auth.signed_out | human | platform | No | No | Sign-out logged | Sign-out recorded in the audit log |
| billing.checkout.created | human | tenant | No | Yes | Checkout logged | Billing checkout creation recorded in the audit log |
| billing.correction.approved | human | tenant | Yes | Yes | Correction approval logged | Billing correction approval recorded in the audit log |
| billing.correction.rejected | human | tenant | Yes | Yes | Correction rejection logged | Billing correction rejection recorded in the audit log |
| billing.correction.requested | human | tenant | Yes | Yes | Correction request logged | Billing correction request recorded in the audit log |
| billing.tenant_override.updated | human | tenant | Yes | Yes | Price override logged | Tenant price override recorded in the audit log |
| billing.tenant.suspended | human | tenant | Yes | Yes | Suspension logged | Tenant billing suspension recorded in the audit log |
| billing.tenant.unsuspended | human | tenant | Yes | Yes | Reactivation logged | Tenant billing reactivation recorded in the audit log |
| billing.tier_change.completed | system | tenant | No | Yes | Scheduled tier change completed | Scheduled tier change completion recorded in the audit log |
| billing.tier_offer_term.closed | human | platform | Yes | No | Term close logged | Commercial term close recorded in the audit log |
| billing.tier_offer_term.recorded | human | platform | Yes | No | Commercial term logged | Commercial term recorded in the audit log |
| billing.tier.updated | human | platform | Yes | No | Tier update logged | Billing tier update recorded in the audit log |
| brain.import.accepted | human | platform | No | No | Import acceptance logged | Brain import acceptance recorded in the audit log |
| brain.published | human | platform | Yes | No | Publish logged | Brain publish recorded in the audit log |
| brain.rolled_back | human | platform | Yes | No | Rollback logged | Brain rollback recorded in the audit log |
| calendar.connected | human | tenant | No | Yes | Connection logged | Calendar connection recorded in the audit log |
| calendar.disconnected | human | tenant | No | Yes | Disconnection logged | Calendar disconnection recorded in the audit log |
| capi.dataset.provisioned | human | tenant | No | Yes | Conversion tracking setup logged | Conversion tracking dataset setup recorded in the audit log |
| capi.event.sent | system | tenant | No | No | Conversion event send logged | Meta conversion event send recorded in the audit log |
| channel.connect.completed | system | tenant | No | Yes | Connection logged | Channel connection completion recorded in the audit log |
| channel.connect.started | human | tenant | No | Yes | Connection start logged | Channel connection start recorded in the audit log |
| channel.connection.disconnected | human | tenant | No | Yes | Disconnection logged | Provider revocation and disconnection recorded in the audit log |
| channel.connection.reconnect.started | human | tenant | No | Yes | Reconnect started | Provider reauthorization started and recorded in the audit log |
| channel.connection.tested | human | tenant | No | Yes | Connection test logged | Provider connection test recorded in the audit log |
| channel.disconnected | human | tenant | No | Yes | Disconnection logged | Channel disconnection recorded in the audit log |
| channel.messaging_install.completed | human | tenant | No | Yes | Connection logged | Messaging connection recorded in the audit log |
| channel.messaging_install.declined | system | tenant | No | Yes | Approval decline logged | Messaging install decline recorded in the audit log |
| channel.messaging_install.failed | system | tenant | No | Yes | Install failure logged | Messaging install failure recorded in the audit log |
| channel.messaging_install.reauthorization_required | system | tenant | No | Yes | Reconnect needed logged | Messaging reconnection requirement recorded in the audit log |
| channel.messaging_install.start_refused | human | platform | No | No | Install refusal logged | Messaging install refusal recorded in the audit log |
| channel.messaging_install.started | human | platform | No | No | Install start logged | Messaging install start recorded in the audit log |
| channel.provider.switched | human | tenant | Yes | Yes | Provider switch logged | Channel provider switch recorded in the audit log |
| channel.went_live | system | tenant | No | Yes | Channel activation logged | Channel activation recorded in the audit log |
| coach.question_order.saved | human | tenant | No | Yes | Question order logged | Qualification-question order recorded in the audit log |
| coach.question.enabled.changed | human | tenant | No | Yes | Question setting logged | Qualification-question setting recorded in the audit log |
| compliance.control_reply.published | human | tenant | Yes | Yes | Control reply approval logged | Carrier control reply approval recorded in the audit log |
| consent.opt_in | human | tenant | No | Yes | Consent logged | Consent action recorded in the audit log |
| consent.opt_out | human | tenant | No | Yes | Opt-out logged | Opt-out action recorded in the audit log |
| consent.web_form_recorded | system | tenant | No | Yes | Consent recorded | Hosted form consent evidence recorded in the audit log |
| consumer.conversation_started | system | tenant | No | Yes | Lead conversation started | Lead conversation start recorded in the audit log |
| contact.created.manual | human | tenant | No | Yes | Contact creation logged | Manual contact creation recorded in the audit log |
| contact.delete | human | tenant | Yes | Yes | Deletion logged | Contact deletion recorded in the audit log |
| contact.delete.preview | human | tenant | No | Yes | Deletion preview logged | Contact deletion preview recorded in the audit log |
| contact.delete.recovery_adopted | human | tenant | Yes | No | Deletion recovery adopted | Privileged contact deletion recovery recorded in the audit log |
| contact.imported | human | tenant | No | Yes | Contact import logged | Contact import recorded in the audit log |
| contact.merged | human | tenant | Yes | Yes | Merge logged | Contact merge recorded in the audit log |
| contact.note.added | human | tenant | No | Yes | Contact note logged | Contact note recorded in the audit log |
| contact.tag.added | human | tenant | No | Yes | Contact tag logged | Contact tag assignment recorded in the audit log |
| contact.tag.removed | human | tenant | No | Yes | Contact tag removal logged | Contact tag removal recorded in the audit log |
| contact.unmerged | human | tenant | Yes | Yes | Undo logged | Contact merge undo recorded in the audit log |
| conversation.channel_continued | system | tenant | No | No | Continuation logged | Channel continuation recorded in the audit log |
| conversation.closed | human | tenant | Yes | Yes | Closure logged | Conversation closure recorded in the audit log |
| conversation.closed.stale | system | tenant | No | No | Stale closure logged | Stale conversation closure recorded in the audit log |
| conversation.escalated | system | tenant | No | Yes | Escalation logged | Conversation escalation recorded in the audit log |
| conversation.guardrail.cleared | human | tenant | Yes | Yes | Guardrail clear logged | Guardrail clear recorded in the audit log |
| conversation.internal_note.added | human | tenant | No | Yes | Internal note added | Internal conversation note recorded in the audit log |
| conversation.message.sent.human | human | tenant | No | Yes | Message sent | Human-authored message recorded in the audit log |
| conversation.outbound_send.reconciled | human | tenant | Yes | Yes | Outbound send reconciled | Uncertain provider send reconciled in the audit log |
| conversation.outbound_send.reconciliation_required | system | tenant | No | Yes | Outbound send needs reconciliation | Uncertain provider send recorded for evidence-backed reconciliation |
| conversation.rehearsal.played | human | tenant | No | Yes | Rehearsal logged | Rehearsal turn recorded in the audit log |
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
| keyword_goal.deactivated | human | tenant | No | Yes | Keyword goal deactivation logged | Keyword goal deactivation recorded in the audit log |
| keyword_goal.saved | human | tenant | No | Yes | Keyword goal saved | Keyword goal change recorded in the audit log |
| message_template.rejected | system | tenant | No | Yes | Template rejection logged | Message template rejection recorded in the audit log |
| message_template.submitted | human | tenant | No | Yes | Template submission logged | Message template submission recorded in the audit log |
| message_template.synced | human | tenant | No | Yes | Template sync logged | Provider template approval state recorded in the audit log |
| money.page.refused | human | platform | No | No | Refusal logged | Money page refusal recorded in the audit log |
| notification.a2p.cleared | system | tenant | No | Yes | A2P clearance notification recorded | A2P clearance notification recorded |
| notification.agent.inactive_72h | system | tenant | No | Yes | Agent inactivity notification recorded | Agent inactivity notification recorded |
| notification.billing.payment_completed | system | tenant | No | Yes | Completed payment notification recorded | Completed payment notification recorded |
| notification.billing.tier_upgraded | system | tenant | No | Yes | Tier upgrade notification recorded | Tier upgrade notification recorded |
| notification.channel.disconnected | system | tenant | No | Yes | Channel disconnection notification recorded | Channel disconnection notification recorded |
| notification.inbox.read | human | tenant | No | Yes | Notification read logged | Notification read recorded in the audit log |
| notification.inbox.read_all | human | tenant | No | Yes | Inbox read logged | Mark all notifications read recorded in the audit log |
| notification.onboarding.stalled | system | tenant | No | Yes | Onboarding stall notification recorded | Onboarding stall notification recorded |
| notification.preference.changed | human | platform | No | Yes | Notification change logged | Notification preference change recorded in the audit log |
| offer.changed | human | tenant | No | Yes | Offer field change logged | Changed offer fields recorded in the audit log |
| offer.draft.saved | human | tenant | No | Yes | Offer draft save logged | Offer draft save recorded in the audit log |
| offer.published | human | tenant | No | Yes | Offer publish logged | Offer publish recorded in the audit log |
| offer.review.cleared | human | tenant | Yes | No | Offer review logged | Offer clearance recorded in the audit log |
| offer.review.rejected | human | tenant | Yes | No | Offer review logged | Offer rejection recorded in the audit log |
| onboarding.a2p_blocked_permanent | system | tenant | No | Yes | Permanent registration block logged | Permanent registration block recorded in the audit log |
| onboarding.a2p_filing_confirmed | human | tenant | No | Yes | Registration filing logged | Registration filing recorded in the audit log |
| onboarding.artifact_confirmed | human | tenant | No | Yes | Consent page confirmation logged | Consent page confirmation recorded in the audit log |
| onboarding.business_profile.saved | human | tenant | No | Yes | Business profile save logged | Business profile save recorded in the audit log |
| onboarding.calendar_authorization.recorded | human | tenant | No | Yes | Calendar authorization logged | Calendar authorization receipt recorded in the audit log |
| onboarding.campaign_content_approved | human | tenant | No | Yes | Campaign content approval logged | Client campaign content approval recorded in the audit log |
| onboarding.content_acknowledged | human | tenant | No | Yes | Content acknowledgement logged | Registration content acknowledgement recorded in the audit log |
| onboarding.content_admin_confirmed | human | tenant | No | Yes | Content confirmation logged | Registration content confirmation recorded in the audit log |
| onboarding.signup_completed | human | tenant | No | Yes | Signup logged | Onboarding signup recorded in the audit log |
| onboarding.signup.repair.already_healthy | human | platform | Yes | No | Signup repair check logged | Already healthy signup check recorded in the audit log |
| onboarding.signup.repair.cannot_resume | human | platform | Yes | No | Signup repair refusal logged | Signup repair refusal recorded in the audit log |
| onboarding.signup.repair.resumed | human | platform | Yes | No | Signup repair logged | Signup repair recorded in the audit log |
| onboarding.step_failed | system | tenant | No | No | Provisioning failure logged | Provisioning failure recorded in the audit log |
| onboarding.step_retried | human | tenant | No | Yes | Retry logged | Provisioning retry recorded in the audit log |
| onboarding.step_unblocked | human | tenant | Yes | Yes | Unblock logged | Provisioning unblock recorded in the audit log |
| platform_export.finished | human | platform | Yes | No | Platform export completion logged | Platform export completion recorded in the audit log |
| platform_export.started | human | platform | Yes | No | Platform export start logged | Platform export start recorded in the audit log |
| platform.conversation_queue.read | human | platform | No | No | Human queue view logged | Cross-tenant human conversation queue view recorded in the audit log |
| platform.provisioning_install.completed | human | platform | No | No | Install logged | Provisioning install recorded in the audit log |
| platform.provisioning_install.declined | system | platform | No | No | Approval decline logged | Provisioning install decline recorded in the audit log |
| platform.provisioning_install.failed | system | platform | No | No | Install failure logged | Provisioning install failure recorded in the audit log |
| platform.provisioning_install.reauthorization_required | system | platform | No | No | Reconnect needed logged | Provisioning reconnection requirement recorded in the audit log |
| provider.rotation.verified | human | platform | No | No | Rotation verification logged | Provider credential rotation recorded in the audit log |
| provisioning.command.undone | human | tenant | Yes | No | Provisioning undo logged | Provisioning command undo recorded in the audit log |
| provisioning.nudge.intent_recorded | human | tenant | Yes | No | Provisioning nudge intent logged | Provisioning nudge intent recorded in the audit log |
| provisioning.owner.reassigned | human | tenant | Yes | No | Provisioning owner reassignment logged | Provisioning owner reassignment recorded in the audit log |
| provisioning.resend.intent_recorded | human | tenant | Yes | No | Provisioning resend intent logged | Provisioning resend intent recorded in the audit log |
| quiet_hours.window.change | human | tenant | No | Yes | Quiet-hours change logged | Quiet-hours change recorded in the audit log |
| referral.code_rejected | system | platform | No | No | Referral refusal logged | Referral refusal recorded in the audit log |
| send.refused.no_consent | system | tenant | No | No | Consent refusal logged | Consent refusal recorded in the audit log |
| send.refused.suppressed | system | tenant | No | No | Suppression refusal logged | Suppression refusal recorded in the audit log |
| send.refused.window_expired | system | tenant | No | No | Window refusal logged | Expired provider-window refusal recorded in the audit log |
| support.thread.assignment.changed | human | tenant | Yes | No | Thread assignment logged | Support thread assignment recorded in the audit log |
| support.thread.status.changed | human | tenant | Yes | No | Thread status change logged | Support thread status change recorded in the audit log |
| suppression.clear.provider | system | tenant | No | No | Provider suppression cleared | Provider-confirmed suppression clear recorded in the audit log |
| suppression.correct | human | tenant | Yes | Yes | Suppression correction logged | Suppression correction recorded in the audit log |
| suppression.insert.keyword | system | tenant | No | Yes | Opt-out logged | Keyword opt-out recorded in the audit log |
| suppression.insert.manual | human | tenant | No | Yes | Suppression logged | Suppression action recorded in the audit log |
| suppression.provider.confirmed | system | tenant | No | No | Provider suppression confirmed | Provider suppression confirmation recorded in the audit log |
| suppression.provider.unconfirmed | system | tenant | No | No | Provider suppression unconfirmed | Provider suppression failure recorded in the audit log |
| suppression.push.failed | system | tenant | No | No | Provider suppression failure logged | Provider suppression failure recorded in the audit log |
| suppression.push.provider | system | tenant | No | No | Provider suppression logged | Provider suppression recorded in the audit log |
| tenant.archived | human | tenant | Yes | No | Archive logged | Client archive recorded in the audit log |
| tenant.billing_contact_changed | human | tenant | No | Yes | Billing contact change logged | Billing contact change recorded in the audit log |
| tenant.command.undone | human | tenant | Yes | No | Undo logged | Client command undo recorded in the audit log |
| tenant.demo_flag.changed | human | platform | Yes | No | Demo flag change logged | Demo flag change recorded in the audit log |
| tenant.internal_note.added | human | tenant | No | No | Internal note logged | Internal client note recorded in the audit log |
| tenant.lifecycle.paused | human | tenant | Yes | No | Pause logged | Client pause recorded in the audit log |
| tenant.lifecycle.resumed | human | tenant | Yes | No | Resume logged | Client resume recorded in the audit log |
| tenant.membership.accepted | human | tenant | No | Yes | Teammate acceptance logged | Teammate acceptance recorded in the audit log |
| tenant.membership.declined | human | tenant | No | Yes | Teammate decline logged | Teammate decline recorded in the audit log |
| tenant.membership.expired | system | tenant | No | Yes | Teammate invitation expiry logged | Teammate invitation expiry recorded in the audit log |
| tenant.membership.invited | human | tenant | No | Yes | Teammate invitation logged | Teammate invitation recorded in the audit log |
| tenant.membership.revoked | human | tenant | No | Yes | Teammate removal logged | Teammate removal recorded in the audit log |
| tenant.membership.switched | human | tenant | No | Yes | Workspace switch logged | Workspace switch recorded in the audit log |
| tenant.onboarding.nudge.intent_recorded | human | tenant | Yes | No | Onboarding nudge intent logged | Onboarding nudge intent recorded in the audit log |
| tenant.ownership.accepted | human | tenant | No | Yes | Ownership transfer logged | Workspace ownership transfer recorded in the audit log |
| tenant.ownership.expired | system | tenant | No | Yes | Ownership offer expiry logged | Workspace ownership offer expiry recorded in the audit log |
| tenant.ownership.offered | human | tenant | No | Yes | Ownership offer logged | Workspace ownership offer recorded in the audit log |
| tenant.ownership.revoked | human | tenant | No | Yes | Ownership offer revocation logged | Workspace ownership offer revocation recorded in the audit log |
| tenant.signup.resend.intent_recorded | human | tenant | Yes | No | Signup resend intent logged | Signup resend intent recorded in the audit log |
| tenant.success_owner.reassigned | human | tenant | Yes | No | Reassignment logged | Success owner reassignment recorded in the audit log |
| tenant.went_live | human | tenant | No | Yes | Go-live logged | Go-live recorded in the audit log |
| test_recipient.registered | human | tenant | No | Yes | Test recipient logged | Verified test recipient recorded in the audit log |
| webhook.receipt.replayed | human | tenant | No | Yes | Replay logged | Stored provider receipt replay recorded in the audit log |
