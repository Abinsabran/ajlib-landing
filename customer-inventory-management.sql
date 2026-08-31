-- AJLIB owner customer management and pre-order inventory controls.
alter table public.inventory
  add column if not exists allow_preorder boolean not null default false,
  add column if not exists preorder_eta text;

create or replace function public.check_inventory(requested jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'variant', r.variant,
    'requested', r.qty,
    'available', i.stock,
    'allow_preorder', i.allow_preorder,
    'preorder_eta', i.preorder_eta
  )), '[]'::jsonb)
  from (
    select split_part(x->>'variant','-',1) color,
           split_part(x->>'variant','-',2) size,
           x->>'variant' variant,
           (x->>'quantity')::int qty
    from jsonb_array_elements(requested) x
  ) r
  join public.inventory i on i.color=r.color and i.size=r.size
  where i.track_stock and i.stock < r.qty;
$$;

revoke all on function public.check_inventory(jsonb) from public;
grant execute on function public.check_inventory(jsonb) to service_role;

-- Repair Saleh's paid orders and link them to the verified account.
update public.orders o
set customer_email = 'aaleh90000007@gmail.com',
    user_id = u.id,
    updated_at = now()
from auth.users u
where lower(u.email) = 'aaleh90000007@gmail.com'
  and lower(o.customer_email) = 'aaleh90000007@gamil.com';
