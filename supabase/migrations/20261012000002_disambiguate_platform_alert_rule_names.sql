-- Give three platform-scoped alert rules names that are not their tenant-scoped twin's name.
--
-- `alert_rules` is unique on (event_key, scope), and the seeds pair most events: one platform-scoped
-- rule addressed to '{owner,admin}' and one tenant-scoped rule addressed to '{coach}'. They are
-- genuinely different rules with different audiences, different suppressibility and their own
-- `notification_preferences` rows, so the console lists both, and the seed convention is that each
-- half is named from the vantage of the person who receives it:
--
--   conversation.tripwire_escalated   platform 'Tripwire escalation'
--                                     tenant   'Conversation escalated'
--   onboarding.a2p_blocked_permanent  platform 'SMS registration permanently blocked'
--                                     tenant   'SMS registration permanently unavailable'
--
-- Three pairs were seeded with one name across both scopes. On the console notification matrix,
-- which is unfiltered by scope because an owner administers both, that renders as the same
-- notification listed twice with two independent sets of checkboxes and nothing on screen saying
-- which is which. The product owner read it as duplicated rows, and the rows are not duplicates:
-- the names are wrong.
--
-- Only the platform half is renamed, so the coach-facing name every tenant already sees does not
-- move. The rename is guarded on the current value, so re-running this after the client's team has
-- edited a name by hand leaves their edit alone rather than reverting it.
--
-- The account sheet also carries a general guard for this: a name that appears more than once in
-- the set it is drawing takes a scope qualifier beside it. That covers any future collision in a
-- table the client's own team edits, and after this migration the guard finds nothing to qualify.

update public.alert_rules
set name = 'Coach setup stalled on a provider',
    updated_at = now()
where event_key = 'onboarding.stalled_external'
  and scope = 'platform'
  and name = 'Setup waiting on provider';

update public.alert_rules
set name = 'Coach outbound send needs reconciliation',
    updated_at = now()
where event_key = 'conversation.outbound_send_unconfirmed'
  and scope = 'platform'
  and name = 'Outbound send needs reconciliation';

update public.alert_rules
set name = 'Coach suppression unconfirmed by a provider',
    updated_at = now()
where event_key = 'suppression.provider_unconfirmed'
  and scope = 'platform'
  and name = 'Provider suppression unconfirmed';
