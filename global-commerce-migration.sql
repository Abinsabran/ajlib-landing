-- AJLIB global commerce: multiple addresses and worldwide shipping zones.
begin;

create table if not exists public.addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null default 'المنزل',
  recipient_name text not null,
  phone text not null,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  country_name text not null,
  region text,
  city text not null,
  postal_code text,
  address_line1 text not null,
  address_line2 text,
  delivery_notes text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists addresses_user_id_idx on public.addresses(user_id, created_at desc);
create unique index if not exists addresses_one_default_per_user
  on public.addresses(user_id) where is_default;

create or replace function public.manage_default_address()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id <> (select auth.uid()) and (select auth.role()) <> 'service_role' then
    raise exception 'Address owner mismatch';
  end if;
  if new.is_default or not exists (
    select 1 from public.addresses where user_id = new.user_id and id <> coalesce(new.id, gen_random_uuid())
  ) then
    update public.addresses set is_default = false
    where user_id = new.user_id and id <> coalesce(new.id, gen_random_uuid()) and is_default;
    new.is_default := true;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists addresses_default_guard on public.addresses;
create trigger addresses_default_guard
before insert or update on public.addresses
for each row execute procedure public.manage_default_address();

create or replace function public.restore_default_address()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_default then
    update public.addresses set is_default = true
    where id = (select id from public.addresses where user_id = old.user_id order by created_at desc limit 1);
  end if;
  return old;
end;
$$;

drop trigger if exists addresses_restore_default on public.addresses;
create trigger addresses_restore_default
after delete on public.addresses
for each row execute procedure public.restore_default_address();

alter table public.addresses enable row level security;
revoke all on table public.addresses from anon, authenticated;
grant select, insert, update, delete on table public.addresses to authenticated;

drop policy if exists "Customers read own addresses" on public.addresses;
create policy "Customers read own addresses" on public.addresses
for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Customers add own addresses" on public.addresses;
create policy "Customers add own addresses" on public.addresses
for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Customers update own addresses" on public.addresses;
create policy "Customers update own addresses" on public.addresses
for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Customers delete own addresses" on public.addresses;
create policy "Customers delete own addresses" on public.addresses
for delete to authenticated using ((select auth.uid()) = user_id);

insert into public.addresses (
  user_id, label, recipient_name, phone, country_code, country_name,
  region, city, address_line1, delivery_notes, is_default
)
select p.id, 'العنوان الأساسي', coalesce(nullif(p.full_name,''),'عميل AJLIB'), coalesce(p.phone,''),
       'AE', 'الإمارات العربية المتحدة', p.emirate, p.city, p.address, p.delivery_notes, true
from public.profiles p
where nullif(trim(coalesce(p.address,'')),'') is not null
  and not exists (select 1 from public.addresses a where a.user_id = p.id)
on conflict do nothing;

create table if not exists public.shipping_zones (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name_ar text not null,
  country_codes text[] not null default '{}',
  amount integer not null check (amount >= 0),
  currency text not null default 'aed',
  min_days integer not null check (min_days > 0),
  max_days integer not null check (max_days >= min_days),
  active boolean not null default true,
  sort_order integer not null default 100,
  updated_at timestamptz not null default now()
);

insert into public.shipping_zones(code,name_ar,country_codes,amount,min_days,max_days,sort_order) values
('AE','الإمارات العربية المتحدة',array['AE'],0,1,3,10),
('GCC','دول مجلس التعاون الخليجي',array['SA','BH','KW','OM','QA'],4500,3,6,20),
('MENA','الشرق الأوسط وشمال أفريقيا',array['DZ','EG','IQ','JO','LB','LY','MA','PS','SD','SY','TN','YE'],7500,5,10,30),
('EUROPE','أوروبا',array['AD','AL','AT','AX','BA','BE','BG','BY','CH','CY','CZ','DE','DK','EE','ES','FI','FO','FR','GB','GG','GI','GR','HR','HU','IE','IM','IS','IT','JE','LI','LT','LU','LV','MC','MD','ME','MK','MT','NL','NO','PL','PT','RO','RS','RU','SE','SI','SJ','SK','SM','TR','UA','VA'],11000,6,12,40),
('ASIA','آسيا',array['AF','AM','AZ','BD','BN','BT','CN','GE','HK','ID','IN','JP','KG','KH','KP','KR','KZ','LA','LK','MM','MN','MO','MV','MY','NP','PH','PK','SG','TH','TJ','TL','TM','TW','UZ','VN'],12000,7,14,50),
('AFRICA','أفريقيا',array['AO','BF','BI','BJ','BW','CD','CF','CG','CI','CM','CV','DJ','ER','ET','GA','GH','GM','GN','GQ','GW','KE','KM','LR','LS','MG','ML','MR','MU','MW','MZ','NA','NE','NG','RE','RW','SC','SH','SL','SN','SO','SS','ST','SZ','TD','TG','TZ','UG','YT','ZA','ZM','ZW'],13500,8,16,60),
('AMERICAS','الأمريكيتان والكاريبي',array['AG','AI','AR','AW','BB','BL','BM','BO','BQ','BR','BS','BZ','CA','CL','CO','CR','CU','CW','DM','DO','EC','FK','GD','GF','GL','GP','GS','GT','GY','HN','HT','JM','KN','KY','LC','MF','MQ','MS','MX','NI','PA','PE','PM','PR','PY','SR','SV','SX','TC','TT','US','UY','VC','VE','VG','VI'],15000,8,16,70),
('OCEANIA','أستراليا ونيوزيلندا وجزر المحيط الهادئ',array['AS','AU','CC','CK','CX','FJ','FM','GU','HM','KI','MH','MP','NC','NF','NR','NU','NZ','PF','PG','PN','PW','SB','TK','TO','TV','UM','VU','WF','WS'],17000,9,18,80),
('WORLD','بقية دول العالم',array[]::text[],19000,10,21,999)
on conflict (code) do update set
  name_ar=excluded.name_ar,country_codes=excluded.country_codes,amount=excluded.amount,
  min_days=excluded.min_days,max_days=excluded.max_days,sort_order=excluded.sort_order;

alter table public.shipping_zones enable row level security;
revoke all on table public.shipping_zones from anon, authenticated;
grant select on table public.shipping_zones to anon, authenticated;
grant update (amount,min_days,max_days,active) on table public.shipping_zones to authenticated;

drop policy if exists "Public reads active shipping zones" on public.shipping_zones;
create policy "Public reads active shipping zones" on public.shipping_zones
for select to anon, authenticated using (active or public.is_admin());
drop policy if exists "Admins update shipping zones" on public.shipping_zones;
create policy "Admins update shipping zones" on public.shipping_zones
for update to authenticated using (public.is_admin()) with check (public.is_admin());

alter table public.orders
  add column if not exists shipping_address_id uuid references public.addresses(id) on delete set null,
  add column if not exists shipping_country_code text,
  add column if not exists shipping_country_name text,
  add column if not exists shipping_region text,
  add column if not exists shipping_postal_code text,
  add column if not exists product_amount integer,
  add column if not exists shipping_amount integer not null default 0;

commit;
