-- Server-streamed exports persist both completion dimensions so a finished audit row can be
-- distinguished from a start-only row after a browser cancellation or network truncation.
create function public.finish_export(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_started_audit_id bigint,
  p_resource text,
  p_row_count bigint,
  p_byte_count bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_not_impersonating();
  if p_row_count < 0 then raise exception 'EXPORT_ROW_COUNT_INVALID'; end if;
  if p_byte_count < 0 then raise exception 'EXPORT_BYTE_COUNT_INVALID'; end if;
  if not exists (
    select 1
    from public.audit_log
    where id = p_started_audit_id
      and action = 'export.started'
      and tenant_id = p_expected_tenant
      and actor_id = p_actor_id
      and target_type = 'export'
      and target_id = p_resource
  ) then
    raise exception 'EXPORT_START_NOT_FOUND';
  end if;
  return app.write_audit_row(
    'export.finished', p_actor_id, p_expected_tenant, 'export', p_resource,
    null, jsonb_build_object(
      'started_audit_id', p_started_audit_id,
      'row_count', p_row_count,
      'byte_count', p_byte_count
    )
  );
end;
$$;

revoke execute on function public.finish_export(uuid, uuid, bigint, text, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.finish_export(uuid, uuid, bigint, text, bigint, bigint)
  to service_role;
