-- Hide internal fulfillment columns from customers — at the database, not
-- just in the frontend.
--
-- THE PROBLEM
-- `authenticated` held a TABLE-WIDE SELECT on public.orders. Row-level
-- security only decides WHICH ROWS a customer may see ("Customers read own
-- orders": auth.uid() = user_id); it says nothing about WHICH COLUMNS. So any
-- logged-in customer could call the REST API with select=* on their own
-- orders and read "cj", the CJ logistics route, the USD cost and internal
-- errors such as INSUFFICIENT_CJ_BALANCE. The storefront and app simply
-- never asked for those columns — which is not a control.
--
-- THE FIX
-- Replace the table-wide grant with a column-level grant covering exactly
-- the 27 columns customers could already read, minus nothing else. Only the
-- 11 fulfillment_* columns become unreadable. PostgreSQL then rejects any
-- request touching them — including select=* — with 42501, while RLS keeps
-- deciding which rows are visible exactly as before.
--
-- ORDER MATTERS: revoking the table-level privilege also revokes any
-- column-level SELECT, so the revoke must come first and the column grant
-- second. Both run inside one migration transaction, so there is no window
-- in which customers lose access to their normal order fields.
--
-- WHAT IS DELIBERATELY UNCHANGED
--   * service_role — the server — keeps full table access (separate grant).
--   * anon — already had no access to orders; untouched.
--   * All RLS policies — untouched.
--   * authenticated's other privileges (REFERENCES/TRIGGER/TRUNCATE) —
--     untouched; only SELECT is narrowed.
--   * Every column the storefront, the shipped Expo app and the admin console
--     read or FILTER on stays granted. Filtering matters: PostgreSQL needs
--     SELECT on a column used in a WHERE, and the app filters on user_id.
--
-- NOTE FOR FUTURE MIGRATIONS
-- A column-level grant does not extend to columns added later. Any NEW
-- customer-visible column on public.orders must be granted explicitly; a new
-- internal column will stay hidden by default. That is the safer default.

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
  stripe_session_id,
  stripe_payment_intent_id,
  paid_at,
  created_at,
  updated_at,
  shipping_company,
  tracking_number,
  admin_note,
  shipping_address_id,
  shipping_country_code,
  shipping_country_name,
  shipping_region,
  shipping_postal_code,
  product_amount,
  shipping_amount,
  shipping_city
) on table public.orders to authenticated;
