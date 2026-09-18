alter table public.orders
  add column if not exists shipping_company text,
  add column if not exists tracking_number text,
  add column if not exists admin_note text;

grant update (status, shipping_company, tracking_number, admin_note)
  on table public.orders to authenticated;

comment on column public.orders.shipping_company is 'Carrier selected by AJLIB staff.';
comment on column public.orders.tracking_number is 'Shipment tracking number visible to the customer.';
comment on column public.orders.admin_note is 'Private operational note for AJLIB staff.';
