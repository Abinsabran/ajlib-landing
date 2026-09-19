-- Customer order history: public.my_orders().
--
-- Why: the storefront read history with `orders?user_id=eq.<me>`, so any
-- paid order saved without user_id was invisible to its owner. That happened
-- to AJ75446351: the website never refreshed its Supabase access token, so a
-- checkout made more than an hour after sign-in sent an expired token, the
-- server could not resolve the user, and the order was saved with user_id
-- NULL (the storefront now refreshes the token before checkout).
--
-- Ownership, strongest first:
--   1. user_id = auth.uid()                        (linked at checkout)
--   2. user_id IS NULL and the order's customer_email equals the caller's
--      VERIFIED account email (auth.users.email_confirmed_at set), compared
--      trimmed and case-insensitively. The email comes from auth.users for
--      auth.uid() — never from the request — so it cannot be spoofed, and an
--      order linked to another account is never matched by email.
--
-- Filtered by ownership explicitly (not by RLS), so an admin calling it sees
-- only their own orders, not every unlinked order. Returns exactly the
-- customer-visible columns the history already showed; no internal,
-- fulfillment or CJ field. Read-only; no RLS policy or grant on
-- public.orders changes.

create or replace function public.my_orders()
returns table (
  order_number text,
  items jsonb,
  amount_total integer,
  currency text,
  status text,
  shipping_company text,
  tracking_number text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select u.id,
           case when u.email_confirmed_at is not null then lower(trim(u.email)) end as verified_email
    from auth.users u
    where u.id = auth.uid()
  )
  select o.order_number, o.items, o.amount_total, o.currency, o.status,
         o.shipping_company, o.tracking_number, o.created_at, o.updated_at
  from public.orders o, me
  where o.user_id = me.id
     or (o.user_id is null
         and me.verified_email is not null
         and o.customer_email is not null
         and lower(trim(o.customer_email)) = me.verified_email)
  order by o.created_at desc
$$;

revoke all on function public.my_orders() from public;
revoke all on function public.my_orders() from anon;
grant execute on function public.my_orders() to authenticated;
