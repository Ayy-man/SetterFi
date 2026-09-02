-- Add the Phase 13 CAPI worker to durable scheduled-job reporting.
-- This is additive because the existing job-key constraint predates the new cron.

alter table public.job_receipts drop constraint if exists job_receipts_job_key_check;
alter table public.job_receipts add constraint job_receipts_job_key_check check (job_key in (
  'a2p-probe', 'agent-inactivity-sweep', 'appointment-reconcile', 'billing-allowances',
  'billing-cost-rollup', 'capi-events', 'compliance-reconcile', 'contact-deletion-recovery',
  'engine-evals', 'followups', 'ghl-install-reconcile', 'inbound-recovery',
  'notification-deliveries', 'outbound-reconciliation', 'provisioning-run', 'stripe-webhooks',
  'tenant-health-rollup', 'tier-change-reconcile'
));
