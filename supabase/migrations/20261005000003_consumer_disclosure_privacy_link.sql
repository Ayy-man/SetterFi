-- The disclosure line's privacy link, gated on the same conditions that decide whether the page it
-- points at will render anything.
--
-- `start_consumer_conversation_session` selected the artifact on two conditions -- `is_current` and
-- `confirmed_at is not null` -- and returned its `privacy_url` unconditionally. The reader for the
-- same rows, `read_hosted_onboarding_artifact`, uses six: it also refuses a placeholder artifact on
-- a non-demo tenant, requires `privacy_body is not null` for the privacy page, and refuses demo
-- placeholder markers outside a demo tenant. `privacy_url` is `not null check (privacy_url ~
-- '^https://')` while `privacy_body` is nullable, so a confirmed current artifact with a URL and no
-- body is a legal row -- and the lead following that link lands on "Privacy policy not published."
--
-- The consumer disclosure is the most externally visible surface in the product, and it is read by
-- someone who did not choose to be here. A link that resolves to a refusal is worse than no link,
-- because the absence of a link is honest about a policy that is not published while a dead link
-- says one is.
--
-- Three decisions, ruled rather than inferred:
--
--   1. Gate the returned URL and return empty otherwise. `consumer-experience.tsx:987` renders the
--      anchor only when the href is non-empty, so empty is already the honest state and needs no
--      component change.
--   2. Do not refuse the session. A lead getting no conversation at all because their coach's
--      privacy body is empty is a worse outcome than a disclosure line without a link, and
--      refusing is a product decision with live-tenant consequences.
--   3. Also refuse a host that provably cannot resolve. This is live today: the one confirmed
--      current artifact in the hosted database carries
--      `privacy_url = https://example.invalid/phase5-demo/privacy`, which satisfies the `^https://`
--      check and renders as a clickable "Privacy policy" that can never load.
--
-- Deliberately unchanged: the artifact requirement itself still raises
-- `CONSUMER_PRIVACY_ARTIFACT_REQUIRED` when no confirmed current artifact exists. That refusal
-- predates this change and gating the link is not a reason to widen or narrow it.

-- ---------------------------------------------------------------------------
-- A host that cannot resolve for anyone
-- ---------------------------------------------------------------------------
-- RFC 2606 reserves `.test`, `.example`, `.invalid` and `.localhost` and the `example.com/net/org`
-- second-level names precisely so they can never be registered. A URL on one of them is a
-- placeholder that survived into production, not a policy someone can read. Kept separate from the
-- artifact conditions because it judges the URL rather than the artifact's state, and because it is
-- the arm most likely to want more entries later.
create or replace function app.disclosure_host_is_reachable(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with parsed as (
    -- Host only: after the scheme, past any userinfo, stopping at port, path, query or fragment.
    select lower(substring(p_url from '^https://(?:[^@/]*@)?([^/:?#]+)')) as host
  )
  select coalesce(
    host is not null
      and host <> ''
      and host <> 'localhost'
      and host !~ '\.(test|example|invalid|localhost)$'
      and host !~ '^(?:.+\.)?example\.(com|net|org)$',
    false
  )
  from parsed;
$$;

comment on function app.disclosure_host_is_reachable(text) is
  'False for RFC 2606 reserved hosts, which can never resolve for anyone, so a placeholder URL is not rendered as a live link on the consumer disclosure.';

-- ---------------------------------------------------------------------------
-- The session start, returning a link only when the page behind it will render
-- ---------------------------------------------------------------------------
--
-- **This also fixes a live defect that has nothing to do with the link, found while testing the
-- one that does.** `returns table (tenant_id uuid, ...)` declares `tenant_id` as an OUT parameter,
-- which is in scope inside the body -- so the three unqualified `where tenant_id = tenant_row.id`
-- clauses raised `column reference "tenant_id" is ambiguous` and the function could not run past
-- its second statement. Every real webchat session start failed; the only path that worked was the
-- unknown-tenant refusal, which returns before reaching them, and that is the only path the
-- existing test covers. The three selects now qualify their columns through a table alias.
create or replace function public.start_consumer_conversation_session(p_tenant_slug text, p_contact_identity_id uuid, p_session_secret_hash text, p_expires_at timestamptz)
returns table (tenant_id uuid, session_id uuid, conversation_id uuid, business_name text, program_name text, privacy_url text)
language plpgsql volatile security definer set search_path = '' as $$
declare tenant_row public.tenants%rowtype; identity_row public.contact_identities%rowtype; offer_row public.offer_layers%rowtype; artifact_row public.onboarding_optin_artifacts%rowtype; conversation_row public.conversations%rowtype; created_session_id uuid; privacy_link text;
begin
  perform app.assert_not_impersonating();
  if p_tenant_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or p_contact_identity_id is null or p_session_secret_hash !~ '^[0-9a-f]{64}$' or p_expires_at is null or p_expires_at <= now() then raise exception 'CONSUMER_SESSION_INPUT_INVALID'; end if;
  select * into tenant_row from public.tenants where slug = p_tenant_slug and status = 'active';
  if tenant_row.id is null then raise exception 'CONSUMER_TENANT_UNAVAILABLE'; end if;
  select * into identity_row from public.contact_identities identity where identity.id = p_contact_identity_id and identity.tenant_id = tenant_row.id for update;
  if identity_row.id is null or identity_row.consent_state not in ('conversation', 'opted_in') then raise exception 'CONSUMER_CONSENT_REQUIRED'; end if;
  select * into offer_row from public.offer_layers offer where offer.tenant_id = tenant_row.id and offer.status = 'published' order by offer.version desc limit 1;
  if offer_row.id is null then raise exception 'CONSUMER_PUBLISHED_OFFER_REQUIRED'; end if;
  select * into artifact_row from public.onboarding_optin_artifacts artifact where artifact.tenant_id = tenant_row.id and artifact.is_current and artifact.confirmed_at is not null;
  if artifact_row.id is null then raise exception 'CONSUMER_PRIVACY_ARTIFACT_REQUIRED'; end if;

  -- The four conditions `read_hosted_onboarding_artifact` adds for `p_page = 'privacy'`, plus the
  -- reachable-host check. Empty rather than null: the caller coalesces to a string and the
  -- component's test is truthiness, so one empty value keeps every layer agreeing on "no link".
  if (not artifact_row.placeholder or tenant_row.is_demo)
     and artifact_row.privacy_body is not null
     and (
       tenant_row.is_demo
       or (
         artifact_row.marketing_language not like '%SETTERFI_DEMO_PLACEHOLDER_%'
         and artifact_row.non_marketing_language not like '%SETTERFI_DEMO_PLACEHOLDER_%'
         and coalesce(artifact_row.terms_body, '') not like '%SETTERFI_DEMO_PLACEHOLDER_%'
         and coalesce(artifact_row.privacy_body, '') not like '%SETTERFI_DEMO_PLACEHOLDER_%'
       )
     )
     and app.disclosure_host_is_reachable(artifact_row.privacy_url)
  then privacy_link := artifact_row.privacy_url;
  else privacy_link := '';
  end if;

  insert into public.conversations (tenant_id, contact_id, channel, disclosure_pending) values (tenant_row.id, identity_row.contact_id, 'webchat', true) returning * into conversation_row;
  insert into public.consumer_conversation_sessions (tenant_id, contact_identity_id, conversation_id, session_secret_hash, expires_at) values (tenant_row.id, identity_row.id, conversation_row.id, p_session_secret_hash, p_expires_at) returning id into created_session_id;
  perform app.write_audit_row('consumer.conversation_started', null, tenant_row.id, 'conversation', conversation_row.id::text, null, jsonb_build_object('channel', 'webchat'));
  return query select tenant_row.id, created_session_id, conversation_row.id, tenant_row.name, coalesce(offer_row.program_name, ''), privacy_link;
end; $$;
