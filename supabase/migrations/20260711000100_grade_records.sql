create table public.grade_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('pintia', 'zju')),
  source_id text not null check (length(trim(source_id)) between 1 and 500),
  course_id text,
  course_name text,
  title text not null check (length(trim(title)) between 1 and 1_000),
  score numeric(12, 3) check (score is null or score >= 0),
  max_score numeric(12, 3) check (max_score is null or max_score > 0),
  status text not null check (status in ('published', 'unpublished', 'missed', 'unknown')),
  rank_text text,
  source_url text,
  deadline_at timestamptz,
  graded_at timestamptz,
  source_synced_at timestamptz not null,
  source_state jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, source_id),
  constraint grade_records_score_bounds check (
    score is null or max_score is null or score <= max_score
  )
);

comment on table public.grade_records is
  'Read-only outcome mirror from PTA and ZJU. Unpublished grades remain null and are never coerced to zero.';

create index grade_records_user_deadline_idx
  on public.grade_records (user_id, deadline_at desc);
create index grade_records_user_status_idx
  on public.grade_records (user_id, status, source);

create trigger grade_records_touch before update on public.grade_records
for each row execute function public.touch_versioned_row();

alter table public.grade_records enable row level security;

create policy grade_records_owner_all on public.grade_records for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.grade_records to authenticated;
