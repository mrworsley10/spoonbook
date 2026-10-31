-- Spoonbook Plus: the paywall. It is SWITCHED OFF until you turn it on (see the bottom of this file).
-- Paste into Supabase → SQL Editor → New query, then press Run. Safe to run more than once.

-- Which cookbooks have Plus. Only the billing function can change this (see the grants below).
alter table public.households add column if not exists plan text not null default 'free';
alter table public.households add column if not exists plus_until timestamptz;

-- People can still rename their cookbook, but can't give themselves Plus.
revoke update on public.households from anon, authenticated;
grant update (name) on public.households to authenticated;
grant select (plan, plus_until) on public.households to authenticated;

-- One row of app-wide settings, readable by the app.
create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  paywall_enabled boolean not null default false,
  free_recipe_limit int not null default 50
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;
alter table public.app_settings enable row level security;
drop policy if exists "anyone reads settings" on public.app_settings;
create policy "anyone reads settings" on public.app_settings for select using (true);
revoke insert, update, delete on public.app_settings from anon, authenticated;
grant select on public.app_settings to anon, authenticated;

create or replace function public.has_plus(hh uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from households where id = hh and plan = 'plus' and (plus_until is null or plus_until > now()));
$$;

-- When the paywall is on, a free cookbook can't go past the limit. Recipes in "Recently deleted" don't count,
-- and changes to recipes already in the book are always allowed.
create or replace function public.enforce_free_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare s app_settings; n int;
begin
  select * into s from app_settings where id = 1;
  if s is null or not s.paywall_enabled or has_plus(new.household_id) then return new; end if;
  if exists (select 1 from recipes where household_id = new.household_id and id = new.id) then return new; end if;
  select count(*) into n from recipes where household_id = new.household_id and (data->>'deletedAt') is null;
  if n >= s.free_recipe_limit then
    raise exception 'free_limit: this cookbook has reached its % free recipes', s.free_recipe_limit using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists recipes_free_limit on public.recipes;
create trigger recipes_free_limit before insert on public.recipes for each row execute function public.enforce_free_limit();

-- To switch the paywall on later:   update public.app_settings set paywall_enabled = true where id = 1;
-- To change the free limit:         update public.app_settings set free_recipe_limit = 75 where id = 1;
-- To give a cookbook Plus by hand:  update public.households set plan = 'plus', plus_until = null where join_code = 'ABC123';
