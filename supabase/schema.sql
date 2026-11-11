-- PACT session store. Run once in the Supabase SQL editor.
create table if not exists public.pact_sessions (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Only the server (service role key) reads and writes this table.
alter table public.pact_sessions enable row level security;
