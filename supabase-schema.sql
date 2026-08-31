create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique not null,
  user_id uuid references auth.users(id) on delete set null,
  customer_email text not null,
  customer_name text,
  customer_phone text,
  shipping_address text,
  items jsonb not null default '[]'::jsonb,
  amount_total integer not null check (amount_total >= 0),
  currency text not null default 'aed',
  status text not null default 'paid',
  stripe_session_id text unique not null,
  stripe_payment_intent_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.orders enable row level security;
revoke all on table public.profiles from anon;
revoke all on table public.orders from anon;
grant select, insert, update on table public.profiles to authenticated;
grant select on table public.orders to authenticated;

drop policy if exists "Customers read own profile" on public.profiles;
create policy "Customers read own profile" on public.profiles
for select to authenticated using (auth.uid() = id);

drop policy if exists "Customers create own profile" on public.profiles;
create policy "Customers create own profile" on public.profiles
for insert to authenticated with check (auth.uid() = id);

drop policy if exists "Customers update own profile" on public.profiles;
create policy "Customers update own profile" on public.profiles
for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "Customers read own orders" on public.orders;
create policy "Customers read own orders" on public.orders
for select to authenticated using (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'phone')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Production-grade upgrades: lifecycle, performance and reliable timestamps.
alter table public.orders
  add column if not exists updated_at timestamptz not null default now();

alter table public.profiles
  add column if not exists emirate text,
  add column if not exists city text,
  add column if not exists address text,
  add column if not exists delivery_notes text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_status_check'
  ) then
    alter table public.orders add constraint orders_status_check
      check (status in ('paid','processing','packed','shipped','delivered','cancelled','refunded'));
  end if;
end $$;

create index if not exists orders_user_created_idx
  on public.orders (user_id, created_at desc)
  where user_id is not null;
create index if not exists orders_status_created_idx
  on public.orders (status, created_at desc);
create index if not exists orders_customer_email_idx
  on public.orders (lower(customer_email));

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
before update on public.orders
for each row execute procedure public.set_updated_at();

comment on table public.profiles is 'Private AJLIB customer profile data.';
comment on table public.orders is 'Paid AJLIB orders populated by the verified Stripe webhook.';
