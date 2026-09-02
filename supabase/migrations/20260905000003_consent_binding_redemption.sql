-- Consent links are issued for one known identity and redeemed once. The signed token prevents
-- tampering; this row and the locked RPC prevent a copied token from recording multiple receipts.

create table public.consent_binding_redemptions (
  form_submission_id text primary key
    check (nullif(btrim(form_submission_id), '') is not null and char_length(form_submission_id) <= 200),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  artifact_id uuid not null references public.onboarding_optin_artifacts(id) on delete cascade,
  contact_identity_id uuid not null references public.contact_identities(id) on delete cascade,
  issued_by uuid not null references public.users(id) on delete restrict,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  consent_audit_id bigint references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint consent_binding_redemption_shape_chk check (
    (redeemed_at is null and consent_audit_id is null)
    or (redeemed_at is not null and consent_audit_id is not null)
  ),
  constraint consent_binding_expiry_chk check (expires_at > created_at)
);

create index consent_binding_redemptions_expiry_idx
  on public.consent_binding_redemptions (expires_at)
  where redeemed_at is null;

alter table public.consent_binding_redemptions enable row level security;
alter table public.consent_binding_redemptions force row level security;
revoke all on public.consent_binding_redemptions from anon, authenticated;
grant select, insert, update on public.consent_binding_redemptions to service_role;

create or replace function public.redeem_web_form_consent(
  p_tenant_id uuid,
  p_artifact_id uuid,
  p_contact_identity_id uuid,
  p_rendered_language text,
  p_page_url text,
  p_submitted_at timestamptz,
  p_purposes text[],
  p_evidence jsonb,
  p_form_submission_id text,
  p_expected_tenant_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  binding_row public.consent_binding_redemptions%rowtype;
  artifact_tenant uuid;
  identity_tenant uuid;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_expected_tenant(p_expected_tenant_id, p_tenant_id, 'web_form_consent');
  if nullif(btrim(p_form_submission_id), '') is null
    or p_evidence ->> 'formSubmissionId' is distinct from p_form_submission_id then
    raise exception 'CONSENT_BINDING_SUBMISSION_MISMATCH';
  end if;

  select * into binding_row
  from public.consent_binding_redemptions
  where form_submission_id = p_form_submission_id
  for update;
  if binding_row.form_submission_id is null then raise exception 'CONSENT_BINDING_NOT_FOUND'; end if;
  if binding_row.tenant_id <> p_tenant_id
    or binding_row.artifact_id <> p_artifact_id
    or binding_row.contact_identity_id <> p_contact_identity_id then
    raise exception 'CONSENT_BINDING_SCOPE_MISMATCH';
  end if;
  if binding_row.redeemed_at is not null then raise exception 'CONSENT_BINDING_ALREADY_REDEEMED'; end if;
  if binding_row.expires_at <= now() or p_submitted_at > binding_row.expires_at then
    raise exception 'CONSENT_BINDING_EXPIRED';
  end if;

  select tenant_id into artifact_tenant
  from public.onboarding_optin_artifacts where id = p_artifact_id;
  select tenant_id into identity_tenant
  from public.contact_identities where id = p_contact_identity_id;
  if artifact_tenant is distinct from p_tenant_id or identity_tenant is distinct from p_tenant_id then
    raise exception 'CONSENT_BINDING_SCOPE_MISMATCH';
  end if;

  logged_id := public.record_web_form_consent(
    p_tenant_id,
    p_contact_identity_id,
    p_rendered_language,
    p_page_url,
    p_submitted_at,
    p_purposes,
    p_evidence,
    p_expected_tenant_id
  );
  update public.consent_binding_redemptions
  set redeemed_at = now(), consent_audit_id = logged_id
  where form_submission_id = p_form_submission_id;
  return logged_id;
end;
$$;

revoke all on function public.redeem_web_form_consent(
  uuid, uuid, uuid, text, text, timestamptz, text[], jsonb, text, uuid
) from public, anon, authenticated;
grant execute on function public.redeem_web_form_consent(
  uuid, uuid, uuid, text, text, timestamptz, text[], jsonb, text, uuid
) to service_role;

comment on function public.redeem_web_form_consent(
  uuid, uuid, uuid, text, text, timestamptz, text[], jsonb, text, uuid
) is 'Atomically consumes one reserved consent binding and records its web-form evidence once.';
