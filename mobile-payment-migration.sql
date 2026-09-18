-- Private staging records for native mobile payments.
-- Customer delivery data remains in AJLIB's database and is not copied into Stripe metadata.
begin;

create table if not exists public.pending_mobile_orders (
  order_number text primary key,
  user_id uuid references auth.users(id) on delete set null,
  customer_email text not null,
  customer_name text,
  customer_phone text,
  shipping_address text,
  shipping_address_id uuid references public.addresses(id) on delete set null,
  shipping_country_code text,
  shipping_country_name text,
  shipping_region text,
  shipping_postal_code text,
  notes text,
  items jsonb not null default '[]'::jsonb,
  item_summary text not null,
  product_amount integer not null,
  shipping_amount integer not null default 0,
  shipping_zone text,
  amount_total integer not null,
  currency text not null default 'aed',
  preorder text,
  stripe_payment_intent_id text unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

alter table public.pending_mobile_orders enable row level security;
revoke all on table public.pending_mobile_orders from anon, authenticated;
grant select, insert, update, delete on table public.pending_mobile_orders to service_role;

create index if not exists pending_mobile_orders_expires_idx
  on public.pending_mobile_orders(expires_at);

commit;
