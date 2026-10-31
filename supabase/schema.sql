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

-- Roles: editors can change the cookbook, viewers can only look (and copy recipes into a cookbook of their own).
-- Editors join with join_code, viewers with view_code.
alter table public.members add column if not exists role text not null default 'editor';
do $$ begin alter table public.members add constraint members_role_check check (role in ('editor', 'viewer')); exception when duplicate_object then null; end $$;
alter table public.households add column if not exists view_code text unique default upper(substr(md5(random()::text), 1, 6));
update public.households set view_code = upper(substr(md5(random()::text || id::text), 1, 6)) where view_code is null;

-- Who belongs where. security definer so policies can call it without recursion.
create or replace function public.is_member(hh uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where household_id = hh and user_id = auth.uid());
$$;
create or replace function public.is_editor(hh uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where household_id = hh and user_id = auth.uid() and role = 'editor');
$$;
-- Who can manage people: whoever started the cookbook, or any editor once that person has gone.
create or replace function public.can_manage(hh uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.households h where h.id = hh and (
    h.created_by = auth.uid()
    or ((h.created_by is null or not exists (select 1 from public.members m where m.household_id = hh and m.user_id = h.created_by)) and public.is_editor(hh))));
$$;

alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.recipes enable row level security;
alter table public.lists enable row level security;

drop policy if exists "members read household" on public.households;
create policy "members read household" on public.households for select using (public.is_member(id));
drop policy if exists "members rename household" on public.households;
create policy "members rename household" on public.households for update using (public.is_editor(id));
-- The invite codes are only handed out through cookbook_codes(), so a viewer can't find the editors' code.
revoke select on public.households from anon, authenticated;
grant select (id, name, created_by, created_at) on public.households to authenticated;

drop policy if exists "members see each other" on public.members;
create policy "members see each other" on public.members for select using (public.is_member(household_id));
drop policy if exists "change own name" on public.members;
create policy "change own name" on public.members for update using (user_id = auth.uid());
drop policy if exists "leave household" on public.members;
create policy "leave household" on public.members for delete using (user_id = auth.uid());

drop policy if exists "members use recipes" on public.recipes;
drop policy if exists "members read recipes" on public.recipes;
create policy "members read recipes" on public.recipes for select using (public.is_member(household_id));
drop policy if exists "editors add recipes" on public.recipes;
create policy "editors add recipes" on public.recipes for insert with check (public.is_editor(household_id));
drop policy if exists "editors change recipes" on public.recipes;
create policy "editors change recipes" on public.recipes for update using (public.is_editor(household_id)) with check (public.is_editor(household_id));
drop policy if exists "editors remove recipes" on public.recipes;
create policy "editors remove recipes" on public.recipes for delete using (public.is_editor(household_id));
drop policy if exists "members use lists" on public.lists;
drop policy if exists "members read lists" on public.lists;
create policy "members read lists" on public.lists for select using (public.is_member(household_id));
drop policy if exists "editors add lists" on public.lists;
create policy "editors add lists" on public.lists for insert with check (public.is_editor(household_id));
drop policy if exists "editors change lists" on public.lists;
create policy "editors change lists" on public.lists for update using (public.is_editor(household_id)) with check (public.is_editor(household_id));
drop policy if exists "editors remove lists" on public.lists;
create policy "editors remove lists" on public.lists for delete using (public.is_editor(household_id));

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

-- Join someone else's cookbook with their code. The editors' code makes you an editor, the view code a viewer.
drop function if exists public.join_household(text, text);
create or replace function public.join_household(code text, my_name text) returns json
language plpgsql security definer set search_path = public as $$
declare h public.households; r text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into h from public.households where join_code = upper(trim(code));
  if h.id is not null then r := 'editor';
  else select * into h from public.households where view_code = upper(trim(code)); r := 'viewer'; end if;
  if h.id is null then raise exception 'No cookbook has that code'; end if;
  insert into public.members (household_id, user_id, display_name, role) values (h.id, auth.uid(), coalesce(trim(my_name), ''), r)
    on conflict (household_id, user_id) do update set display_name = excluded.display_name,
      role = case when public.members.role = 'editor' then 'editor' else excluded.role end;
  return json_build_object('id', h.id, 'name', h.name, 'role', (select role from public.members where household_id = h.id and user_id = auth.uid()));
end $$;

-- The invite codes, for editors only.
create or replace function public.cookbook_codes(hh uuid) returns json
language sql stable security definer set search_path = public as $$
  select case when public.is_editor(hh) then json_build_object('join_code', join_code, 'view_code', view_code) end from public.households where id = hh;
$$;

-- Managing people (whoever started the cookbook).
create or replace function public.set_member_role(hh uuid, member uuid, new_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(hh) then raise exception 'Only the person who started this cookbook can do that'; end if;
  if new_role not in ('editor', 'viewer') then raise exception 'Unknown role'; end if;
  if new_role = 'viewer' and not exists (select 1 from public.members where household_id = hh and role = 'editor' and user_id <> member) then
    raise exception 'A cookbook needs at least one editor'; end if;
  update public.members set role = new_role where household_id = hh and user_id = member;
end $$;
create or replace function public.remove_member(hh uuid, member uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(hh) then raise exception 'Only the person who started this cookbook can do that'; end if;
  if member = auth.uid() then raise exception 'Use Leave this cookbook instead'; end if;
  delete from public.members where household_id = hh and user_id = member;
end $$;
-- New invite codes, so old ones stop working.
create or replace function public.new_codes(hh uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(hh) then raise exception 'Only the person who started this cookbook can do that'; end if;
  update public.households set join_code = upper(substr(md5(random()::text), 1, 6)), view_code = upper(substr(md5(random()::text || 'v'), 1, 6)) where id = hh;
  return public.cookbook_codes(hh);
end $$;
-- Leave a cookbook. The last person out takes it with them; if only viewers are left, the longest-standing becomes an editor.
create or replace function public.leave_household(hh uuid) returns text
language plpgsql security definer set search_path = public as $$
declare left_n int;
begin
  delete from public.members where household_id = hh and user_id = auth.uid();
  select count(*) into left_n from public.members where household_id = hh;
  if left_n = 0 then delete from public.households where id = hh; return 'deleted_cookbook'; end if;
  if not exists (select 1 from public.members where household_id = hh and role = 'editor') then
    update public.members set role = 'editor' where household_id = hh and user_id = (select user_id from public.members where household_id = hh order by joined_at limit 1);
  end if;
  return 'left';
end $$;

grant execute on function public.create_household(text, text) to authenticated;
grant execute on function public.join_household(text, text) to authenticated;
grant execute on function public.cookbook_codes(uuid) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.new_codes(uuid) to authenticated;
grant execute on function public.leave_household(uuid) to authenticated;
grant execute on function public.is_editor(uuid) to authenticated;
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
  with check (bucket_id = 'photos' and public.is_editor(((storage.foldername(name))[1])::uuid));
drop policy if exists "household photos change" on storage.objects;
create policy "household photos change" on storage.objects for update
  using (bucket_id = 'photos' and public.is_editor(((storage.foldername(name))[1])::uuid));
drop policy if exists "household photos remove" on storage.objects;
create policy "household photos remove" on storage.objects for delete
  using (bucket_id = 'photos' and public.is_editor(((storage.foldername(name))[1])::uuid));

-- Spoonbook Plus (paywall, off by default) lives in plus.sql. Run that file too.

-- Delete my account: removes the person and, if nobody else shares their cookbook, the cookbook with it.
-- (The app deletes the photos first, because Supabase only lets photos be removed through its storage API.)
create or replace function public.delete_my_account() returns text
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := auth.uid(); hh uuid; others int; result text := 'left_cookbook';
begin
  if me is null then raise exception 'Not signed in'; end if;
  for hh in select household_id from public.members where user_id = me loop
    select count(*) into others from public.members where household_id = hh and user_id <> me;
    if others = 0 then delete from public.households where id = hh; result := 'deleted_cookbook'; end if;
  end loop;
  delete from auth.users where id = me;
  return result;
end $$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Sharing a recipe as a link. Each share is a snapshot of one recipe; the cookbook itself stays private.
-- Anyone with the link can read that one recipe (through get_shared_recipe), but nobody can list them.
create table if not exists public.shared_recipes (
  id text primary key check (id ~ '^[A-Za-z0-9]{8,24}$'),
  household_id uuid references public.households(id) on delete cascade,
  created_by uuid references auth.users(id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.shared_recipes enable row level security;
drop policy if exists "share from my cookbook" on public.shared_recipes;
create policy "share from my cookbook" on public.shared_recipes for insert to authenticated
  with check (created_by = auth.uid() and public.is_member(household_id));
drop policy if exists "see my shares" on public.shared_recipes;
create policy "see my shares" on public.shared_recipes for select to authenticated using (created_by = auth.uid());
create or replace function public.get_shared_recipe(share_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select data from public.shared_recipes where id = share_id;
$$;
grant execute on function public.get_shared_recipe(text) to anon, authenticated;

-- Photos for shared recipes live in a public bucket, one file per share, named by its unguessable id.
insert into storage.buckets (id, name, public) values ('shared', 'shared', true) on conflict (id) do update set public = true;
drop policy if exists "shared photos add" on storage.objects;
create policy "shared photos add" on storage.objects for insert to authenticated with check (bucket_id = 'shared');
drop policy if exists "shared photos mine" on storage.objects;
create policy "shared photos mine" on storage.objects for select to authenticated using (bucket_id = 'shared' and owner_id = auth.uid()::text);
drop policy if exists "shared photos remove" on storage.objects;
create policy "shared photos remove" on storage.objects for delete to authenticated using (bucket_id = 'shared' and owner_id = auth.uid()::text);

-- Feedback sent from the app (⋯ → Send feedback). Read it in Table Editor → feedback.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid() references auth.users(id) on delete set null,
  household_id uuid,
  name text,
  message text not null check (length(message) between 1 and 5000),
  app text,
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;
drop policy if exists "send feedback" on public.feedback;
create policy "send feedback" on public.feedback for insert to authenticated with check (user_id = auth.uid());
revoke select, update, delete on public.feedback from anon, authenticated;
grant insert on public.feedback to authenticated;

-- Weekly backups are saved here by the backup function. Private: no policies, so only the server can read it.
insert into storage.buckets (id, name, public) values ('backups', 'backups', false) on conflict (id) do update set public = false;
