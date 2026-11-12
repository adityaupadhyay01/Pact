-- PACT storage (migration 1 of 2). Run in the Supabase SQL editor, or with `supabase db push`. Safe to re-run.

-- One row per purchase check. The full session (contract versions, approvals,
-- verified evidence, PayPal order, signed receipt) is stored as JSON.
create table if not exists public.pact_sessions (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.pact_sessions add column if not exists schema_version int not null default 1;
alter table public.pact_sessions add column if not exists expires_at timestamptz;
create index if not exists pact_sessions_expires_at on public.pact_sessions (expires_at);

-- Fixed-window counters for rate limiting and quota guards.
create table if not exists public.pact_usage (
  bucket text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (bucket, window_start)
);

-- Atomically count a hit; returns true when the call is within the limit.
create or replace function public.pact_hit(p_bucket text, p_window timestamptz, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  insert into public.pact_usage (bucket, window_start, count)
  values (p_bucket, p_window, 1)
  on conflict (bucket, window_start) do update set count = public.pact_usage.count + 1
  returning count into n;
  return n <= p_limit;
end;
$$;

-- Only the server (service role key, which bypasses RLS) reads and writes these tables.
-- RLS is on with NO policies, so the anon and authenticated roles can't read or write anything,
-- and the table privileges are revoked as a second layer.
alter table public.pact_sessions enable row level security;
alter table public.pact_usage enable row level security;
revoke all on table public.pact_sessions from anon, authenticated;
revoke all on table public.pact_usage from anon, authenticated;
revoke all on function public.pact_hit(text, timestamptz, int) from public, anon, authenticated;

-- Retention: sessions expire after 7 days. The app deletes expired rows itself (at most hourly,
-- see cleanupExpired in src/lib/store.ts). This function does the same from SQL, for a scheduled job:
--   select cron.schedule('pact-cleanup', '17 * * * *', 'select public.pact_cleanup()');  -- needs pg_cron
create or replace function public.pact_cleanup()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  delete from public.pact_sessions where expires_at < now();
  get diagnostics n = row_count;
  delete from public.pact_usage where window_start < now() - interval '40 days';
  return n;
end;
$$;
revoke all on function public.pact_cleanup() from public, anon, authenticated;
