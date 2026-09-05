-- A missing scheduled-job driver is a deployment state, not a failed invocation.

alter table public.job_receipts
  drop constraint if exists job_receipts_outcome_check;

alter table public.job_receipts
  add constraint job_receipts_outcome_check
  check (outcome in ('succeeded', 'failed', 'skipped'));

alter table public.job_receipts
  drop constraint if exists job_receipts_terminal_shape_chk;

alter table public.job_receipts
  add constraint job_receipts_terminal_shape_chk check (
    (finished_at is null and outcome is null and error_detail is null)
    or (
      finished_at is not null
      and outcome is not null
      and finished_at >= started_at
      and (
        (outcome = 'succeeded' and error_detail is null)
        or (outcome in ('failed', 'skipped') and nullif(btrim(error_detail), '') is not null)
      )
    )
  );
