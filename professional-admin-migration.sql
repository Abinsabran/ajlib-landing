-- Stable read models for AJLIB storefront and owner console.
create or replace function public.public_inventory()
returns table(color text, size text, stock integer, track_stock boolean, allow_preorder boolean, preorder_eta text)
language sql stable security definer set search_path = '' as $$
  select i.color, i.size, i.stock, i.track_stock, i.allow_preorder, i.preorder_eta
  from public.inventory i
  order by i.color, i.size;
$$;
revoke all on function public.public_inventory() from public;
grant execute on function public.public_inventory() to anon, authenticated;

create or replace function public.admin_customer_list()
returns table(
  id uuid, email text, full_name text, phone text, emirate text, city text,
  address text, delivery_notes text, role text, created_at timestamptz,
  last_sign_in_at timestamptz, orders_count bigint, active_orders bigint,
  total_spent bigint
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'AJLIB owner access required'; end if;
  return query
  select u.id, u.email::text, p.full_name, p.phone, p.emirate, p.city,
         p.address, p.delivery_notes, p.role, u.created_at, u.last_sign_in_at,
         count(o.id)::bigint,
         count(o.id) filter (where o.status in ('paid','processing','packed','shipped'))::bigint,
         coalesce(sum(o.amount_total) filter (where o.status not in ('cancelled','refunded')),0)::bigint
  from auth.users u
  left join public.profiles p on p.id=u.id
  left join public.orders o on o.user_id=u.id or lower(o.customer_email)=lower(u.email)
  group by u.id,u.email,p.full_name,p.phone,p.emirate,p.city,p.address,p.delivery_notes,p.role,u.created_at,u.last_sign_in_at
  order by u.created_at desc;
end $$;
revoke all on function public.admin_customer_list() from public;
grant execute on function public.admin_customer_list() to authenticated;

create or replace function public.admin_update_customer(
  customer_id uuid, customer_full_name text, customer_phone text,
  customer_emirate text, customer_city text, customer_address text,
  customer_delivery_notes text
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'AJLIB owner access required'; end if;
  update public.profiles set
    full_name=trim(customer_full_name), phone=trim(customer_phone),
    emirate=nullif(trim(customer_emirate),''), city=nullif(trim(customer_city),''),
    address=nullif(trim(customer_address),''), delivery_notes=nullif(trim(customer_delivery_notes),'')
  where id=customer_id;
  update auth.users set raw_user_meta_data=coalesce(raw_user_meta_data,'{}'::jsonb)||jsonb_build_object('full_name',trim(customer_full_name),'phone',trim(customer_phone))
  where id=customer_id;
  return found;
end $$;
revoke all on function public.admin_update_customer(uuid,text,text,text,text,text,text) from public;
grant execute on function public.admin_update_customer(uuid,text,text,text,text,text,text) to authenticated;
