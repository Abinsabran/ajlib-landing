import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import handler, { verifyZiinaWebhook } from '../api/ziina.js';
import { paymentAmounts } from '../api/_lib/payment-currency.js';
import { computeProductPricing } from '../api/_lib/pricing.js';
import { paymentFeeUSD, aedToUsd, evaluateFulfillmentMargin } from '../api/_lib/cj-fulfillment.js';

const PAYMENT_ID = 'f7ecf271-f071-4e19-a1b0-628c43bd8889';
const OPERATION_ID = '7cc0f607-099b-44fa-9d57-8b363081f654';
const env = async (values, run) => {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try { return await run(); }
  finally { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; }
};
const response = () => ({
  statusCode: null, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  setHeader() {}
});
const order = (currency = 'aed') => ({
  id: 'AJ12345678', payment_currency: currency,
  customer: { email: 'buyer@example.com', name: 'Buyer', phone: '+971501234567', country_code: 'AE', country_name: 'UAE', city: 'Dubai', address: '1 Test Street' },
  cart: { items: Array.from({ length: 5 }, () => ({ color: 'أسود', size: 'L' })) },
  product_price: 1, shipping: 1, total: 1 // malicious client values are ignored
});

test('Ziina is hidden by default, including when a key exists', async () => {
  await env({ ZIINA_ENABLED: 'false', ZIINA_API_KEY: 'dummy', SUPABASE_URL: 'https://example.invalid', SUPABASE_SECRET_KEY: 'dummy' }, async () => {
    const availability = await handler({ method: 'GET', query: { action: 'availability' }, headers: {} }, response());
    assert.deepEqual(availability.body, { available: false });
    const checkout = await handler({ method: 'POST', query: { action: 'checkout' }, headers: {}, body: order() }, response());
    assert.equal(checkout.statusCode, 503);
  });
});

test('owner rollout refuses anonymous users before quote, reservation, or Ziina API', async () => {
  const before = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected'); };
  try {
    await env({ ZIINA_ENABLED: 'true', ZIINA_ROLLOUT: 'owner', ZIINA_API_KEY: 'dummy', ZIINA_WEBHOOK_SECRET: 'dummy', SUPABASE_URL: 'https://example.invalid', SUPABASE_SECRET_KEY: 'dummy', SUPABASE_PUBLISHABLE_KEY: 'dummy' }, async () => {
      const checkout = await handler({ method: 'POST', query: { action: 'checkout' }, headers: {}, body: order() }, response());
      assert.equal(checkout.statusCode, 403);
      assert.equal(calls, 0);
    });
  } finally { globalThis.fetch = before; }
});

test('AED/USD intents use only server quote and preserve a unique local reservation', async () => {
  for (const currency of ['aed', 'usd']) {
    const calls = []; let reserveCount = 0;
    const before = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const path = String(url); calls.push({ path, options });
      if (path.includes('/rest/v1/rpc/check_inventory')) return { ok: true, json: async () => [] };
      if (path.includes('/rest/v1/shipping_zones')) return { ok: true, json: async () => [] };
      if (path.includes('/rest/v1/ziina_payment_attempts?select=id') && options.method === 'POST') {
        reserveCount++;
        return reserveCount === 1 ? { ok: true, status: 201, json: async () => [{ id: 'reservation-1' }] } : { ok: false, status: 409 };
      }
      if (path.includes('/rest/v1/ziina_payment_attempts?id=')) return { ok: true };
      if (path.endsWith('/payment_intent') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return { ok: true, json: async () => ({ id: PAYMENT_ID, operation_id: OPERATION_ID, redirect_url: 'https://example.ziina.com/checkout', amount: body.amount, currency_code: body.currency_code }) };
      }
      throw new Error(`Unexpected request ${path}`);
    };
    try {
      await env({ ZIINA_ENABLED: 'true', ZIINA_ROLLOUT: 'public', ZIINA_API_KEY: 'dummy', ZIINA_WEBHOOK_SECRET: 'dummy', ZIINA_TEST_MODE: 'true', SUPABASE_URL: 'https://example.invalid', SUPABASE_SECRET_KEY: 'dummy', ZIINA_RETURN_ORIGIN: 'https://www.ajlib.store' }, async () => {
        const first = await handler({ method: 'POST', query: { action: 'checkout' }, headers: {}, body: order(currency) }, response());
        assert.equal(first.statusCode, 200);
        assert.equal(first.body.id, PAYMENT_ID);
        const productFils = computeProductPricing(5).productAmount;
        const expected = paymentAmounts({ productAmountFils: productFils, shippingAmountFils: 0, currency });
        const ziinaBody = JSON.parse(calls.find(c => c.path.endsWith('/payment_intent')).options.body);
        assert.equal(ziinaBody.amount, expected.total);
        assert.equal(ziinaBody.currency_code, currency.toUpperCase());
        assert.equal(ziinaBody.test, true);
        assert.equal(ziinaBody.allow_tips, false);
        assert.match(ziinaBody.success_url, /\{PAYMENT_INTENT_ID\}/);
        const reservation = JSON.parse(calls.find(c => c.path.includes('ziina_payment_attempts?select=id')).options.body);
        assert.equal(reservation.canonical_total_aed, productFils);
        assert.equal(reservation.amount, expected.total);
        assert.equal(reservation.order_snapshot.metadata.product_amount, String(productFils));
        assert.equal(reservation.order_snapshot.metadata.shipping_amount, '0');
        const second = await handler({ method: 'POST', query: { action: 'checkout' }, headers: {}, body: order(currency) }, response());
        assert.equal(second.statusCode, 409);
        assert.equal(calls.filter(c => c.path.endsWith('/payment_intent') && c.options.method === 'POST').length, 1);
      });
    } finally { globalThis.fetch = before; }
  }
});

test('unsupported currency and invalid quantity fail before any Ziina payment intent', async () => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('unexpected'); };
  try {
    await env({ ZIINA_ENABLED: 'true', ZIINA_ROLLOUT: 'public', ZIINA_API_KEY: 'dummy', ZIINA_WEBHOOK_SECRET: 'dummy', SUPABASE_URL: 'https://example.invalid', SUPABASE_SECRET_KEY: 'dummy' }, async () => {
      const badCurrency = await handler({ method: 'POST', query: { action: 'checkout' }, headers: {}, body: order('eur') }, response());
      assert.equal(badCurrency.statusCode, 400);
      const tooFew = order(); tooFew.cart.items = tooFew.cart.items.slice(0, 4);
      const badQuantity = await handler({ method: 'POST', query: { action: 'checkout' }, headers: {}, body: tooFew }, response());
      assert.equal(badQuantity.statusCode, 400);
      assert.equal(calls.length, 0);
    });
  } finally { globalThis.fetch = before; }
});

test('signed webhook requires Ziina IP and raw-body HMAC; invalid requests are rejected', () => {
  const raw = Buffer.from('{"event":"payment_intent.status.updated","data":{"id":"x"}}');
  const secret = 'not-a-real-webhook-secret';
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifyZiinaWebhook(raw, signature, secret, '3.29.184.186'), true);
  assert.equal(verifyZiinaWebhook(raw, signature, secret, '203.0.113.1'), false);
  assert.equal(verifyZiinaWebhook(Buffer.from('altered'), signature, secret, '3.29.184.186'), false);
});

test('Ziina conservative fee applies base, one 1.5% surcharge, and VAT only to fee', () => {
  const aed = 129;
  const expected = aedToUsd((aed * .041 + 1) * 1.05);
  assert.ok(Math.abs(paymentFeeUSD({ amountCollectedFils: 12900, provider: 'ziina' }) - expected) < 1e-10);
  assert.ok(Math.abs(paymentFeeUSD({ amountCollectedFils: 12900, provider: 'ziina', international: true, currencyConversion: true }) - expected) < 1e-10);
});

test('Ziina fulfillment blocks without AED settlement and uses the lower real revenue', () => {
  const base = { productAmountCollectedFils: 13500, shippingAmountCollectedFils: 0, cjProductCostUSD: 1, cjShippingCostUSD: 1, unitCount: 5, provider: 'ziina' };
  assert.equal(evaluateFulfillmentMargin(base).reason, 'ZIINA_SETTLEMENT_UNAVAILABLE');
  const lower = evaluateFulfillmentMargin({ ...base, providerSettledAmountAedFils: 12000 });
  const higher = evaluateFulfillmentMargin({ ...base, providerSettledAmountAedFils: 15000 });
  assert.equal(lower.details.collectedAed, 120);
  assert.equal(higher.details.collectedAed, 135);
  assert.ok(higher.details.breakdown.paymentFeeUSD > lower.details.breakdown.paymentFeeUSD);
});

test('completed intent is re-fetched, persisted once, and a repeated verification has no duplicate side effects', async () => {
  const before = globalThis.fetch; const calls = []; let state = 'ready';
  const snapshot = {
    customer_email: 'buyer@example.com',
    metadata: {
      order_id: 'AJ12345678', items: 'أسود-L:5', customer_name: 'Buyer', phone: '+971501234567',
      country_code: 'AE', country_name: 'UAE', city: 'Dubai', street: '1 Test Street',
      address: '1 Test Street, Dubai, UAE', product_amount: '13500', shipping_amount: '0',
      canonical_total_aed: '13500', user_id: ''
    }
  };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url); calls.push({ path, options });
    if (path.includes('ziina_payment_attempts?provider_payment_id=')) return { ok: true, json: async () => [{ id: 'reservation-1', order_number: 'AJ12345678', provider_payment_id: PAYMENT_ID, provider_operation_id: OPERATION_ID, amount: 13500, currency: 'aed', canonical_total_aed: 13500, state, is_test: false, order_snapshot: snapshot }] };
    if (path.includes('ziina_payment_attempts?id=') && options.method === 'PATCH') { state = JSON.parse(options.body).state; return { ok: true }; }
    if (path.endsWith(`/payment_intent/${PAYMENT_ID}`)) return { ok: true, json: async () => ({ id: PAYMENT_ID, operation_id: OPERATION_ID, amount: 13500, currency_code: 'AED', status: 'completed', created_at: '1780000000000', fee_amount: 470, settled: { amount: 13400, currency_code: 'AED' } }) };
    if (path.includes('/rest/v1/orders?') && options.method === 'POST') return { ok: true, text: async () => JSON.stringify([{ id: 'order-uuid-1', order_number: 'AJ12345678', fulfillment_status: 'READY_FOR_CJ', shipping_country_code: 'AE' }]) };
    if (path.includes('/rest/v1/rpc/process_paid_inventory')) return { ok: true, json: async () => ({}) };
    if (path.includes('/rest/v1/shipping_zones')) return { ok: true, json: async () => [] };
    if (path.includes('api.resend.com/emails')) return { ok: true };
    throw new Error(`Unexpected request ${path}`);
  };
  try {
    await env({ ZIINA_API_KEY: 'dummy', SUPABASE_URL: 'https://example.invalid', SUPABASE_SECRET_KEY: 'dummy', RESEND_API_KEY: 'dummy', CJ_AUTO_CREATE_ENABLED: '' }, async () => {
      const req = { method: 'GET', query: { action: 'verify', payment_intent_id: PAYMENT_ID }, headers: {} };
      const first = await handler(req, response());
      assert.equal(first.statusCode, 200); assert.equal(first.body.paid, true);
      const saved = JSON.parse(calls.find(c => c.path.includes('/rest/v1/orders?') && c.options.method === 'POST').options.body);
      assert.equal(saved.canonical_total_aed, 13500);
      assert.equal(saved.paid_currency, 'aed');
      assert.equal(saved.paid_amount, 13500);
      assert.equal(saved.payment_provider, 'ziina');
      assert.equal(saved.provider_payment_id, PAYMENT_ID);
      assert.equal(saved.provider_settled_amount_aed, 13400);
      const second = await handler(req, response());
      assert.equal(second.body.paid, true);
      assert.equal(calls.filter(c => c.path.includes('/rest/v1/orders?') && c.options.method === 'POST').length, 1);
      assert.equal(calls.filter(c => c.path.includes('api.resend.com/emails')).length, 1);
      assert.equal(calls.filter(c => c.path.includes('/rest/v1/rpc/process_paid_inventory')).length, 1);
      assert.equal(calls.filter(c => c.path.includes('createOrderV2')).length, 0);
    });
  } finally { globalThis.fetch = before; }
});

test('failed, canceled and pending intents cannot create orders; a success URL alone does nothing', async () => {
  const before = globalThis.fetch;
  for (const status of ['failed', 'canceled', 'pending']) {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const path = String(url); calls.push(path);
      if (path.includes('ziina_payment_attempts?provider_payment_id=')) return { ok: true, json: async () => [{ id: 'reservation-1', order_number: 'AJ12345678', provider_payment_id: PAYMENT_ID, provider_operation_id: OPERATION_ID, amount: 13500, currency: 'aed', canonical_total_aed: 13500, state: 'ready', is_test: false, order_snapshot: {} }] };
      if (path.endsWith(`/payment_intent/${PAYMENT_ID}`)) return { ok: true, json: async () => ({ id: PAYMENT_ID, operation_id: OPERATION_ID, amount: 13500, currency_code: 'AED', status }) };
      if (path.includes('ziina_payment_attempts?id=') && options.method === 'PATCH') return { ok: true };
      throw new Error(`Unexpected request ${path}`);
    };
    await env({ ZIINA_API_KEY: 'dummy', SUPABASE_URL: 'https://example.invalid', SUPABASE_SECRET_KEY: 'dummy' }, async () => {
      const result = await handler({ method: 'GET', query: { action: 'verify', payment_intent_id: PAYMENT_ID }, headers: {} }, response());
      assert.equal(result.statusCode, 200); assert.equal(result.body.paid, false); assert.equal(result.body.status, status);
      assert.equal(calls.some(c => c.includes('/rest/v1/orders')), false);
    });
  }
  globalThis.fetch = before;
});

test('Ziina key and provider internals are never embedded in customer storefront or mobile app', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const mobile = await readFile(new URL('../../../outputs/ajlib-mobile-build21/App.js', import.meta.url), 'utf8');
  for (const text of [html, mobile]) {
    for (const name of ['ZIINA_API_KEY', 'ZIINA_WEBHOOK_SECRET', 'provider_fee_amount', 'provider_operation_id']) assert.equal(text.includes(name), false);
  }
});
