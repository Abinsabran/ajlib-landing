-- Structured street lines for CJ fulfillment (createOrderV2 shippingAddress /
-- shippingAddress2 must carry the street only, never the combined address).
-- Captured at checkout (Stripe and Tabby) and stored trimmed. Additive only;
-- historical orders keep NULL and are held for manual review if ever
-- prepared for CJ — a street is never parsed back out of shipping_address.
--
-- Customers cannot read these: the authenticated role has an explicit
-- column-level SELECT grant (20260918134355) that does not include them.

alter table public.orders
  add column if not exists shipping_street text,
  add column if not exists shipping_street2 text;
