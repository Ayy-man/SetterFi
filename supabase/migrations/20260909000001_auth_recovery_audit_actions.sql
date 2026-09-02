-- Recovery request mail is anonymous by design, so it is a system event. Completion and sign-out
-- carry the recovered user's id; none of these rows stores an email address or reset credential.
insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  (
    'auth.password_reset.requested', 'system', 'platform', false, false,
    'Password reset request logged', 'Password reset request recorded in the audit log'
  ),
  (
    'auth.email_verification.requested', 'system', 'platform', false, false,
    'Verification email request logged', 'Verification email request recorded in the audit log'
  ),
  (
    'auth.password_reset.completed', 'human', 'platform', false, false,
    'Password reset logged', 'Password reset completion recorded in the audit log'
  ),
  (
    'auth.signed_out', 'human', 'platform', false, false,
    'Sign-out logged', 'Sign-out recorded in the audit log'
  );
