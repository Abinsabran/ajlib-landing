import { isShippingCountry } from './_lib/markets.js';
import { shippingFeeFils } from './_lib/shipping-policy.js';

// IMPORTANT: these are only a FALLBACK. getZones() below prefers the
// shipping_zones table whenever Supabase is reachable, so in Preview AND in
// Production the customer-facing delivery window actually comes from the
// DATABASE. Changing AE to 7-14 here therefore does NOT by itself change
// what customers are shown — the shipping_zones row must be updated too,
// and that table is shared with Production.
const fallbackZones = [
  // APPROVED: 7-14 business days, which is what CJ's real route aging
  // supports (the AE routes actually selected are 7-10 and 7-11 days). The
  // previous 1-3 day window was not achievable by any available CJ route.
  { code: 'AE', name_ar: 'الإمارات العربية المتحدة', country_codes: ['AE'], amount: 0, min_days: 7, max_days: 14 },
  { code: 'GCC', name_ar: 'دول مجلس التعاون الخليجي', country_codes: ['SA','BH','KW','OM','QA'], amount: 4500, min_days: 3, max_days: 6 },
  { code: 'MENA', name_ar: 'الشرق الأوسط وشمال أفريقيا', country_codes: ['DZ','EG','IQ','JO','LB','LY','MA','PS','SD','SY','TN','YE'], amount: 7500, min_days: 5, max_days: 10 },
  { code: 'EUROPE', name_ar: 'أوروبا', country_codes: 'AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM TR UA VA'.split(' '), amount: 11000, min_days: 6, max_days: 12 },
  { code: 'ASIA', name_ar: 'آسيا', country_codes: 'AF AM AZ BD BN BT CN GE HK ID IN JP KG KH KP KR KZ LA LK MM MN MO MV MY NP PH PK SG TH TJ TL TM TW UZ VN'.split(' '), amount: 12000, min_days: 7, max_days: 14 },
  { code: 'AFRICA', name_ar: 'أفريقيا', country_codes: 'AO BF BI BJ BW CD CF CG CI CM CV DJ ER ET GA GH GM GN GQ GW KE KM LR LS MG ML MR MU MW MZ NA NE NG RE RW SC SH SL SN SO SS ST SZ TD TG TZ UG YT ZA ZM ZW'.split(' '), amount: 13500, min_days: 8, max_days: 16 },
  { code: 'AMERICAS', name_ar: 'الأمريكيتان والكاريبي', country_codes: 'AG AI AR AW BB BL BM BO BQ BR BS BZ CA CL CO CR CU CW DM DO EC FK GD GF GL GP GS GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PM PR PY SR SV SX TC TT US UY VC VE VG VI'.split(' '), amount: 15000, min_days: 8, max_days: 16 },
  { code: 'OCEANIA', name_ar: 'أستراليا ونيوزيلندا وجزر المحيط الهادئ', country_codes: 'AS AU CC CK CX FJ FM GU HM KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS'.split(' '), amount: 17000, min_days: 9, max_days: 18 },
  { code: 'WORLD', name_ar: 'الشحن الدولي', country_codes: [], amount: 19000, min_days: 10, max_days: 21 }
];

const getZones = async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return fallbackZones;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/shipping_zones?select=code,name_ar,country_codes,amount,currency,min_days,max_days,active,sort_order&active=eq.true&order=sort_order`, {
    headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
  });
  if (!response.ok) return fallbackZones;
  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows : fallbackZones;
};

// The customer's shipping FEE comes from the approved quantity ladder
// (api/_lib/shipping-policy.js); the delivery window still comes from the
// destination's shipping zone. A quote with no quantity (fulfillment only
// needs the delivery window) carries amount: null rather than a guess.
export const quoteShipping = async (countryCode, quantity) => {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error('اختر دولة التوصيل');
  // Approved markets only (api/_lib/markets.js) — enforced here, server-side.
  if (!isShippingCountry(code)) throw new Error('الشحن إلى هذه الدولة غير متاح حاليًا');
  let amount = null;
  if (quantity !== undefined) {
    amount = shippingFeeFils(code, Number(quantity));
    if (amount == null) throw new Error('أدخل كمية صحيحة');
  }
  const zones = await getZones();
  const zone = zones.find(item => Array.isArray(item.country_codes) && item.country_codes.includes(code)) || zones.find(item => item.code === 'WORLD');
  if (!zone || zone.active === false) throw new Error('الشحن إلى هذه الدولة غير متاح حاليًا');
  return { country_code: code, zone_code: zone.code, zone_name: zone.name_ar, amount, currency: 'aed', min_days: Number(zone.min_days), max_days: Number(zone.max_days), duties_included: false };
};

export default async function handler(req, res) {
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const source = req.method === 'GET' ? req.query : (req.body || {});
    // The fee depends on the quantity, so a quote without one is refused.
    const quantity = Number(source.quantity);
    if (!Number.isInteger(quantity)) throw new Error('أدخل كمية صحيحة');
    const quote = await quoteShipping(source.country_code, quantity);
    return res.status(200).json(quote);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'تعذر حساب الشحن' });
  }
}
