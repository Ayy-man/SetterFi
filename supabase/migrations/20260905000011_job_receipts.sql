-- Durable, platform-only receipts for scheduled work.
--
-- A cron schedule is intent, not evidence. Each invocation creates one receipt before it starts
-- work and finalizes that receipt with the actual terminal outcome and counters.

create table public.job_receipts (
  id uuid primary key default gen_random_uuid(),
  job_key text not null check (job_key in (
    'a2p-probe',
    'appointment-reconcile',
    'billing-allowances',
    'billing-cost-rollup',
    'compliance-reconcile',
    'contact-deletion-recovery',
    'engine-evals',
    'followups',
    'ghl-install-reconcile',
    'inbound-recovery',
    'notification-deliveries',
    'outbound-reconciliation',
    'stripe-webhooks'
  )),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  outcome text check (outcome in ('succeeded', 'failed')),
  error_detail text,
  counters jsonb not null default '{}'::jsonb check (jsonb_typeof(counters) = 'object'),
  constraint job_receipts_terminal_shape_chk check (
    (finished_at is null and outcome is null and error_detail is null)
    or (
      finished_at is not null
      and outcome is not null
      and finished_at >= started_at
      and (outcome = 'failed' or error_detail is null)
    )
  )
);

comment on table public.job_receipts is
  'Service-written terminal receipts for scheduled jobs. A missing receipt means no run is proven.';

create index job_receipts_latest_by_job_idx
  on public.job_receipts (job_key, started_at desc, id desc);

alter table public.job_receipts enable row level security;
alter table public.job_receipts force row level security;

create policy job_receipts_platform_read
  on public.job_receipts for select to authenticated
  using (app.is_platform_operator());

revoke all on table public.job_receipts from public, anon, authenticated;
grant select on table public.job_receipts to authenticated;
grant select, insert, update on table public.job_receipts to service_role;
