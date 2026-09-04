-- Demo Meta connect path: marks a demo tenant's Meta connection the same way every other
-- tenant-scoped table already marks synthetic rows, so the coach console's existing "is this
-- data real" reads (contacts, conversations, messages, webhook_events all carry is_test) can be
-- extended to channel_connections without inventing a second vocabulary for the same fact.
--
-- channel_connections had no is_test column through phase 4 (20260820000001_phase4_channels.sql)
-- because every connection was, until now, backed by a real OAuth round trip. The demo Meta
-- connect path (src/lib/integrations/meta-oauth.ts, createDemoMockMetaOAuthService) is the first
-- writer of a connection that is not.

set search_path = public, extensions;

alter table public.channel_connections
  add column is_test boolean not null default false;

create index channel_connections_tenant_test_idx
  on public.channel_connections (tenant_id, is_test);
