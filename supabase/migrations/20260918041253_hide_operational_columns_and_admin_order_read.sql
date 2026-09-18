-- Hide the Stripe identifiers from customers now, and add the admin read path
-- that will let admin_note be hidden too once the new website is live.
--
-- STAGED ON PURPOSE. Preview shares the Production database, and the LIVE
-- Production website (www.ajlib.store, old code) still selects admin_note
-- straight from public.orders in its admin console. Revoking admin_note here
-- would break the live admin order list the moment this was pushed. So this
-- migration keeps admin_note granted; revoking it is a separate step
-- (supabase/migrations/PENDING_AT_PRODUCTION_DEPLOY_hide_admin_note.sql.txt)
-- that must ship together with the website that reads notes through
-- admin_list_orders().
--
-- The previous migration hid the 11 fulfillment_* columns. Three more
-- operational fields were still customer-readable on a customer's own
-- orders, via a direct select on the REST API:
--   * admin_note                — internal staff notes
--   * stripe_session_id         — Stripe (and, for Tabby, tabby_<id>) reference
--   * stripe_payment_intent_id  — Stripe PaymentIntent reference
--
-- No client reads the Stripe identifiers at all (checked: storefront, shipped
-- Expo app, admin console). admin_note IS read — by the web admin console,
-- which runs as the same `authenticated` role as customers. Column privileges
-- apply per role, not per person, so admins and customers cannot be told
-- apart by a column grant alone.
--
-- So the admin console reads through admin_list_orders(): SECURITY DEFINER,
-- it runs with the table owner's rights but refuses anyone for whom
-- public.is_admin() is false — the same check the existing "Admins read all
-- orders" RLS policy already relies on. It returns exactly the columns the
-- console already selected, in the same order, so it is a drop-in swap.
--
-- Unchanged: service_role (full access), anon (none), every RLS policy, and
-- every column the storefront, the shipped Expo app and order history read
-- or filter on (user_id included — the app filters on it).

-- 1. Narrow customer SELECT to 25 columns (was 27): drop the two Stripe ids.
--    Revoke first: revoking the table privilege also drops column grants.
revoke select on table public.orders from authenticated;

grant select (
  id,
  order_number,
  user_id,
  customer_email,
  customer_name,
  customer_phone,
  shipping_address,
  items,
  amount_total,
  currency,
  status,
  paid_at,
  created_at,
  updated_at,
  shipping_company,
  tracking_number,
  admin_note, -- still read by the LIVE admin console; revoked at Production deploy
  shipping_address_id,
  shipping_country_code,
  shipping_country_name,
  shipping_region,
  shipping_postal_code,
  product_amount,
  shipping_amount,
  shipping_city
) on table public.orders to authenticated;

-- 2. Admin-only read path for the console.
--    search_path is pinned to '' and every object is schema-qualified, so a
--    caller cannot redirect this elevated function at objects of their own.
create or replace function public.admin_list_orders()
returns table (
  id uuid,
  order_number text,
  customer_name text,
  customer_email text,
  customer_phone text,
  shipping_address text,
  items jsonb,
  amount_total integer,
  currency text,
  status text,
  shipping_company text,
  tracking_number text,
  admin_note text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
    select o.id, o.order_number, o.customer_name, o.customer_email, o.customer_phone,
           o.shipping_address, o.items, o.amount_total, o.currency, o.status,
           o.shipping_company, o.tracking_number, o.admin_note, o.created_at, o.updated_at
      from public.orders o
     order by o.created_at desc;
end;
$$;

-- Functions are executable by PUBLIC by default; restrict to signed-in users.
-- The is_admin() check inside decides which of them get any rows.
revoke all on function public.admin_list_orders() from public, anon;
grant execute on function public.admin_list_orders() to authenticated;
