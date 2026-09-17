-- Phase 4 — provider-neutral fulfillment columns for public.orders.
--
-- NOT EXECUTED. Prepared for review only.
--
-- IMPORTANT: unlike Vercel Preview vs Production (separate deployments),
-- there is only ONE Supabase project/database referenced throughout this
-- whole engagement (see api/supabase-config.js, confirmed URL
-- https://sxgzdpuovxpvkrmfzukp.supabase.co). Applying this migration
-- changes the SAME database that Production also reads from — "Preview
-- only" does not apply to it the way it does to code deployments. Treat
-- running this as a separate, explicit approval decision, not something
-- bundled into "Preview only" work.
--
-- All new columns are nullable/defaulted so existing rows and every
-- existing query (admin console, mobile app, webhook handlers) keep working
-- unchanged. Never exposed to customer-facing APIs — see
-- lib/fulfillment-status.js serializeOrderForCustomer, which does not
-- (and after this migration, still must not) select any fulfillment_*
-- column into a customer response.

begin;

alter table public.orders
  add column if not exists fulfillment_provider text,
  add column if not exists fulfillment_external_order_id text,
  add column if not exists fulfillment_external_order_number text,
  add column if not exists fulfillment_status text,
  add column if not exists fulfillment_tracking_number text,
  add column if not exists fulfillment_logistics_method text,
  add column if not exists fulfillment_cost numeric(18,2),
  add column if not exists fulfillment_currency text,
  add column if not exists fulfillment_last_sync_at timestamptz,
  add column if not exists fulfillment_error text,
  add column if not exists fulfillment_retry_count integer not null default 0;

-- Idempotency: at most one CJ (or other provider) order per AJLIB order.
create unique index if not exists orders_fulfillment_external_order_id_idx
  on public.orders (fulfillment_external_order_id)
  where fulfillment_external_order_id is not null;

comment on column public.orders.fulfillment_provider is 'e.g. "cj" — internal only, never exposed to customer APIs.';
comment on column public.orders.fulfillment_external_order_id is 'Provider order id, e.g. CJ orderId — internal only.';
comment on column public.orders.fulfillment_status is 'Provider''s own raw status (e.g. CJ''s CREATED/PENDING/SHIPPED/...) — internal only; see lib/fulfillment-status.js for the customer-safe 5-status mapping.';

-- Webhook idempotency: CJ's own `messageId` per delivered event, so a
-- redelivered webhook (CJ retries on non-2xx, and providers in general may
-- redeliver the same event more than once) never applies the same status
-- transition twice. No foreign key to orders — a dedup table should still
-- accept every messageId even if the local order lookup fails to resolve.
create table if not exists public.cj_webhook_events (
  message_id text primary key,
  topic text not null,
  received_at timestamptz not null default now()
);

commit;
