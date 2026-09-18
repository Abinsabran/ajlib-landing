alter table public.profiles
  add column if not exists role text not null default 'customer';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_role_check'
  ) then
    alter table public.profiles add constraint profiles_role_check
      check (role in ('customer','admin','owner'));
  end if;
end $$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin','owner')
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

revoke insert, update on table public.profiles from authenticated;
grant insert (id, full_name, phone, emirate, city, address, delivery_notes)
  on table public.profiles to authenticated;
grant update (full_name, phone, emirate, city, address, delivery_notes)
  on table public.profiles to authenticated;

grant update (status) on table public.orders to authenticated;

drop policy if exists "Admins read all orders" on public.orders;
create policy "Admins read all orders" on public.orders
for select to authenticated using (public.is_admin());

drop policy if exists "Admins update order status" on public.orders;
create policy "Admins update order status" on public.orders
for update to authenticated using (public.is_admin())
with check (public.is_admin());

update public.profiles p
set role = 'owner'
from auth.users u
where p.id = u.id
  and lower(u.email) = lower('a.binsabran@hotmail.com');

comment on column public.profiles.role is 'Server-controlled AJLIB authorization role.';
