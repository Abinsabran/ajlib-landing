-- Applied with the Production deploy of the website that reads the admin
-- order list through admin_list_orders() (see 20260918041253). From here on,
-- the authenticated role (customers and the admin console alike) has no
-- direct read access to admin_note; admins still get it via that function.
-- Order edits go through /api/update-order with the service key and are
-- unaffected.

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
  shipping_address_id,
  shipping_country_code,
  shipping_country_name,
  shipping_region,
  shipping_postal_code,
  product_amount,
  shipping_amount,
  shipping_city
) on table public.orders to authenticated;
