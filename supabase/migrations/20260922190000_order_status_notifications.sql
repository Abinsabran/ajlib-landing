-- Customer status changes are queued atomically with the order update. Existing
-- orders are not backfilled: only INSERTs/real status transitions after this
-- migration create events. Raw fulfillment states never enter these tables.
alter table public.profiles add column if not exists preferred_language text;
alter table public.profiles drop constraint if exists profiles_preferred_language_check;
alter table public.profiles add constraint profiles_preferred_language_check check (preferred_language in ('ar', 'en'));
-- Existing profile writes are column-scoped so the client needs only this
-- additional field; it never receives permission to change role or user_id.
grant update (preferred_language) on table public.profiles to authenticated;

create table if not exists public.order_notifications (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  customer_status text not null check (customer_status in ('ORDER_RECEIVED','PREPARING_ORDER','PREPARING_SHIPMENT','SHIPPED','DELIVERED')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (order_id, customer_status)
);

create table if not exists public.order_notification_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  customer_status text not null check (customer_status in ('ORDER_RECEIVED','PREPARING_ORDER','PREPARING_SHIPMENT','SHIPPED','DELIVERED')),
  channel text not null check (channel in ('email','push')),
  state text not null default 'pending' check (state in ('pending','sending','sent','failed','indeterminate')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  leased_until timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  unique (order_id, customer_status, channel)
);

create table if not exists public.order_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists order_push_tokens_user_enabled_idx on public.order_push_tokens(user_id) where enabled;
create index if not exists order_notification_events_due_idx on public.order_notification_events(next_attempt_at,created_at) where state in ('pending','failed');

create table if not exists public.order_push_deliveries (
  event_id uuid not null references public.order_notification_events(id) on delete cascade,
  token_id uuid not null references public.order_push_tokens(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','sent','failed','indeterminate')),
  ticket_id text,
  receipt_checked_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  primary key (event_id,token_id)
);

alter table public.order_notifications enable row level security;
alter table public.order_notification_events enable row level security;
alter table public.order_push_tokens enable row level security;
alter table public.order_push_deliveries enable row level security;
revoke all on public.order_notifications, public.order_notification_events, public.order_push_tokens, public.order_push_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.order_notifications, public.order_notification_events, public.order_push_tokens, public.order_push_deliveries to service_role;

create or replace function public.customer_safe_order_status(p_status text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case p_status
    when 'paid' then 'ORDER_RECEIVED'
    when 'processing' then 'PREPARING_ORDER'
    when 'packed' then 'PREPARING_SHIPMENT'
    when 'shipped' then 'SHIPPED'
    when 'delivered' then 'DELIVERED'
    else null end
$$;
revoke all on function public.customer_safe_order_status(text) from public, anon, authenticated;

create or replace function public.queue_order_status_notification()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
  v_user_id uuid;
begin
  v_status := public.customer_safe_order_status(new.status);
  if v_status is null or (tg_op = 'UPDATE' and public.customer_safe_order_status(old.status) is not distinct from v_status) then
    return new;
  end if;
  v_user_id := new.user_id;
  if v_user_id is null then
    select u.id into v_user_id from auth.users u
      where u.email_confirmed_at is not null and lower(trim(u.email)) = lower(trim(new.customer_email))
      order by u.created_at limit 1;
  end if;
  insert into public.order_notifications(order_id,user_id,customer_status)
    values (new.id,v_user_id,v_status) on conflict (order_id,customer_status) do nothing;
  insert into public.order_notification_events(order_id,customer_status,channel)
    values (new.id,v_status,'email'),(new.id,v_status,'push')
    on conflict (order_id,customer_status,channel) do nothing;
  return new;
end $$;
-- A replayed paid webhook upserts status='paid'. It must not move an already
-- preparing/shipped order backwards (nor create a false customer transition).
create or replace function public.preserve_order_status_on_payment_replay()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status='paid' and old.status in ('processing','packed','shipped','delivered') then
    new.status := old.status;
  end if;
  return new;
end $$;
drop trigger if exists orders_preserve_status_on_payment_replay on public.orders;
create trigger orders_preserve_status_on_payment_replay before update of status on public.orders
  for each row execute function public.preserve_order_status_on_payment_replay();
drop trigger if exists orders_queue_status_notification on public.orders;
create trigger orders_queue_status_notification after insert or update of status on public.orders
  for each row execute function public.queue_order_status_notification();

create or replace function public.register_order_push_token(p_token text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_token !~ '^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{15,200}\]$' then raise exception 'Invalid Expo push token'; end if;
  insert into public.order_push_tokens(user_id,token) values(auth.uid(),p_token)
    on conflict(token) do update set user_id=auth.uid(),enabled=true,last_seen_at=now()
    where public.order_push_tokens.user_id=auth.uid() or public.order_push_tokens.enabled=false;
  -- A token still owned by another signed-in account cannot be silently
  -- reassigned. That account must unlink it on logout first.
  if not found then raise exception 'Push token belongs to another active account'; end if;
end $$;
create or replace function public.unregister_order_push_token(p_token text)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.order_push_tokens set enabled=false where user_id=auth.uid() and token=p_token
$$;
revoke all on function public.register_order_push_token(text), public.unregister_order_push_token(text) from public, anon;
grant execute on function public.register_order_push_token(text), public.unregister_order_push_token(text) to authenticated;

create or replace function public.my_order_notifications()
returns table(id uuid,order_number text,customer_status text,created_at timestamptz,read_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select n.id,o.order_number,n.customer_status,n.created_at,n.read_at
  from public.order_notifications n join public.orders o on o.id=n.order_id
  join auth.users u on u.id=auth.uid()
  where o.user_id=u.id or (o.user_id is null and u.email_confirmed_at is not null
    and lower(trim(o.customer_email))=lower(trim(u.email)))
  order by n.created_at desc limit 100
$$;
create or replace function public.mark_order_notification_read(p_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.order_notifications n set read_at=coalesce(n.read_at,now())
  from public.orders o join auth.users u on u.id=auth.uid()
  where n.id=p_id and n.order_id=o.id
    and (o.user_id=u.id or (o.user_id is null and u.email_confirmed_at is not null
      and lower(trim(o.customer_email))=lower(trim(u.email))));
  return found;
end $$;
revoke all on function public.my_order_notifications(), public.mark_order_notification_read(uuid) from public, anon;
grant execute on function public.my_order_notifications(), public.mark_order_notification_read(uuid) to authenticated;

-- Even if tracking was entered early by an operator, customer history must
-- hide it until the actual customer-safe SHIPPED/DELIVERED stage.
create or replace function public.my_orders()
returns table (
  order_number text, items jsonb, amount_total integer, currency text,
  status text, shipping_company text, tracking_number text,
  created_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp as $$
  with me as (
    select u.id,
      case when u.email_confirmed_at is not null then lower(trim(u.email)) end as verified_email
    from auth.users u where u.id=auth.uid()
  )
  select o.order_number,o.items,o.amount_total,o.currency,o.status,
    case when o.status in ('shipped','delivered') then o.shipping_company else null end,
    case when o.status in ('shipped','delivered') then o.tracking_number else null end,
    o.created_at,o.updated_at
  from public.orders o,me
  where o.user_id=me.id or (o.user_id is null and me.verified_email is not null
    and o.customer_email is not null and lower(trim(o.customer_email))=me.verified_email)
  order by o.created_at desc
$$;
revoke all on function public.my_orders() from public, anon;
grant execute on function public.my_orders() to authenticated;

-- Called only by the server with the service credential. SKIP LOCKED plus the
-- unique event key prevents overlapping cron invocations from double claiming.
create or replace function public.claim_order_notification_events(p_limit integer default 20)
returns setof public.order_notification_events
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service only'; end if;
  return query
    with due as (
      select id from public.order_notification_events
      where (state in ('pending','failed') and next_attempt_at<=now())
         or (state='sending' and leased_until<now() and channel='email')
      order by created_at limit least(greatest(p_limit,1),50) for update skip locked
    )
    update public.order_notification_events e
       set state='sending',attempts=e.attempts+1,leased_until=now()+interval '5 minutes'
      from due where e.id=due.id returning e.*;
end $$;
revoke all on function public.claim_order_notification_events(integer) from public, anon, authenticated;
grant execute on function public.claim_order_notification_events(integer) to service_role;
