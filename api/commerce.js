import { quoteShipping } from './shipping-quote.js';
import { computeProductPricing, MIN_QUANTITY, MAX_QUANTITY } from './_lib/pricing.js';
import { PRODUCTS } from './_lib/catalog.js';
import { COUNTRY_CURRENCY, currencyForCountry, convertAedFilsForDisplay } from './_lib/currency.js';
import { isTabbyPotentiallyAvailable, createCheckoutSession, verifyPayment } from './_lib/tabby-client.js';
import { buildValidatedOrder, OrderValidationError } from './_lib/order-validation.js';
import { persistPaidOrder } from './stripe-webhook.js';
import { handleAdminFulfillment } from './_lib/admin-fulfillment.js';

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
// and api/_lib/pricing.js, all unchanged.

const RESOURCE_BY_PATH = {
  '/api/order-quote': 'order-quote',
  '/api/catalog': 'catalog',
  '/api/currency': 'currency',
  '/api/tabby-availability': 'tabby-availability',
  '/api/admin-fulfillment': 'admin-fulfillment'
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

// ---- tabby-checkout (server-side session creation, test mode only) -----

const buildTabbyOrderPayload = (validated, order) => ({
  reference_id: String(order.id),
  items: validated.requestedItems.map(i => ({
    title: i.variant,
    quantity: i.quantity,
    unit_price: ((validated.productAmount / validated.quantity) / 100).toFixed(2),
    category: 'clothing'
  }))
});

const handleTabbyCheckout = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (process.env.TABBY_MODE !== 'test') return res.status(503).json({ error: 'الدفع عبر Tabby غير مفعّل بعد' });
  const order = req.body || {};
  try {
    const accessToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const validated = await buildValidatedOrder(order, { accessToken });
    const amountFils = validated.productAmount + validated.shipping.amount;

    // Provider-neutral: if Tabby isn't eligible for this basket/country,
    // report that cleanly so the caller keeps Stripe as the usable path —
    // this never blocks or breaks the Stripe checkout flow.
    if (!isTabbyPotentiallyAvailable({ countryCode: validated.countryCode, currency: 'AED', amountFils })) {
      return res.status(200).json({ provider: 'tabby', available: false, reason: 'INELIGIBLE' });
    }

    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const session = await createCheckoutSession({
      orderId: order.id,
      amountFils,
      currency: 'AED',
      buyer: {
        name: String(validated.customer.name || ''),
        email: validated.customerEmail,
        phone: String(validated.customer.phone || '')
      },
      order: buildTabbyOrderPayload(validated, order),
      shippingAddress: {
        city: String(validated.customer.city || ''),
        address: String(validated.customer.address || ''),
        zip: String(validated.customer.postal_code || '')
      },
      successUrl: `${origin}/?tabby=success&order_id=${encodeURIComponent(order.id)}`,
      cancelUrl: `${origin}/?tabby=cancelled&order_id=${encodeURIComponent(order.id)}`,
      failureUrl: `${origin}/?tabby=failed&order_id=${encodeURIComponent(order.id)}`
    });

    const webUrl = session?.configuration?.available_products?.installments?.[0]?.web_url || null;
    if (!webUrl) return res.status(200).json({ provider: 'tabby', available: false, reason: 'NO_CHECKOUT_URL' });

    // session.id is the checkout/session id; session.payment.id is the
    // distinct payment id required by GET /payments/{id} for verification
    // (confirmed against a real Preview sandbox session — they are NOT the
    // same value). Returning the wrong one silently breaks verification.
    return res.status(200).json({ provider: 'tabby', available: true, paymentId: session.payment?.id, checkoutUrl: webUrl, status: session.status });
  } catch (error) {
    if (error instanceof OrderValidationError) return res.status(error.status).json({ error: error.message });
    return res.status(502).json({ error: 'تعذر بدء الدفع عبر Tabby' });
  }
};

// ---- tabby-verify (server-side payment verification, mandatory before

const ACCEPTED_TABBY_STATUSES = new Set(['CLOSED', 'AUTHORIZED']);

// Tabby's created_at is ISO-8601 ("2026-09-18T00:48:37Z"). Returns epoch
// seconds, or null for anything missing or unparseable — never a fabricated
// "now", which is exactly what made paid_at drift.
export const tabbyTimestampToEpochSeconds = (value) => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

const handleTabbyVerify = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (process.env.TABBY_MODE !== 'test') return res.status(503).json({ error: 'الدفع عبر Tabby غير مفعّل بعد' });
  const { payment_id: paymentId, order } = req.body || {};
  if (!paymentId) return res.status(400).json({ error: 'معرّف الدفع مطلوب' });
  try {
    const accessToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const validated = await buildValidatedOrder(order || {}, { accessToken });
    const expectedAmountFils = validated.productAmount + validated.shipping.amount;

    // Server-side truth. A success redirect alone never marks an order paid.
    const payment = await verifyPayment(paymentId);
    const paidAmountFils = Math.round(Number(payment.amount || 0) * 100);

    if (!ACCEPTED_TABBY_STATUSES.has(payment.status)) {
      return res.status(402).json({ error: 'لم يكتمل الدفع عبر Tabby بعد', status: payment.status });
    }
    // Never trust the client's claimed total — cross-check Tabby's own
    // recorded amount against our independently recomputed authoritative one.
    if (paidAmountFils !== expectedAmountFils) {
      return res.status(409).json({ error: 'مبلغ الدفع لا يطابق قيمة الطلب' });
    }

    const normalized = {
      id: `tabby_${payment.id}`, // reused as the generic provider-payment-reference dedup key (see persistPaidOrder)
      metadata: {
        order_id: String(order?.id || ''),
        items: validated.itemSummary,
        customer_name: String(validated.customer.name || ''),
        phone: String(validated.customer.phone || ''),
        address_id: String(validated.customer.address_id || ''),
        country_code: validated.countryCode,
        country_name: String(validated.customer.country_name || ''),
        region: String(validated.customer.region || ''),
        // Same structured-city requirement as the Stripe path — both
        // providers must persist it identically (see api/checkout-session.js).
        city: String(validated.customer.city || ''),
        postal_code: String(validated.customer.postal_code || ''),
        address: `${validated.customer.address || ''}${validated.customer.address_line2 ? `, ${validated.customer.address_line2}` : ''}, ${validated.customer.city || ''}, ${validated.customer.region || ''}, ${validated.customer.country_name || validated.countryCode}, ${validated.customer.postal_code || ''}`,
        notes: String(validated.customer.notes || ''),
        product_amount: String(validated.productAmount),
        shipping_amount: String(validated.shipping.amount),
        shipping_zone: validated.shipping.zone_code,
        user_id: validated.userId,
        preorder: (validated.preorders || []).map(x => `${x.variant}:${x.preorder_eta || 'سيحدد لاحقًا'}`).join(',')
      },
      customer_details: null,
      customer_email: validated.customerEmail,
      amount_total: paidAmountFils,
      currency: String(payment.currency || 'aed').toLowerCase(),
      payment_intent: `tabby_${payment.id}`,
      // Anchored to Tabby's own payment timestamp, never to the verification
      // time. Previously this was Date.now(), so every re-verification (and
      // the upsert's merge-duplicates) rewrote paid_at to "now". Null when
      // Tabby gives no parseable timestamp — saveOrder then omits paid_at
      // entirely, so an existing value is preserved rather than overwritten.
      created: tabbyTimestampToEpochSeconds(payment.createdAt)
    };

    // persistPaidOrder's saveOrder now throws unless PostgREST hands back an
    // actual persisted row for this dedup key (see api/stripe-webhook.js) —
    // {paid:true} below is only reachable once that row is confirmed to exist.
    // Returns the persisted row itself. Fulfillment preparation has already
    // run inside persistPaidOrder by this point — the same shared call the
    // Stripe webhook makes, so Tabby carries no fulfillment logic of its own.
    const savedOrderRow = await persistPaidOrder(normalized);
    if (!savedOrderRow?.id) {
      throw new Error('Order persistence unconfirmed after upsert');
    }
    return res.status(200).json({ paid: true, order_id: normalized.metadata.order_id });
  } catch (error) {
    if (error instanceof OrderValidationError) return res.status(error.status).json({ error: error.message });
    return res.status(502).json({ error: 'تعذر التحقق من الدفع عبر Tabby' });
  }
};

// cj-diagnostic, tabby-diagnostic and tabby-verify-diagnostic (used to
// confirm CJ's real variant data and Tabby's real sandbox request/response
// shapes during Phase 2 — including catching that session.id and
// session.payment.id are different values) have all been removed now that
// they've served their purpose. rawCjGet/tabbyDiagnosticPost/tabbyRawGet
// remain in api/_lib/ for any future re-sync need.

// Phase 3 discovery diagnostics (cj-auth-diagnostic, cj-diagnostic) have
// been removed now that they confirmed: no AJLIB store product exists yet
// (shop/product/queryPage -> total:0) and no product connection exists yet
// (product/conn/connection -> total:0). See the Phase 3 report for the full
// documented endpoint/payload reference this discovery produced.

// Phase 3 continuation diagnostics (cj-warehouse-diagnostic,
// cj-stock-diagnostic, cj-freight-diagnostic) have been removed now that
// they confirmed: areaId 1 = China (live, matches docs); this product's
// stock exists ONLY in China (no other warehouse listed for our vids); and
// the real logistics methods valid across all 8 supported destinations via
// GET .../logistic/freightCalculate. See the Phase 3 report for the data.

// Phase 3 quantity-scaled freight diagnostic (cj-freight-diagnostic) has
// been removed now that it confirmed, across all 8 supported destinations
// at real order quantities (5/10/15/20/50): CJPacket Postal is only
// available at qty 5-10 and disappears everywhere at qty>=15; DHL Official
// is available at every quantity for every destination. See the Phase 3
// report for the full 8x5 matrix.

// Shop-list diagnostic (cj-shops-diagnostic) removed now that it resolved
// AJLIB_DEFAULT_SHOP_ID (see api/_lib/cj-store-connection.js) via GET
// /shop/getShops: two "api"-type shops exist; the one named exactly "AJLIB"
// (id 2609160939212912600) is used, distinguished from the other entry
// which carries a stray leading Arabic diacritic in its name.

// The one-time CJ API-store connection execution (Save Product -> Save
// Variant Batch -> Create Product Connection) has been run successfully and
// removed from this file. Result: saveProduct result:true; 16/16 variants
// saveSuccess:true; createConnection data:true. Verified via the documented
// read-only GET /product/conn/connection: 16/16 connections exist, each with
// shopId 2609160939212912600, platformProductId
// ajlib-ice-silk-boxer-briefs, cjProductId 1581871544228392960, and the
// correct cjVariantId per api/_lib/cj-variant-map.js. No CJ order was created; no
// packaging/sticker endpoint was ever called. api/_lib/cj-client.js's
// saveStoreProduct/saveStoreVariantBatch/createProductConnection/
// queryProductConnections remain available for any future re-sync need.

// ---- TEMPORARY read-only route probe (UAE 5/10, US 10). REMOVE this round ----
// Preview only. Freight calculation + the real selection policy; nothing else.
const ROUTE_PROBE_MIX = { ae5: [['أسود-L', 5]], ae10: null, us10: null };
const FIRST_ORDER_MIX = [['أسود-L', 2], ['أسود-XL', 2], ['كحلي-L', 1], ['كحلي-XL', 1], ['رمادي-L', 1], ['رمادي-XL', 1], ['أبيض-L', 1], ['أبيض-XL', 1]];
const handleRouteProbe = async (req, res) => {
  if (process.env.VERCEL_ENV !== 'preview') return res.status(404).json({ error: 'Unknown resource' });
  const { calculateFreight } = await import('./_lib/cj-client.js');
  const { resolveFulfillmentVariants } = await import('./_lib/cj-fulfillment.js');
  const { selectLogisticsMethod, maxAgingDays } = await import('./_lib/logistics-policy.js');
  const scenario = String(req.query.scenario || '');
  if (!(scenario in ROUTE_PROBE_MIX)) return res.status(400).json({ error: 'scenario must be ae5, ae10 or us10' });
  const country = scenario.startsWith('us') ? 'US' : 'AE';
  const mix = ROUTE_PROBE_MIX[scenario] || FIRST_ORDER_MIX;
  const { resolved, fullyResolved, unresolved } = resolveFulfillmentVariants(mix.map(([variant, quantity]) => ({ variant, quantity })));
  if (!fullyResolved) return res.status(400).json({ error: 'unresolved', unresolved });
  try {
    const zone = await quoteShipping(country);
    const freight = await calculateFreight({ startCountryCode: 'CN', endCountryCode: country, products: resolved.map(r => ({ vid: r.cjVariantId, quantity: r.quantity })) });
    const body = freight.body || {};
    return res.status(200).json({
      scenario, country, units: resolved.reduce((s, r) => s + r.quantity, 0),
      resolved: resolved.map(r => ({ variant: r.variant, vid: r.cjVariantId, quantity: r.quantity })),
      promise: { min: zone.min_days, max: zone.max_days },
      cjCode: body.code ?? null, cjMessage: Number(body.code) === 200 ? undefined : body.message,
      methods: Array.isArray(body.data) ? body.data.map(m => ({ logisticName: m.logisticName, logisticAging: m.logisticAging, totalPostageFee: m.totalPostageFee ?? m.logisticPrice })) : [],
      selection: selectLogisticsMethod(body.data || [], { countryCode: country, maxDeliveryDays: zone.max_days })
    });
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error).slice(0, 200) });
  }
};

const HANDLERS = {
  'route-probe': handleRouteProbe,
  'order-quote': handleOrderQuote,
  catalog: handleCatalog,
  currency: handleCurrency,
  'tabby-availability': handleTabbyAvailability,
  'tabby-checkout': handleTabbyCheckout,
  'tabby-verify': handleTabbyVerify,
  // Admin-only (is_admin() checked inside, before any order is read).
  'admin-fulfillment': handleAdminFulfillment
};

export default async function handler(req, res) {
  const resource = resolveResource(req);
  const resourceHandler = resource && HANDLERS[resource];
  if (!resourceHandler) return res.status(404).json({ error: 'Unknown resource' });
  return resourceHandler(req, res);
}
