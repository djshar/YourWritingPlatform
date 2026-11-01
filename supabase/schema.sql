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
