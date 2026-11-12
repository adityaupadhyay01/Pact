-- PACT retention: delete expired sessions on a schedule, inside the database.
--
-- Sessions expire 7 days after they are created (pact_sessions.expires_at). Expired sessions
-- can't be opened (the app checks expires_at on every read), and are physically deleted by:
--   1. this pg_cron job, every hour, when pg_cron is available (Supabase: Database > Extensions > pg_cron), and
--   2. the app itself, at most once an hour per server instance while the app is in use (cleanupExpired).
-- Only rows whose expires_at is already in the past are deleted, so active sessions are never touched,
-- and running the cleanup twice is harmless.
--
-- Safe to re-run: the job is replaced, not duplicated.

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'pact-retention';
  perform cron.schedule('pact-retention', '17 * * * *', 'select public.pact_cleanup()');
end
$$;

-- Check it is scheduled:   select jobname, schedule, active from cron.job where jobname = 'pact-retention';
-- See recent runs:         select status, return_message, start_time from cron.job_run_details
--                          where jobid = (select jobid from cron.job where jobname = 'pact-retention')
--                          order by start_time desc limit 5;
