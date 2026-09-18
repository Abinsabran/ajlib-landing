import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import checkoutSession from '../api/checkout-session.js';
import webhook, { settledOrderAmount } from '../api/stripe-webhook.js';

// Apple Pay on Stripe's hosted Checkout showed "Pay Ajlib $419.00" for an
// AED 419 order after the customer switched Adaptive Pricing's currency
// toggle back to AED: the AED amount paired with the USD currency code. The
// fix: every Stripe object AJLIB creates is priced in AED only, with Adaptive
// Pricing switched off per session, so there is no currency toggle and no
// wallet can be handed a different currency. These tests pin exactly what we
// send to Stripe (fetch is mocked; nothing reaches Stripe or charges a card).

const US_10_UNITS_AED_FILS = 41900; // 269 AED product + 150 AED US shipping
const PRODUCT_FILS = 26900;
const SHIPPING_FILS = 15000;

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
  return res;
};

const usOrder = (extra = {}) => ({
  id: 'AJ-CURRENCY-TEST',
  customer: { email: 'buyer@example.com', name: 'Test Buyer', phone: '+15555550100', country_code: 'US', country_name: 'United States', region: 'CA', city: 'Lake Forest', address: '1 Test St', postal_code: '92630' },
  cart: { items: Array.from({ length: 10 }, (_, i) => ({ color: 'أسود', size: i < 5 ? 'L' : 'XL' })) },
  ...extra
});

// Captures the form body of each Stripe call and answers like Stripe would.
const captureStripe = async (order) => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = new URLSearchParams(String(options.body || ''));
    calls.push({ url: String(url), body });
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

test('web Checkout Session: AED line items totalling AED 419, Adaptive Pricing off', async () => {
  const { res, calls } = await captureStripe(usOrder());
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.ok(calls[0].url.endsWith('/v1/checkout/sessions'));
  assert.equal(body.get('adaptive_pricing[enabled]'), 'false', 'no local-currency toggle, so no wallet currency mismatch');
  assert.equal(body.get('line_items[0][price_data][currency]'), 'aed');
  assert.equal(body.get('line_items[1][price_data][currency]'), 'aed');
  assert.equal(Number(body.get('line_items[0][price_data][unit_amount]')), PRODUCT_FILS);
  assert.equal(Number(body.get('line_items[1][price_data][unit_amount]')), SHIPPING_FILS);
  assert.equal(Number(body.get('line_items[0][price_data][unit_amount]')) + Number(body.get('line_items[1][price_data][unit_amount]')), US_10_UNITS_AED_FILS);
  assert.equal(body.get('currency'), null, 'currency comes only from the AED line items');
});

test('app PaymentIntent (PaymentSheet / Apple Pay in the app): AED 41900', async () => {
  const { res, calls } = await captureStripe(usOrder({ mobile: true }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/v1/payment_intents'));
  assert.equal(calls[0].body.get('currency'), 'aed');
  assert.equal(Number(calls[0].body.get('amount')), US_10_UNITS_AED_FILS);
});

test('no path sends USD or any non-AED currency to Stripe, so USD 419 cannot be produced', async () => {
  for (const order of [usOrder(), usOrder({ mobile: true }), usOrder({ currency: 'usd' }), usOrder({ mobile: true, currency: 'usd' })]) {
    const { calls } = await captureStripe(order);
    for (const { body } of calls) {
      for (const [key, value] of body) {
        if (/currency\]?$/.test(key)) assert.equal(value, 'aed', `${key} must be aed`);
        assert.doesNotMatch(String(value), /^usd$/i, `${key} must not be usd`);
      }
    }
  }
});

test('the AED order amount is recorded in AED, never a USD presentment amount', () => {
  // Current Stripe API: the session keeps the integration currency.
  assert.deepEqual(settledOrderAmount({ amount_total: 41900, currency: 'aed', presentment_details: { presentment_amount: 11861, presentment_currency: 'usd' } }), { amount_total: 41900, currency: 'aed' });
  // Older API versions: presentment currency on the session, AED under currency_conversion.
  assert.deepEqual(settledOrderAmount({ amount_total: 11861, currency: 'usd', currency_conversion: { amount_total: 41900, amount_subtotal: 41900, source_currency: 'aed', fx_rate: '0.2831' } }), { amount_total: 41900, currency: 'aed' });
  assert.deepEqual(settledOrderAmount({ amount_total: 41900, currency: 'aed' }), { amount_total: 41900, currency: 'aed' });
});

// ---- webhook persistence ----------------------------------------------------

const WEBHOOK_SECRET = 'whsec_test_secret';
const sign = (payload) => {
  const timestamp = Math.floor(Date.now() / 1000);
  return `t=${timestamp},v1=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex')}`;
};

const deliver = async (sessionOverrides) => {
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {
    id: 'cs_web_currency_1', payment_status: 'paid', client_reference_id: 'AJ-CURRENCY-TEST',
    metadata: { order_id: 'AJ-CURRENCY-TEST', items: 'أسود-L:5,أسود-XL:5', product_amount: String(PRODUCT_FILS), shipping_amount: String(SHIPPING_FILS), shipping_zone: 'AMERICAS', country_code: 'US' },
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

test('webhook records the paid AED 419 order as amount 41900 / aed (card or Apple Pay alike)', async () => {
  const { order, emailHtml } = await deliver({ amount_total: 41900, currency: 'aed' });
  assert.equal(order.amount_total, 41900);
  assert.equal(order.currency, 'aed');
  assert.equal(order.product_amount, PRODUCT_FILS);
  assert.equal(order.shipping_amount, SHIPPING_FILS);
  assert.match(emailHtml, /419/);
});

test('webhook still records AED 41900 if Stripe reports a USD presentment on the session', async () => {
  const { order } = await deliver({ amount_total: 11861, currency: 'usd', currency_conversion: { amount_total: 41900, amount_subtotal: 41900, source_currency: 'aed', fx_rate: '0.2831' } });
  assert.equal(order.amount_total, 41900);
  assert.equal(order.currency, 'aed');
});
