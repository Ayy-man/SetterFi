# Alert rule registry

Generated from the migrated `alert_rules` table in event-and-scope order. Destinations are
intent; provider delivery still requires a persisted attempt and its destination-specific receipt.

| Event | Scope | Name | Category | Audience | Default destinations | Preference | Default state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| agent.inactive_72h | tenant | Agent inactive 72h | agent | coach, success_owner | bell | Optional | Enabled |
| appointment.booked | tenant | Appointment booked | booking | coach | bell, email | Optional | Enabled |
| appointment.canceled | tenant | Appointment canceled | booking | coach | bell, email | Optional | Enabled |
| appointment.rescheduled | tenant | Appointment rescheduled | booking | coach | bell | Optional | Enabled |
| billing.account_overdue | tenant | Account overdue | billing | coach, billing_contact | bell, email | Required | Enabled |
| billing.account_suspended | tenant | Account suspended | billing | coach, billing_contact | bell, email | Required | Enabled |
| billing.allowance_crossed | tenant | Allowance crossed | billing | coach, billing_contact | bell, email | Required | Enabled |
| billing.allowance_warning | tenant | Allowance warning | billing | coach, billing_contact | bell, email | Required | Enabled |
| billing.payment_completed | tenant | Payment completed | billing | coach, billing_contact | bell | Optional | Enabled |
| billing.payment_failed | tenant | Payment failed | billing | coach, billing_contact | bell, email | Required | Enabled |
| billing.tier_upgraded | tenant | Client upgraded to next tier | billing | coach, billing_contact | bell | Optional | Enabled |
| brain.no_published_snapshot | platform | No published Brain snapshot | brain | owner, admin | bell | Required | Enabled |
| brain.publish_failed | platform | Brain publish failed | brain | owner, admin | bell | Required | Enabled |
| calendar.connection_unhealthy | tenant | Calendar needs attention | booking | coach | bell, email | Optional | Enabled |
| channel.disconnected | tenant | Channel disconnected | channel | coach, success_owner | bell | Optional | Enabled |
| contact.deleted | tenant | Contact deleted | compliance | coach | bell | Optional | Enabled |
| conversation.channel_continuation_unavailable | tenant | Channel continuation unavailable | conversation | coach | bell | Optional | Disabled |
| conversation.needs_human | tenant | Conversation needs a person | conversation | coach | bell | Optional | Enabled |
| conversation.needs_human.unclaimed_24h | tenant | Conversation unclaimed for 24 hours | conversation | coach, success_owner | bell, email | Optional | Enabled |
| conversation.needs_human.unclaimed_4h | tenant | Conversation unclaimed for 4 hours | conversation | coach | bell | Optional | Enabled |
| conversation.outbound_send_unconfirmed | platform | Coach outbound send needs reconciliation | conversation | owner, admin | bell | Required | Enabled |
| conversation.outbound_send_unconfirmed | tenant | Outbound send needs reconciliation | conversation | coach, success_owner | bell | Required | Enabled |
| conversation.tripwire_escalated | platform | Tripwire escalation | safety | owner, admin | bell | Required | Enabled |
| conversation.tripwire_escalated | tenant | Conversation escalated | safety | coach | bell | Optional | Enabled |
| message_template.rejected | tenant | Message template rejected | channel | coach, success_owner | bell, email | Optional | Enabled |
| onboarding.a2p_blocked_permanent | platform | SMS registration permanently blocked | onboarding | owner, admin | bell, email | Required | Enabled |
| onboarding.a2p_blocked_permanent | tenant | SMS registration permanently unavailable | onboarding | coach, success_owner | bell, email | Required | Enabled |
| onboarding.a2p_cleared | tenant | A2P cleared | onboarding | coach, success_owner | bell | Optional | Enabled |
| onboarding.paying_not_live | tenant | Paying account is not live | onboarding | success_owner | bell | Required | Enabled |
| onboarding.stalled_coach | tenant | Setup waiting on coach | onboarding | coach | bell | Optional | Enabled |
| onboarding.stalled_external | platform | Coach setup stalled on a provider | onboarding | owner, admin | bell | Required | Enabled |
| onboarding.stalled_external | tenant | Setup waiting on provider | onboarding | coach, success_owner | bell | Optional | Enabled |
| onboarding.stalled_system | platform | Setup needs platform action | onboarding | owner, admin | bell | Required | Enabled |
| onboarding.stalled | tenant | Onboarding stalled | onboarding | coach, success_owner | bell | Optional | Enabled |
| send.refused.window_expired | tenant | Message window expired | channel | coach | bell | Optional | Enabled |
| suppression.provider_unconfirmed | platform | Coach suppression unconfirmed by a provider | compliance | owner, admin | bell | Required | Enabled |
| suppression.provider_unconfirmed | tenant | Provider suppression unconfirmed | compliance | coach, success_owner | bell, email | Optional | Enabled |
