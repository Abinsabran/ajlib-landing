import { quoteShipping } from './shipping-quote.js';
import { computeProductPricing, MIN_QUANTITY, MAX_QUANTITY } from '../lib/pricing.js';
import { PRODUCTS } from '../lib/catalog.js';
import { COUNTRY_CURRENCY, currencyForCountry, convertAedFilsForDisplay } from '../lib/currency.js';
import { isTabbyPotentiallyAvailable } from '../lib/tabby-client.js';

// Grouped, provider-neutral handler for the foundation endpoints added
// alongside the existing per-feature functions (checkout-session.js,
// shipping-quote.js, etc). Vercel's Hobby plan caps a project at 12
// Serverless Functions — each file under api/ is one function — so
// order-quote/catalog/currency/tabby-availability are dispatched from this
// single file instead of 4 separate ones. vercel.json rewrites keep their
// public URLs exactly the same (this matters most for /api/order-quote,
// which the already-shipped Expo app is hardcoded to call).
//
// Nothing about pricing, shipping, quantity limits, or Stripe checkout is
// touched by this file — see api/checkout-session.js, api/shipping-quote.js
// and lib/pricing.js, all unchanged.

const RESOURCE_BY_PATH = {
  '/api/order-quote': 'order-quote',
  '/api/catalog': 'catalog',
  '/api/currency': 'currency',
  '/api/tabby-availability': 'tabby-availability'
};

const resolveResource = (req) => {
  if (req.query?.resource) return String(req.query.resource);
  const pathname = String(req.url || '').split('?')[0];
  return RESOURCE_BY_PATH[pathname] || null;
};

// ---- order-quote -----------------------------------------------------

const shippingFallbackZones = [
  { code: 'AE', country_codes: ['AE'] },
  { code: 'GCC', country_codes: ['SA', 'BH', 'KW', 'OM', 'QA'] },
  { code: 'MENA', country_codes: ['DZ', 'EG', 'IQ', 'JO', 'LB', 'LY', 'MA', 'PS', 'SD', 'SY', 'TN', 'YE'] },
  { code: 'EUROPE', country_codes: 'AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM TR UA VA'.split(' ') },
  { code: 'ASIA', country_codes: 'AF AM AZ BD BN BT CN GE HK ID IN JP KG KH KP KR KZ LA LK MM MN MO MV MY NP PH PK SG TH TJ TL TM TW UZ VN'.split(' ') },
  { code: 'AFRICA', country_codes: 'AO BF BI BJ BW CD CF CG CI CM CV DJ ER ET GA GH GM GN GQ GW KE KM LR LS MG ML MR MU MW MZ NA NE NG RE RW SC SH SL SN SO SS ST SZ TD TG TZ UG YT ZA ZM ZW'.split(' ') },
  { code: 'AMERICAS', country_codes: 'AG AI AR AW BB BL BM BO BQ BR BS BZ CA CL CO CR CU CW DM DO EC FK GD GF GL GP GS GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PM PR PY SR SV SX TC TT US UY VC VE VG VI'.split(' ') },
  { code: 'OCEANIA', country_codes: 'AS AU CC CK CX FJ FM GU HM KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS'.split(' ') }
];

const listSupportedCountries = async () => {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/shipping_zones?select=code,country_codes&active=eq.true`, {
      headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
    });
    if (response.ok) {
      const rows = await response.json();
      if (Array.isArray(rows) && rows.length) return [...new Set(rows.flatMap(row => row.country_codes || []))];
    }
  }
  return [...new Set(shippingFallbackZones.flatMap(zone => zone.country_codes))];
};

const quoteMessages = {
  INVALID_QUANTITY: { ar: 'أدخل كمية صحيحة (عدد صحيح فقط)', en: 'Enter a valid whole-number quantity' },
  MINIMUM_QUANTITY: { ar: `الحد الأدنى للطلب ${MIN_QUANTITY} قطعة`, en: `Minimum order is ${MIN_QUANTITY} piece(s)` },
  MAXIMUM_QUANTITY: { ar: `الحد الأقصى للطلب ${MAX_QUANTITY} قطعة`, en: `Maximum order is ${MAX_QUANTITY} pieces` }
};

const quoteFail = (res, language, code, arMessage) => {
  const known = quoteMessages[code];
  const message_ar = known ? known.ar : arMessage;
  const message_en = known ? known.en : arMessage;
  return res.status(400).json({ code, error: language === 'en' ? message_en : message_ar, message_ar, message_en });
};

const handleOrderQuote = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const source = req.method === 'GET' ? req.query : (req.body || {});
    const language = source.language === 'en' ? 'en' : 'ar';
    const countryCode = String(source.country ?? source.country_code ?? '').trim().toUpperCase();
    const quantity = Number(source.quantity);

    if (!Number.isInteger(quantity)) return quoteFail(res, language, 'INVALID_QUANTITY');
    if (quantity < MIN_QUANTITY) return quoteFail(res, language, 'MINIMUM_QUANTITY');
    if (quantity > MAX_QUANTITY) return quoteFail(res, language, 'MAXIMUM_QUANTITY');

    let shipping;
    try {
      shipping = await quoteShipping(countryCode);
    } catch (error) {
      return quoteFail(res, language, 'UNSUPPORTED_SHIPPING_COUNTRY', error.message);
    }

    const { unitPrice, productAmount } = computeProductPricing(quantity);
    const supportedCountries = await listSupportedCountries();

    return res.status(200).json({
      country: countryCode,
      shippingCountry: countryCode,
      quantity,
      currency: shipping.currency,
      unitPrice: Math.round(unitPrice * 100),
      productSubtotal: productAmount,
      shipping: shipping.amount,
      total: productAmount + shipping.amount,
      isFreeShipping: shipping.amount === 0,
      minDays: shipping.min_days,
      maxDays: shipping.max_days,
      zoneCode: shipping.zone_code,
      zoneName: shipping.zone_name,
      dutiesIncluded: shipping.duties_included,
      supportedCountries
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'تعذر حساب السعر' });
  }
};

// ---- catalog -----------------------------------------------------------

const handleCatalog = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  return res.status(200).json({ products: PRODUCTS.filter(p => p.active) });
};

// ---- currency ------------------------------------------------------------

const handleCurrency = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const countryCode = String(req.query.country_code || '').trim().toUpperCase();
  const amountFils = Number(req.query.amount_fils);

  if (!countryCode) return res.status(200).json({ countries: COUNTRY_CURRENCY });

  const currency = currencyForCountry(countryCode);
  if (!currency) return res.status(400).json({ error: 'دولة غير مدعومة لعرض العملة' });

  if (!Number.isFinite(amountFils)) return res.status(200).json({ country_code: countryCode, currency });

  const display = convertAedFilsForDisplay(amountFils, currency);
  return res.status(200).json({ country_code: countryCode, currency, amount_aed: amountFils / 100, display_amount: display, display_is_estimate: currency !== 'AED' });
};

// ---- tabby-availability ----------------------------------------------

const handleTabbyAvailability = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const countryCode = String(req.query.country_code || '').trim().toUpperCase();
  const amountFils = Number(req.query.amount_fils);
  const currency = currencyForCountry(countryCode) || 'AED';

  const available = isTabbyPotentiallyAvailable({ countryCode, currency, amountFils });
  return res.status(200).json({ available, currency, mode: process.env.TABBY_MODE || 'disabled' });
};

const HANDLERS = {
  'order-quote': handleOrderQuote,
  catalog: handleCatalog,
  currency: handleCurrency,
  'tabby-availability': handleTabbyAvailability
};

export default async function handler(req, res) {
  const resource = resolveResource(req);
  const resourceHandler = resource && HANDLERS[resource];
  if (!resourceHandler) return res.status(404).json({ error: 'Unknown resource' });
  return resourceHandler(req, res);
}
