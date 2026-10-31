-- Spoonbook database setup.
-- Paste this whole file into Supabase → SQL Editor → New query, then press Run. Safe to run more than once.

-- A household is one shared cookbook. People join it with a short code.
create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our cookbook',
  join_code text not null unique default upper(substr(md5(random()::text), 1, 6)),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default '',
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- Each recipe is one row; the recipe itself is kept as JSON so new fields need no database change.
create table if not exists public.recipes (
  household_id uuid not null references public.households(id) on delete cascade,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (household_id, id)
);

-- The shopping list and the meal plan: one row each per household ('shopping', 'plan').
create table if not exists public.lists (
  household_id uuid not null references public.households(id) on delete cascade,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (household_id, id)
);

-- Who belongs where. security definer so policies can call it without recursion.
create or replace function public.is_member(hh uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where household_id = hh and user_id = auth.uid());
$$;

alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.recipes enable row level security;
alter table public.lists enable row level security;

drop policy if exists "members read household" on public.households;
create policy "members read household" on public.households for select using (public.is_member(id));
drop policy if exists "members rename household" on public.households;
create policy "members rename household" on public.households for update using (public.is_member(id));

drop policy if exists "members see each other" on public.members;
create policy "members see each other" on public.members for select using (public.is_member(household_id));
drop policy if exists "change own name" on public.members;
create policy "change own name" on public.members for update using (user_id = auth.uid());
drop policy if exists "leave household" on public.members;
create policy "leave household" on public.members for delete using (user_id = auth.uid());

drop policy if exists "members use recipes" on public.recipes;
create policy "members use recipes" on public.recipes for all using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists "members use lists" on public.lists;
create policy "members use lists" on public.lists for all using (public.is_member(household_id)) with check (public.is_member(household_id));

-- Start a new cookbook and join it.
create or replace function public.create_household(cookbook_name text, my_name text) returns public.households
language plpgsql security definer set search_path = public as $$
declare h public.households;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.households (name, created_by) values (coalesce(nullif(trim(cookbook_name), ''), 'Our cookbook'), auth.uid()) returning * into h;
  insert into public.members (household_id, user_id, display_name) values (h.id, auth.uid(), coalesce(trim(my_name), ''));
  return h;
end $$;

-- Join someone else's cookbook with their code.
create or replace function public.join_household(code text, my_name text) returns public.households
language plpgsql security definer set search_path = public as $$
declare h public.households;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into h from public.households where join_code = upper(trim(code));
  if h.id is null then raise exception 'No cookbook has that code'; end if;
  insert into public.members (household_id, user_id, display_name) values (h.id, auth.uid(), coalesce(trim(my_name), ''))
    on conflict (household_id, user_id) do update set display_name = excluded.display_name;
  return h;
end $$;

grant execute on function public.create_household(text, text) to authenticated;
grant execute on function public.join_household(text, text) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;

-- Live updates between phones.
do $$ begin
  begin alter publication supabase_realtime add table public.recipes; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.lists; exception when duplicate_object then null; end;
end $$;

-- Photos: a private bucket, one folder per household.
insert into storage.buckets (id, name, public) values ('photos', 'photos', false) on conflict (id) do nothing;

drop policy if exists "household photos read" on storage.objects;
create policy "household photos read" on storage.objects for select
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "household photos add" on storage.objects;
create policy "household photos add" on storage.objects for insert
  with check (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "household photos change" on storage.objects;
create policy "household photos change" on storage.objects for update
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "household photos remove" on storage.objects;
create policy "household photos remove" on storage.objects for delete
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));

-- Spoonbook Plus (paywall, off by default) lives in plus.sql. Run that file too.
