-- CJ manual-payment launch model: AJLIB creates the CJ order unpaid
-- (createOrderV2 payType 1) and the owner pays it in CJ.
--   fulfillment_payment_url   cjPayUrl returned by CJ for that order (owner only)
--   fulfillment_cj_paid_at    when CJ reports the order paid (getOrderDetail paymentDate)
--   fulfillment_alert_sent_at when the owner was alerted to pay it
-- Additive only. Not granted to customers (their SELECT is an explicit
-- column list, 20260918134355, which does not include these).

alter table public.orders
  add column if not exists fulfillment_payment_url text,
  add column if not exists fulfillment_cj_paid_at timestamptz,
  add column if not exists fulfillment_alert_sent_at timestamptz;
