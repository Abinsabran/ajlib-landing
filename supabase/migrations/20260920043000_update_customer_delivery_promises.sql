-- Customer-facing delivery promises approved 2026-09-19.
-- Shipping fees remain governed exclusively by api/_lib/shipping-policy.js.
-- This table supplies delivery windows to quotes and the fulfillment route
-- compatibility filter; no pricing, route-preference or provider rule changes.

update public.shipping_zones
   set name_ar = 'الإمارات العربية المتحدة',
       country_codes = array['AE'],
       min_days = 7,
       max_days = 14,
       updated_at = now()
 where code = 'AE';

update public.shipping_zones
   set name_ar = 'المملكة العربية السعودية',
       country_codes = array['SA'],
       min_days = 7,
       max_days = 14,
       updated_at = now()
 where code = 'GCC';

insert into public.shipping_zones
  (code, name_ar, country_codes, amount, currency, min_days, max_days, active, sort_order, updated_at)
values
  ('GCC_EXTENDED', 'الكويت وقطر والبحرين', array['KW','QA','BH'], 4500, 'aed', 10, 18, true, 25, now())
on conflict (code) do update set
  name_ar = excluded.name_ar,
  country_codes = excluded.country_codes,
  min_days = excluded.min_days,
  max_days = excluded.max_days,
  active = true,
  sort_order = excluded.sort_order,
  updated_at = now();

update public.shipping_zones
   set min_days = 7,
       max_days = 14,
       updated_at = now()
 where code in ('AMERICAS', 'OCEANIA');
