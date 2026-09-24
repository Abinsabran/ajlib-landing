-- Ziina checkout is opt-in and server-only. Store the authoritative quote and
-- customer details before contacting Ziina so a signed webhook can complete
-- the existing paid-order pipeline without trusting a browser return.
-- A unique AJLIB number reserves one payment attempt, including during an
-- uncertain provider response: never create a second charge by retrying.
create table if not exists public.ziina_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  provider_payment_id text unique,
  provider_operation_id text unique,
  state text not null default 'creating' check (state in ('creating','ready','indeterminate','completed','failed','canceled')),
  currency text not null check (currency in ('aed','usd')),
  amount integer not null check (amount > 0),
  canonical_total_aed integer not null check (canonical_total_aed > 0),
  is_test boolean not null default false,
  order_snapshot jsonb not null,
  redirect_url text,
  provider_fee_amount integer,
  provider_fee_currency text,
  provider_settled_amount_aed integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ziina_payment_attempts_state_idx
  on public.ziina_payment_attempts(state, created_at);

alter table public.ziina_payment_attempts enable row level security;
revoke all on public.ziina_payment_attempts from public, anon, authenticated;
grant select, insert, update on public.ziina_payment_attempts to service_role;

-- Internal metadata remains inaccessible to customers. Existing Stripe and
-- Tabby orders retain NULL in these new columns and their original keys.
alter table public.orders
  add column if not exists payment_provider text,
  add column if not exists provider_payment_id text,
  add column if not exists provider_operation_id text,
  add column if not exists provider_status text,
  add column if not exists provider_fee_amount integer,
  add column if not exists provider_fee_currency text,
  add column if not exists provider_settled_amount_aed integer;

create unique index if not exists orders_provider_payment_unique
  on public.orders(payment_provider, provider_payment_id)
  where payment_provider is not null and provider_payment_id is not null;
