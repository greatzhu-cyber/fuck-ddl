create table public.cloud_state (
  user_id uuid not null references auth.users (id) on delete cascade,
  state_key text not null check (state_key ~ '^fuck-ddl:v1:[a-z0-9-]+$'),
  encoded_value text not null check (length(encoded_value) between 1 and 2097152),
  version bigint not null default 1 check (version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, state_key)
);

comment on table public.cloud_state is
  'Staging cloud mirror for versioned local business state; never stores auth or third-party sessions.';

create index cloud_state_user_updated_idx
  on public.cloud_state (user_id, updated_at desc);

create trigger cloud_state_touch before update on public.cloud_state
for each row execute function public.touch_versioned_row();

alter table public.cloud_state enable row level security;

create policy cloud_state_owner_all on public.cloud_state for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.cloud_state to authenticated;
