-- Ghostfill 0008 — close the function-execute hole.
--
-- Postgres grants EXECUTE on every new function to PUBLIC by default.
-- `revoke ... from anon, authenticated` does NOT remove that grant, so the
-- functions stayed callable by anyone holding the anon key via
-- /rest/v1/rpc/<name>. `record_order_fill` in particular would have let a
-- client mint itself a filled order at any price it liked — the whole
-- server-authoritative model, bypassed by one POST.
--
-- The fix is to revoke from PUBLIC and re-grant only to service_role, which
-- only an Edge Function ever holds.

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'record_order_fill', 'mark_positions', 'ensure_profile',
         'check_rate_limit', 'compute_calibration', 'calibration_bins',
         'calibration_by_category', 'check_ledger_integrity', 'generate_handle'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end $$;

-- Default-privilege guard so a function added later does not reopen the hole.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;

-- Extensions do not belong in the API schema.
create schema if not exists extensions;
drop index if exists public.markets_question_trgm;
alter extension pg_trgm set schema extensions;
create index if not exists markets_question_trgm
  on public.markets using gin (question extensions.gin_trgm_ops);
