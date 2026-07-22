create extension if not exists pgcrypto;

create table public.github_allowlist (
  github_user_id bigint primary key check (github_user_id > 0),
  github_login text,
  enabled boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.github_allowlist is
  'Private signup allowlist keyed by immutable GitHub numeric user ID.';

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  github_user_id bigint not null unique check (github_user_id > 0),
  github_login text,
  avatar_url text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  description text,
  target_date date,
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  progress smallint not null default 0 check (progress between 0 and 100),
  version bigint not null default 1 check (version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  source text not null default 'manual' check (source in ('manual', 'pintia', 'zju')),
  source_id text,
  source_url text,
  color text,
  archived_at timestamptz,
  version bigint not null default 1 check (version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique nulls not distinct (user_id, source, source_id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid,
  project_id uuid,
  title text not null check (length(trim(title)) between 1 and 500),
  notes text,
  status text not null default 'open' check (status in ('open', 'completed', 'abandoned')),
  deadline_at timestamptz not null,
  progress smallint not null default 0 check (progress between 0 and 100),
  importance text not null default 'medium' check (importance in ('low', 'medium', 'high', 'critical')),
  estimate_minutes integer check (estimate_minutes is null or estimate_minutes >= 0),
  pinned boolean not null default false,
  source text not null default 'manual' check (source in ('manual', 'pintia', 'zju')),
  source_id text,
  source_url text,
  source_state jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  version bigint not null default 1 check (version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique nulls not distinct (user_id, source, source_id),
  constraint tasks_goal_owner_fk foreign key (user_id, goal_id)
    references public.goals (user_id, id) on delete restrict,
  constraint tasks_project_owner_fk foreign key (user_id, project_id)
    references public.projects (user_id, id) on delete restrict
);

create table public.subtasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null,
  title text not null check (length(trim(title)) between 1 and 500),
  completed boolean not null default false,
  weight numeric(7, 3) not null default 1 check (weight > 0),
  position integer not null default 0,
  version bigint not null default 1 check (version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  constraint subtasks_task_owner_fk foreign key (user_id, task_id)
    references public.tasks (user_id, id) on delete cascade
);

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid,
  started_at timestamptz not null,
  ended_at timestamptz,
  mode text not null check (mode in ('25+5', '50+10', 'free', 'manual')),
  manual_entry boolean not null default false,
  note text,
  version bigint not null default 1 check (version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_entries_order_check check (ended_at is null or ended_at >= started_at),
  constraint time_entries_task_owner_fk foreign key (user_id, task_id)
    references public.tasks (user_id, id) on delete restrict
);

create table public.task_versions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null,
  task_version bigint not null check (task_version > 0),
  operation_id uuid,
  changed_fields text[] not null default '{}',
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  constraint task_versions_task_owner_fk foreign key (user_id, task_id)
    references public.tasks (user_id, id) on delete cascade
);

create table public.integration_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('pintia', 'zju')),
  external_user_label text,
  connection_state text not null default 'disconnected'
    check (connection_state in ('disconnected', 'connected', 'expired', 'error')),
  last_success_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source)
);

comment on table public.integration_accounts is
  'Metadata only. Third-party passwords, cookies and access tokens remain on the Windows device.';

create table public.sync_cursors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('pintia', 'zju', 'cloud')),
  scope text not null default 'default',
  cursor_value text,
  last_success_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, source, scope)
);

create table public.operation_receipts (
  operation_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  applied_at timestamptz not null default now(),
  result_version bigint
);

create index goals_user_updated_idx on public.goals (user_id, updated_at desc);
create index projects_user_updated_idx on public.projects (user_id, updated_at desc);
create index tasks_user_deadline_idx on public.tasks (user_id, deadline_at)
  where deleted_at is null and status = 'open';
create index tasks_user_updated_idx on public.tasks (user_id, updated_at desc);
create index subtasks_user_task_idx on public.subtasks (user_id, task_id, position);
create index time_entries_user_started_idx on public.time_entries (user_id, started_at desc);
create index task_versions_user_task_idx on public.task_versions (user_id, task_id, task_version desc);
create index operation_receipts_user_applied_idx on public.operation_receipts (user_id, applied_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.touch_versioned_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version = old.version + 1;
  new.updated_at = now();
  return new;
end;
$$;

create trigger github_allowlist_touch before update on public.github_allowlist
for each row execute function public.touch_updated_at();
create trigger profiles_touch before update on public.profiles
for each row execute function public.touch_updated_at();
create trigger goals_touch before update on public.goals
for each row execute function public.touch_versioned_row();
create trigger projects_touch before update on public.projects
for each row execute function public.touch_versioned_row();
create trigger tasks_touch before update on public.tasks
for each row execute function public.touch_versioned_row();
create trigger subtasks_touch before update on public.subtasks
for each row execute function public.touch_versioned_row();
create trigger time_entries_touch before update on public.time_entries
for each row execute function public.touch_versioned_row();
create trigger integration_accounts_touch before update on public.integration_accounts
for each row execute function public.touch_updated_at();
create trigger sync_cursors_touch before update on public.sync_cursors
for each row execute function public.touch_updated_at();

create or replace function public.hook_restrict_github_signup(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  provider text;
  github_id_text text;
  github_id bigint;
begin
  provider := event -> 'user' -> 'app_metadata' ->> 'provider';
  github_id_text := coalesce(
    event -> 'user' -> 'user_metadata' ->> 'provider_id',
    event -> 'user' -> 'user_metadata' ->> 'sub',
    event -> 'user' -> 'identities' -> 0 ->> 'id',
    event -> 'user' -> 'identities' -> 0 -> 'identity_data' ->> 'sub'
  );

  if provider is distinct from 'github' or github_id_text is null or github_id_text !~ '^[0-9]+$' then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'GitHub sign-in is required.')
    );
  end if;

  github_id := github_id_text::bigint;
  if not exists (
    select 1 from public.github_allowlist
    where github_user_id = github_id and enabled
  ) then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'This GitHub account is not invited.')
    );
  end if;

  return '{}'::jsonb;
end;
$$;

grant execute on function public.hook_restrict_github_signup(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_restrict_github_signup(jsonb) from anon, authenticated, public;

alter table public.github_allowlist enable row level security;
alter table public.profiles enable row level security;
alter table public.goals enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.subtasks enable row level security;
alter table public.time_entries enable row level security;
alter table public.task_versions enable row level security;
alter table public.integration_accounts enable row level security;
alter table public.sync_cursors enable row level security;
alter table public.operation_receipts enable row level security;

create policy profiles_owner_all on public.profiles for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy goals_owner_all on public.goals for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy projects_owner_all on public.projects for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy tasks_owner_all on public.tasks for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy subtasks_owner_all on public.subtasks for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy time_entries_owner_all on public.time_entries for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy task_versions_owner_all on public.task_versions for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy integration_accounts_owner_all on public.integration_accounts for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy sync_cursors_owner_all on public.sync_cursors for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy operation_receipts_owner_all on public.operation_receipts for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

revoke all on public.github_allowlist from anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.goals to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert, update, delete on public.subtasks to authenticated;
grant select, insert, update, delete on public.time_entries to authenticated;
grant select, insert, update, delete on public.task_versions to authenticated;
grant select, insert, update, delete on public.integration_accounts to authenticated;
grant select, insert, update, delete on public.sync_cursors to authenticated;
grant select, insert, update, delete on public.operation_receipts to authenticated;
