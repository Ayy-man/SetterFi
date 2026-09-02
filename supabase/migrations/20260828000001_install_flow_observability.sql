-- Install flow observability: five new audit actions, and the actor rule that was rejecting
-- every successful install.
--
-- No new table. public.audit_log already carries a step, an outcome and an error code without a
-- new column - the code goes in `reason`, which /admin/audit already renders, and the structured
-- context goes in payload.after. It is already append-only under FORCE RLS with platform-operator
-- read and service-role insert, so a parallel events table would be a second thing to secure for
-- no column we do not already have.

-- ---------------------------------------------------------------------------
-- 1. The five install-flow outcomes that had nowhere to land
-- ---------------------------------------------------------------------------

-- One start_refused key covers both apps on purpose: the app lives in target_id exactly as
-- channel.messaging_install.started already does, and a refusal whose body never parsed has no
-- app to name.
insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('channel.messaging_install.start_refused', 'human', 'platform', false, false,
    'Install refusal logged', 'Messaging install refusal recorded in the audit log'),
  ('channel.messaging_install.declined', 'system', 'tenant', false, true,
    'Approval decline logged', 'Messaging install decline recorded in the audit log'),
  ('channel.messaging_install.failed', 'system', 'tenant', false, true,
    'Install failure logged', 'Messaging install failure recorded in the audit log'),
  ('platform.provisioning_install.declined', 'system', 'platform', false, false,
    'Approval decline logged', 'Provisioning install decline recorded in the audit log'),
  ('platform.provisioning_install.failed', 'system', 'platform', false, false,
    'Install failure logged', 'Provisioning install failure recorded in the audit log');

-- ---------------------------------------------------------------------------
-- 2. The correction
-- ---------------------------------------------------------------------------

-- Both completion keys were registered 'system' while both callbacks insert them with the actor
-- the state row recorded. app.enforce_audit_insert raises AUDIT_SYSTEM_ACTOR_FORBIDDEN for that,
-- so the insert threw, complete() rejected, and the route redirected ?messaging=error on an
-- install whose credentials had been persisted one statement earlier. The actor is the most useful
-- column on the attempt, so the registration moves to match the write rather than the reverse.
update public.audit_actions
set actor_kind = 'human'
where key in (
  'channel.messaging_install.completed',
  'platform.provisioning_install.completed'
);
