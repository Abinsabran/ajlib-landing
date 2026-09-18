-- Approved: correct the stale UAE delivery window, then grant the server
-- read access — in that order, within one transaction, so the stale row is
-- never authoritative.
-- that `supabase db push` CANNOT pick it up by accident. Rename it to a
-- proper <timestamp>_name.sql only after approval.
--
-- ============================================================
-- WHY THE GRANT MUST NOT BE APPLIED ON ITS OWN
-- ============================================================
-- api/shipping-quote.js prefers the shipping_zones table whenever it can
-- read it, and falls back to its hardcoded list otherwise. Today the server
-- (service_role) is denied on that table, so the FALLBACK is what customers
-- actually get — which is why the approved 7-14 day UAE promise is live.
--
-- Verified contents of public.shipping_zones (read-only, 9 rows, all active).
-- Every zone matches the code fallback EXCEPT the AE delivery window:
--
--   zone      db amount   db days     code fallback days
--   AE        0 fils      1-3         7-14   <-- CONFLICT
--   GCC       4500        3-6         3-6    (match)
--   MENA      7500        5-10        5-10   (match)
--   EUROPE    11000       6-12        6-12   (match)
--   ASIA      12000       7-14        7-14   (match)
--   AFRICA    13500       8-16        8-16   (match)
--   AMERICAS  15000       8-16        8-16   (match)
--   OCEANIA   17000       9-18        9-18   (match)
--   WORLD     19000       10-21       10-21  (match)
--
-- So granting SELECT alone would make the stale DB row authoritative and
-- SILENTLY REVERT the UAE promise from the approved 7-14 back to 1-3 days —
-- a promise no available CJ route can meet. The data must be corrected in
-- the same transaction as the grant, never after it.
--
-- service_role has rolbypassrls = true, so a plain GRANT SELECT is
-- sufficient; the "Public reads active shipping zones" RLS policy does not
-- need changing.
--
-- ============================================================
-- STEP 1 — correct the stale AE delivery window
-- ============================================================
-- Touches ONE row and TWO columns. No pricing change: amount stays 0 (UAE
-- shipping remains free, as approved). Rollback is exact:
--   update public.shipping_zones set min_days = 1, max_days = 3 where code = 'AE';

update public.shipping_zones
   set min_days = 7,
       max_days = 14
 where code = 'AE'
   and (min_days is distinct from 7 or max_days is distinct from 14);

-- ============================================================
-- STEP 2 — least-privilege read access for the server
-- ============================================================
-- SELECT only. The server never writes shipping zones; the admin console
-- does that through the existing authenticated/is_admin policy.

grant select on table public.shipping_zones to service_role;

-- ============================================================
-- POST-APPLY VERIFICATION
-- ============================================================
--   select code, amount, min_days, max_days, active
--     from public.shipping_zones where code = 'AE';
--     -> expect 0 / 7 / 14 / true
--
--   GET /api/order-quote?quantity=5&country=AE
--     -> expect total 13500, minDays 7, maxDays 14 (unchanged from today,
--        proving the DB now agrees with the fallback rather than fighting it)
--
--   GET /api/order-quote?quantity=10&country=SA
--     -> expect total 31400, zoneCode GCC, shipping 4500 (unchanged)
