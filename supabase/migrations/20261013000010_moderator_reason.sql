-- The coach-held receipt exposes a short moderator explanation without exposing the trace's
-- prompt material, allowlists or model configuration. It is immutable with the rest of a trace.
alter table public.message_traces
  add column moderator_reason text;
