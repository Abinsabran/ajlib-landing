import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import checkoutSession from '../api/checkout-session.js';
import commerce from '../api/commerce.js';
import webhook, { settledOrderAmount, orderAmountFields } from '../api/stripe-webhook.js';
import { aedFilsToUsdCents, paymentAmounts, parsePaymentCurrency, AED_TO_USD_RATE } from '../api/_lib/payment-currency.js';
import { SHIPPING_COUNTRIES } from '../api/_lib/markets.js';

// AJLIB-controlled payment currency. The customer picks AED or USD on
// AJLIB's checkout BEFORE any Stripe object exists; the server converts the
// canonical AED total and creates a Stripe Checkout Session (or app
// PaymentIntent) in exactly that one currency, with Adaptive Pricing OFF.
// Stripe's hosted page has no currency toggle, so card, Apple Pay, Google Pay
// and Link can only ever see that session's single currency and amounts —
// which these tests pin by capturing exactly what is sent to Stripe (fetch is
// mocked; nothing reaches Stripe and no card is charged).

// US, 10 pieces: 269 AED product + 20 AED shipping = 289 AED.
const PRODUCT_FILS = 26900;
const SHIPPING_FILS = 2000;
const TOTAL_FILS = 28900;
// 289 x 0.2723 = 78.6947 -> USD 78.69; shipping 20 x 0.2723 = 5.446 -> 5.45.
const TOTAL_USD_CENTS = 7869;
const SHIPPING_USD_CENTS = 545;

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
};

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
};

const orderFor = (countryCode, quantity, extra = {}) => ({
  id: 'AJ-CURRENCY-TEST',
  customer: { email: 'buyer@example.com', name: 'Test Buyer', phone: '+15555550100', country_code: countryCode, country_name: countryCode, region: 'CA', city: 'Lake Forest', address: '1 Test St', postal_code: '92630' },
  cart: { items: Array.from({ length: quantity }, (_, i) => ({ color: 'أسود', size: i % 2 ? 'XL' : 'L' })) },
  ...extra
});
const usOrder = (extra) => orderFor('US', 10, extra);

// Captures the form body of each Stripe call and answers like Stripe would.
const captureStripe = async (order) => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(options.body || '')) });
    if (String(url).endsWith('/checkout/sessions')) return { ok: true, json: async () => ({ id: 'cs_test_x', url: 'https://checkout.stripe.com/c/pay/cs_test_x' }) };
    if (String(url).endsWith('/payment_intents')) return { ok: true, json: async () => ({ id: 'pi_test_x', client_secret: 'pi_test_x_secret' }) };
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  try {
    const res = await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PUBLISHABLE_KEY: 'pk_test_x', SUPABASE_URL: '', SUPABASE_SECRET_KEY: '' },
      () => checkoutSession({ method: 'POST', body: order, headers: { host: 'www.ajlib.store' } }, makeRes()));
    return { res, calls };
  } finally { globalThis.fetch = original; }
};

// Every currency Stripe will charge in (line items / the intent), not metadata.
const currencyValues = (body) => [...body].filter(([key]) => !key.startsWith('metadata[') && /currency\]?$/.test(key)).map(([, value]) => value);
const lineTotal = (body) => Number(body.get('line_items[0][price_data][unit_amount]')) + Number(body.get('line_items[1][price_data][unit_amount]') || 0);

// ---- conversion -------------------------------------------------------------------

test('server conversion: approved rate 0.2723, exact cents, rounded half-up', () => {
  assert.equal(AED_TO_USD_RATE, 0.2723);
  assert.equal(aedFilsToUsdCents(28900), 7869); // 78.6947
  assert.equal(aedFilsToUsdCents(30900), 8414); // 84.1407
  assert.equal(aedFilsToUsdCents(13500), 3676); // 36.7605
  assert.equal(aedFilsToUsdCents(0), 0);
  // A value that lands exactly on half a cent rounds up.
  const half = Array.from({ length: 10000 }, (_, i) => i).find(f => (f * 2723) % 10000 === 5000);
  assert.equal(aedFilsToUsdCents(half), Math.floor(half * 2723 / 10000) + 1);
  assert.throws(() => aedFilsToUsdCents(1.5));
  assert.throws(() => aedFilsToUsdCents(-1));
});

test('the USD lines add up to exactly the converted AED total', () => {
  const usd = paymentAmounts({ productAmountFils: PRODUCT_FILS, shippingAmountFils: SHIPPING_FILS, currency: 'usd' });
  assert.deepEqual(usd, { currency: 'usd', product: TOTAL_USD_CENTS - SHIPPING_USD_CENTS, shipping: SHIPPING_USD_CENTS, total: TOTAL_USD_CENTS, canonicalTotalAed: TOTAL_FILS, fxRate: 0.2723 });
  const aed = paymentAmounts({ productAmountFils: PRODUCT_FILS, shippingAmountFils: SHIPPING_FILS, currency: 'aed' });
  assert.deepEqual(aed, { currency: 'aed', product: PRODUCT_FILS, shipping: SHIPPING_FILS, total: TOTAL_FILS, canonicalTotalAed: TOTAL_FILS, fxRate: 1 });
});

test('only aed and usd are accepted; missing means AED', () => {
  assert.equal(parsePaymentCurrency(undefined), 'aed');
  assert.equal(parsePaymentCurrency(''), 'aed');
  assert.equal(parsePaymentCurrency('USD'), 'usd');
  for (const bad of ['eur', 'sar', 'us', 42, 'aed ; usd']) assert.throws(() => parsePaymentCurrency(bad), String(bad));
});

// ---- Stripe Checkout Session -----------------------------------------------------

test('AED selected: Checkout Session is AED 289 in every line, Adaptive Pricing off', async () => {
  const { res, calls } = await captureStripe(usOrder({ payment_currency: 'aed' }));
  assert.equal(res.statusCode, 200);
  const body = calls[0].body;
  assert.ok(calls[0].url.endsWith('/v1/checkout/sessions'));
  assert.equal(body.get('adaptive_pricing[enabled]'), 'false');
  assert.deepEqual(currencyValues(body), ['aed', 'aed']);
  assert.equal(Number(body.get('line_items[0][price_data][unit_amount]')), PRODUCT_FILS);
  assert.equal(Number(body.get('line_items[1][price_data][unit_amount]')), SHIPPING_FILS);
  assert.equal(lineTotal(body), TOTAL_FILS);
  assert.equal(body.get('metadata[payment_currency]'), 'aed');
  assert.equal(body.get('metadata[payment_amount]'), String(TOTAL_FILS));
  assert.equal(body.get('metadata[canonical_total_aed]'), String(TOTAL_FILS));
});

test('no currency chosen (older clients, the app) means AED', async () => {
  const { calls } = await captureStripe(usOrder());
  assert.deepEqual(currencyValues(calls[0].body), ['aed', 'aed']);
  assert.equal(lineTotal(calls[0].body), TOTAL_FILS);
});

test('USD selected: Checkout Session is USD 78.69 — the converted amount, never USD 289', async () => {
  const { res, calls } = await captureStripe(usOrder({ payment_currency: 'usd' }));
  assert.equal(res.statusCode, 200);
  const body = calls[0].body;
  assert.equal(body.get('adaptive_pricing[enabled]'), 'false');
  assert.deepEqual(currencyValues(body), ['usd', 'usd']);
  assert.equal(Number(body.get('line_items[1][price_data][unit_amount]')), SHIPPING_USD_CENTS);
  assert.equal(lineTotal(body), TOTAL_USD_CENTS);
  assert.notEqual(lineTotal(body), TOTAL_FILS, 'USD must never carry the AED number');
  // Canonical AED economics travel with the payment for the webhook and CJ.
  assert.equal(body.get('metadata[product_amount]'), String(PRODUCT_FILS));
  assert.equal(body.get('metadata[shipping_amount]'), String(SHIPPING_FILS));
  assert.equal(body.get('metadata[canonical_total_aed]'), String(TOTAL_FILS));
  assert.equal(body.get('metadata[payment_currency]'), 'usd');
  assert.equal(body.get('metadata[payment_amount]'), String(TOTAL_USD_CENTS));
});

test('app PaymentIntent (PaymentSheet / Apple Pay in the app) follows the same model', async () => {
  const aed = await captureStripe(usOrder({ mobile: true }));
  assert.ok(aed.calls[0].url.endsWith('/v1/payment_intents'));
  assert.equal(aed.calls[0].body.get('currency'), 'aed');
  assert.equal(Number(aed.calls[0].body.get('amount')), TOTAL_FILS);
  const usd = await captureStripe(usOrder({ mobile: true, payment_currency: 'usd' }));
  assert.equal(usd.calls[0].body.get('currency'), 'usd');
  assert.equal(Number(usd.calls[0].body.get('amount')), TOTAL_USD_CENTS);
});

test('the client cannot set or override any amount — only name the currency', async () => {
  const forged = usOrder({ payment_currency: 'usd', amount: 1, payment_amount: 1, total: 1, usd_amount: 1, paymentOptions: { usd: { currency: 'usd', amount: 1 } } });
  const { calls } = await captureStripe(forged);
  assert.equal(lineTotal(calls[0].body), TOTAL_USD_CENTS);
  const { res, calls: none } = await captureStripe(usOrder({ payment_currency: 'eur' }));
  assert.equal(res.statusCode, 400);
  assert.equal(none.length, 0, 'an unsupported currency never reaches Stripe');
});

test('no path produces an AED number under USD or a USD number under AED (all markets, all tiers)', async () => {
  for (const country of SHIPPING_COUNTRIES) {
    for (const quantity of [5, 10, 15, 20, 50, 12]) {
      for (const currency of ['aed', 'usd']) {
        for (const mobile of [false, true]) {
          const { res, calls } = await captureStripe(orderFor(country, quantity, { payment_currency: currency, mobile }));
          assert.equal(res.statusCode, 200, `${country}/${quantity}/${currency}`);
          const body = calls[0].body;
          const canonical = Number(body.get('metadata[canonical_total_aed]'));
          const charged = mobile ? Number(body.get('amount')) : lineTotal(body);
          const currencies = mobile ? [body.get('currency')] : currencyValues(body);
          assert.ok(currencies.every(c => c === currency), `${country}/${quantity}/${currency}: ${currencies}`);
          assert.equal(charged, currency === 'aed' ? canonical : aedFilsToUsdCents(canonical), `${country}/${quantity}/${currency}`);
          if (!mobile) assert.equal(body.get('adaptive_pricing[enabled]'), 'false');
        }
      }
    }
  }
});

test('the amounts shown before payment are exactly the amounts sent to Stripe', async () => {
  const quote = await withEnv({ SUPABASE_URL: '', SUPABASE_SECRET_KEY: '' }, () => commerce({ method: 'GET', query: { resource: 'order-quote', quantity: '10', country: 'US' } }, makeRes()));
  assert.equal(quote.body.total, TOTAL_FILS);
  assert.deepEqual(quote.body.paymentOptions, { aed: { currency: 'aed', amount: TOTAL_FILS }, usd: { currency: 'usd', amount: TOTAL_USD_CENTS }, fxRate: 0.2723 });
  for (const currency of ['aed', 'usd']) {
    const { calls } = await captureStripe(usOrder({ payment_currency: currency }));
    assert.equal(lineTotal(calls[0].body), quote.body.paymentOptions[currency].amount, currency);
  }
});

// ---- website ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('website: AED | USD selector near the summary; totals and USD come from the server; only the currency is sent', () => {
  assert.match(html, /<legend>عملة الدفع<\/legend>/);
  assert.match(html, /name=\\?"payment_currency\\?" value=\\?"aed\\?"/);
  assert.match(html, /name=\\?"payment_currency\\?" value=\\?"usd\\?"/);
  // Both equivalents and an explicit "you will be charged" line.
  assert.match(html, /سيتم الدفع:/);
  assert.match(html, /paymentQuote\.paymentOptions\[cur\]/);
  assert.match(html, /paymentQuote\.paymentOptions\[other\]/);
  // Totals and the USD amount are the server quote's, never computed in the browser.
  assert.match(html, /async function fetchPaymentQuote\(code\)\{[^}]*\/api\/order-quote\?quantity=/);
  assert.doesNotMatch(html, /\* ?0\.2723|0\.2723 ?\*/);
  // Both Stripe submissions send the chosen currency and no amount.
  const submits = [...html.matchAll(/JSON\.stringify\(\{id,customer:data,cart,payment_currency:data\.payment_currency==='usd'\?'usd':'aed'\}\)/g)];
  assert.equal(submits.length, 2);
  assert.ok(!html.includes('amount:cart.pack.p,customer:data'));
});

// ---- webhook persistence ---------------------------------------------------------------

const WEBHOOK_SECRET = 'whsec_test_secret';
const sign = (payload) => {
  const timestamp = Math.floor(Date.now() / 1000);
  return `t=${timestamp},v1=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex')}`;
};

const deliver = async (sessionOverrides, metadataOverrides = {}) => {
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {
    id: 'cs_web_currency_1', payment_status: 'paid', client_reference_id: 'AJ-CURRENCY-TEST',
    metadata: { order_id: 'AJ-CURRENCY-TEST', items: 'أسود-L:5,أسود-XL:5', product_amount: String(PRODUCT_FILS), shipping_amount: String(SHIPPING_FILS), shipping_zone: 'AMERICAS', country_code: 'US', ...metadataOverrides },
    customer_details: { email: 'buyer@example.com' }, payment_intent: 'pi_web_currency_1', created: Math.floor(Date.now() / 1000),
    ...sessionOverrides
  } } });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'email_1' }) };
    if (String(url).includes('/rest/v1/orders') && options.method === 'POST') return { ok: true, text: async () => JSON.stringify([{ id: 'order-uuid-1', order_number: 'AJ-CURRENCY-TEST' }]) };
    if (String(url).includes('/rpc/process_paid_inventory')) return { ok: true, json: async () => ({}) };
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };
  try {
    await withEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, RESEND_API_KEY: 'resend_test', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service_role_test', CJ_AUTO_CREATE_ENABLED: '' }, () =>
      webhook({ method: 'POST', headers: { 'stripe-signature': sign(payload) }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); } }, makeRes()));
  } finally { globalThis.fetch = original; }
  const save = calls.find(c => c.url.includes('/rest/v1/orders') && c.options.method === 'POST');
  const email = calls.find(c => c.url.includes('api.resend.com'));
  return { order: JSON.parse(save.options.body), emailHtml: JSON.parse(email.options.body).html };
};

test('webhook, AED payment: canonical AED 289 and paid AED 289', async () => {
  const { order, emailHtml } = await deliver({ amount_total: TOTAL_FILS, currency: 'aed' });
  assert.equal(order.amount_total, TOTAL_FILS);
  assert.equal(order.currency, 'aed');
  assert.equal(order.canonical_total_aed, TOTAL_FILS);
  assert.equal(order.paid_currency, 'aed');
  assert.equal(order.paid_amount, TOTAL_FILS);
  assert.equal(order.product_amount, PRODUCT_FILS);
  assert.equal(order.shipping_amount, SHIPPING_FILS);
  assert.match(emailHtml, /289/);
});

test('webhook, USD payment: canonical AED 289 kept for revenue and CJ; paid USD 78.69 recorded', async () => {
  const { order, emailHtml } = await deliver({ amount_total: TOTAL_USD_CENTS, currency: 'usd' }, { payment_currency: 'usd', payment_amount: String(TOTAL_USD_CENTS), canonical_total_aed: String(TOTAL_FILS) });
  assert.equal(order.amount_total, TOTAL_FILS, 'amount_total stays the canonical AED total');
  assert.equal(order.currency, 'aed');
  assert.equal(order.canonical_total_aed, TOTAL_FILS);
  assert.equal(order.paid_currency, 'usd');
  assert.equal(order.paid_amount, TOTAL_USD_CENTS);
  assert.equal(order.product_amount, PRODUCT_FILS, 'CJ profitability reads canonical AED');
  assert.equal(order.shipping_amount, SHIPPING_FILS);
  assert.match(emailHtml, /78\.69/);
});

test('webhook amounts for older payment shapes stay correct', () => {
  // No amount metadata (a payment from before it existed): the AED charge is canonical.
  assert.deepEqual(orderAmountFields({ amount_total: 41900, currency: 'aed', metadata: {} }), { amount_total: 41900, currency: 'aed', canonical_total_aed: 41900, paid_currency: 'aed', paid_amount: 41900 });
  // Older Adaptive Pricing shape: presentment on the session, AED under currency_conversion.
  assert.deepEqual(settledOrderAmount({ amount_total: 11861, currency: 'usd', currency_conversion: { amount_total: 41900, source_currency: 'aed' }, metadata: {} }), { amount_total: 41900, currency: 'aed' });
  // Current Adaptive Pricing shape: integration currency on the session, presentment alongside.
  assert.deepEqual(orderAmountFields({ amount_total: 41900, currency: 'aed', presentment_details: { presentment_amount: 11861, presentment_currency: 'usd' }, metadata: { product_amount: '26900', shipping_amount: '15000' } }),
    { amount_total: 41900, currency: 'aed', canonical_total_aed: 41900, paid_currency: 'usd', paid_amount: 11861 });
});
