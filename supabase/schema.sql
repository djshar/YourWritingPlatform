create table if not exists public.user_workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  workspace jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.user_workspaces enable row level security;

revoke all on public.user_workspaces from anon, authenticated;
grant select, insert, update on public.user_workspaces to authenticated;

drop policy if exists "Users can read their own workspace" on public.user_workspaces;
create policy "Users can read their own workspace"
  on public.user_workspaces for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own workspace" on public.user_workspaces;
create policy "Users can create their own workspace"
  on public.user_workspaces for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own workspace" on public.user_workspaces;
create policy "Users can update their own workspace"
  on public.user_workspaces for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'book-covers',
  'book-covers',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can view their own book covers" on storage.objects;
create policy "Users can view their own book covers"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'book-covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can upload their own book covers" on storage.objects;
create policy "Users can upload their own book covers"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'book-covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can update their own book covers" on storage.objects;
create policy "Users can update their own book covers"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'book-covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'book-covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their own book covers" on storage.objects;
create policy "Users can delete their own book covers"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'book-covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create extension if not exists pgcrypto;

create table if not exists public.user_daily_goal_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_date date not null,
  goal_type text not null check (goal_type in ('words', 'minutes')),
  goal_target integer not null check (goal_target > 0),
  achieved_amount double precision not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, goal_date, goal_type, goal_target)
);

alter table public.user_daily_goal_history enable row level security;

revoke all on public.user_daily_goal_history from anon, authenticated;
grant select, insert, update on public.user_daily_goal_history to authenticated;

drop policy if exists "Users can read their own daily goal history" on public.user_daily_goal_history;
create policy "Users can read their own daily goal history"
  on public.user_daily_goal_history for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own daily goal history" on public.user_daily_goal_history;
create policy "Users can insert their own daily goal history"
  on public.user_daily_goal_history for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own daily goal history" on public.user_daily_goal_history;
create policy "Users can update their own daily goal history"
  on public.user_daily_goal_history for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create index if not exists user_daily_goal_history_user_date_idx
  on public.user_daily_goal_history (user_id, goal_date desc);

create index if not exists user_daily_goal_history_goal_type_idx
  on public.user_daily_goal_history (user_id, goal_type, goal_date desc);
