-- Internal CJ tracking details stored by the admin tracking sync
-- (api/_lib/fulfillment-tracking.js). Additive only.
--
-- Customers cannot read these: the authenticated role has an explicit
-- column-level SELECT grant (20260918134355) that does not include them,
-- and new columns are not added to a column grant automatically.
-- service_role keeps full access through its table-level privileges.

alter table public.orders
  add column if not exists fulfillment_carrier text,
  add column if not exists fulfillment_tracking_url text;
