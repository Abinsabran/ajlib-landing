-- Explicit AED / USD payment currency (chosen on AJLIB's checkout, never by
-- Stripe Adaptive Pricing). Canonical economics stay in AED:
--   amount_total / currency   unchanged meaning: the canonical AED total
--   canonical_total_aed       the same canonical total, AED fils
--   paid_currency             currency actually charged: 'aed' or 'usd'
--   paid_amount               amount actually charged, in paid_currency's
--                             minor units (fils or cents)
-- Additive only. Existing orders keep NULL in the new columns and are not
-- touched. Customers cannot read these: the authenticated role has an
-- explicit column-level SELECT grant (20260918134355) that does not include
-- them.

alter table public.orders
  add column if not exists canonical_total_aed integer,
  add column if not exists paid_currency text,
  add column if not exists paid_amount integer;
