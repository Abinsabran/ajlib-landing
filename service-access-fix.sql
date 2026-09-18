-- Server-side AJLIB APIs use the Supabase service role. These explicit grants
-- complement RLS bypass and keep public/anonymous access disabled.
begin;

grant usage on schema public to service_role;
grant select, update on table public.profiles to service_role;
grant select, update on table public.addresses to service_role;
grant select, update on table public.inventory to service_role;
grant select, insert, update, delete on table public.pending_mobile_orders to service_role;

commit;
