create table if not exists public.inventory (
  color text not null,
  size text not null,
  stock integer not null default 0 check (stock >= 0),
  track_stock boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (color, size)
);

insert into public.inventory (color, size)
select color, size from unnest(array['أسود','كحلي','رمادي','أبيض']) color
cross join unnest(array['M','L','XL','XXL']) size
on conflict (color, size) do nothing;

create table if not exists public.inventory_events (
  stripe_session_id text primary key,
  created_at timestamptz not null default now()
);

alter table public.inventory enable row level security;
revoke all on table public.inventory from anon, authenticated;
grant select, update on table public.inventory to authenticated;

drop policy if exists "Admins manage inventory" on public.inventory;
create policy "Admins manage inventory" on public.inventory
for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.check_inventory(requested jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('variant', r.variant, 'requested', r.qty, 'available', i.stock)), '[]'::jsonb)
  from (
    select split_part(x->>'variant','-',1) color, split_part(x->>'variant','-',2) size,
           x->>'variant' variant, (x->>'quantity')::int qty
    from jsonb_array_elements(requested) x
  ) r join public.inventory i on i.color=r.color and i.size=r.size
  where i.track_stock and i.stock < r.qty;
$$;

create or replace function public.process_paid_inventory(session_id text, requested jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare inserted boolean;
begin
  insert into public.inventory_events(stripe_session_id) values(session_id)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  if not inserted then return false; end if;
  update public.inventory i set stock=greatest(0,i.stock-r.qty),updated_at=now()
  from (
    select split_part(x->>'variant','-',1) color, split_part(x->>'variant','-',2) size,(x->>'quantity')::int qty
    from jsonb_array_elements(requested) x
  ) r where i.color=r.color and i.size=r.size and i.track_stock;
  return true;
end $$;

revoke all on function public.check_inventory(jsonb) from public;
revoke all on function public.process_paid_inventory(text,jsonb) from public;
grant execute on function public.check_inventory(jsonb) to service_role;
grant execute on function public.process_paid_inventory(text,jsonb) to service_role;
