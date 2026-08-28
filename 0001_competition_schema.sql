-- ============================================================================
-- BESTSELLER Principles Master — Competition Mode schema
-- ============================================================================
-- Run this once against a fresh Supabase project (SQL Editor, or via the
-- Supabase CLI: `supabase db push`). Safe to re-run only if you drop the
-- objects first — this file does not use IF NOT EXISTS everywhere on purpose,
-- so you notice if you're about to run it twice against the same project.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. contests
-- ----------------------------------------------------------------------------
create table contests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Dhaka',
  start_at timestamptz not null,
  end_at timestamptz not null,
  duration_seconds integer not null check (duration_seconds > 0),
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'live', 'finished')),
  results_published boolean not null default false,
  require_contact boolean not null default false, -- if true, phone/email required at registration
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint end_after_start check (end_at > start_at)
);

create index contests_status_idx on contests (status);

-- ----------------------------------------------------------------------------
-- 2. contest_questions
--    NOTE: official_answer / official_keyword are the secret answer key.
--    No RLS policy below ever grants anon/authenticated SELECT on this table.
--    Only service-role (Edge Functions) can read it.
-- ----------------------------------------------------------------------------
create table contest_questions (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references contests(id) on delete cascade,
  question_number integer not null check (question_number between 1 and 10),
  prompt text not null,             -- e.g. the Bangla keyword shown to participants
  official_answer text not null,    -- e.g. "We Are Honest" (normalized form, secret)
  official_keyword text not null,   -- e.g. "Honest" (also accepted, secret)
  created_at timestamptz not null default now(),
  unique (contest_id, question_number)
);

-- Public-safe view: prompts only, never the answers.
create view contest_prompts as
  select id, contest_id, question_number, prompt
  from contest_questions;

-- ----------------------------------------------------------------------------
-- 3. participants
-- ----------------------------------------------------------------------------
create table participants (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references contests(id) on delete cascade,
  full_name text not null,
  participant_identifier text not null,
  phone text,
  email text,
  registered_at timestamptz not null default now(),
  unique (contest_id, participant_identifier)
);

create index participants_contest_idx on participants (contest_id);

-- ----------------------------------------------------------------------------
-- 4. submissions
--    One row per participant, enforced by the unique constraint on
--    participant_id. submission_seq gives a gapless, monotonic tiebreaker
--    that is more precise than submitted_at alone.
-- ----------------------------------------------------------------------------
create table submissions (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references contests(id) on delete cascade,
  participant_id uuid not null unique references participants(id) on delete cascade,

  answer_1 text, answer_2 text, answer_3 text, answer_4 text, answer_5 text,
  answer_6 text, answer_7 text, answer_8 text, answer_9 text, answer_10 text,

  results jsonb not null,           -- [{ question_number, answer, correct }, ...]
  correct_count integer not null check (correct_count between 0 and 10),
  wrong_count integer not null check (wrong_count between 0 and 10),
  score integer not null,

  started_at timestamptz,           -- client-reported hint only, not authoritative
  submitted_at timestamptz not null default now(),  -- SERVER time — authoritative
  submission_seq bigint generated always as identity,
  duration_seconds integer,

  paste_attempts integer not null default 0,
  copy_attempts integer not null default 0,
  cut_attempts integer not null default 0,
  drop_attempts integer not null default 0,
  tab_switches integer not null default 0,
  visibility_changes integer not null default 0,
  fullscreen_exits integer not null default 0,
  refresh_count integer not null default 0,
  multiple_submit_attempts integer not null default 0,

  integrity_status text not null default 'green'
    check (integrity_status in ('green', 'yellow', 'red')),
  integrity_override text
    check (integrity_override in ('green', 'yellow', 'red') or integrity_override is null),

  created_at timestamptz not null default now()
);

create index submissions_contest_idx on submissions (contest_id);
create index submissions_ranking_idx on submissions (contest_id, correct_count desc, submitted_at asc, submission_seq asc);

-- ----------------------------------------------------------------------------
-- 5. admin_users — allowlist of Supabase Auth users permitted to act as admin
-- ----------------------------------------------------------------------------
create table admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 6. Public results view — only safe, aggregate fields, only once published.
--    No raw answers, no official answers, no integrity data.
-- ----------------------------------------------------------------------------
create view public_results as
  select
    s.contest_id,
    p.full_name,
    s.correct_count,
    s.score,
    s.submitted_at,
    rank() over (
      partition by s.contest_id
      order by s.correct_count desc, s.submitted_at asc, s.submission_seq asc
    ) as rank
  from submissions s
  join participants p on p.id = s.participant_id
  join contests c on c.id = s.contest_id
  where c.results_published = true;
-- NOTE: this view is intentionally left security_invoker = false (the
-- Postgres default), so it can read through the locked-down submissions/
-- participants tables using the view owner's privileges — the same way
-- contest_prompts reads through contest_questions. Its own column list and
-- WHERE clause (results_published = true, no participant_identifier) *is*
-- the security boundary. It is not currently granted to anon/authenticated
-- (see grants below) — participant-facing results are served exclusively
-- through the get-my-result Edge Function, which additionally requires the
-- caller to prove identity via participant_identifier + matching full name
-- before returning anything. This avoids ever exposing the full roster (or
-- the identifiers used as proof-of-identity) to an anonymous visitor. If
-- you want a fully public leaderboard page later, you can safely
-- `grant select on public_results to anon, authenticated;`.

-- ----------------------------------------------------------------------------
-- 7. Admin-facing leaderboard view (requires admin RLS to actually read it)
-- ----------------------------------------------------------------------------
create view admin_leaderboard as
  select
    s.id as submission_id,
    s.contest_id,
    p.id as participant_id,
    p.full_name,
    p.participant_identifier,
    s.correct_count,
    s.wrong_count,
    s.score,
    s.submitted_at,
    s.duration_seconds,
    s.paste_attempts,
    s.copy_attempts,
    s.cut_attempts,
    s.drop_attempts,
    s.tab_switches,
    s.refresh_count,
    coalesce(s.integrity_override, s.integrity_status) as integrity_status,
    rank() over (
      partition by s.contest_id
      order by s.correct_count desc, s.submitted_at asc, s.submission_seq asc
    ) as rank
  from submissions s
  join participants p on p.id = s.participant_id;

-- ----------------------------------------------------------------------------
-- updated_at trigger for contests
-- ----------------------------------------------------------------------------
create function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger contests_set_updated_at
  before update on contests
  for each row execute function set_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table contests enable row level security;
alter table contest_questions enable row level security;
alter table participants enable row level security;
alter table submissions enable row level security;
alter table admin_users enable row level security;

-- contests: safe to read publicly (name/status/timing only — no secrets here).
-- All writes happen only via Edge Functions using the service role key, which
-- bypasses RLS entirely, so no insert/update/delete policy is granted here.
create policy contests_public_read on contests
  for select to anon, authenticated
  using (true);

-- contest_questions: intentionally NO policy for anon/authenticated.
-- The table is readable only by the service role (Edge Functions).
-- Participants see prompts exclusively through the contest_prompts view.

-- participants: no direct client read/write. Registration goes through the
-- register-participant Edge Function so we can enforce contest status and
-- return the participant's own record without exposing the full roster.
-- (No policies created — default-deny for anon/authenticated.)

-- submissions: no direct client read/write at all. All access is via
-- submit-answers (service role) or the public_results / admin_leaderboard
-- views below. (No policies created — default-deny for anon/authenticated.)

-- admin_users: no general access — the one exception is letting a logged-in
-- user check their OWN row (never anyone else's), so the frontend can
-- decide whether to show the admin dashboard or an access-denied screen.
-- Every actual privileged action still re-verifies admin status server-side
-- inside its Edge Function (requireAdmin) — this policy is for UI gating
-- only, never treated as the real security boundary.
create policy admin_self_check on admin_users
  for select to authenticated
  using (user_id = auth.uid());

-- Admin read access to participants (used by the admin dashboard for names
-- alongside the leaderboard, and for participant detail lookups).
create policy admin_select_participants on participants
  for select to authenticated
  using (exists (select 1 from admin_users a where a.user_id = auth.uid()));

-- Admin read access to submissions (drives the live leaderboard + realtime).
create policy admin_select_submissions on submissions
  for select to authenticated
  using (exists (select 1 from admin_users a where a.user_id = auth.uid()));

-- Grants below combine with the RLS policies above to control access.
-- A grant alone does nothing without a matching policy; a policy alone
-- does nothing without a matching grant. Both are required together.
-- that the admin_select_* RLS policies on the underlying tables are what
-- actually decides access — otherwise any authenticated (non-admin) user
-- could read it via the view owner's elevated privileges.
alter view admin_leaderboard set (security_invoker = true);

-- contest_prompts and public_results are deliberately left as regular
-- (security_invoker = false) views — see the comment above public_results.
-- They are the controlled gateway themselves; their column lists and
-- WHERE clauses (not base-table RLS) define what's safe to expose.

grant select on contest_prompts to anon, authenticated;
grant select on contests to anon, authenticated;
grant select on admin_leaderboard to authenticated;
grant select on participants to authenticated;
grant select on submissions to authenticated;
grant select on admin_users to authenticated;
-- public_results is intentionally NOT granted here — see note above.

-- ============================================================================
-- Realtime: allow the admin dashboard to subscribe to new submissions.
-- ============================================================================
alter publication supabase_realtime add table submissions;
