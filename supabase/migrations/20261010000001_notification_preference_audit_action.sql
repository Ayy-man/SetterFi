-- A person changing where their own notices arrive is an audited action, so the account panel can
-- carry the "Logged" microcopy over the control that writes it. `audit_log.action` is foreign-keyed
-- to `audit_actions.key`, so the row has to exist here before the handler can record anything.
--
-- Scope is platform rather than tenant: `notification_preferences` is keyed on the user alone and
-- carries no tenant column, so a tenant-scoped row would have to invent an owner for the change.
-- Coach visible, because a coach changes their own notification settings and sees the receipt.
insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('notification.preference.changed', 'human', 'platform', false, true,
   'Notification change logged', 'Notification preference change recorded in the audit log')
on conflict (key) do nothing;
