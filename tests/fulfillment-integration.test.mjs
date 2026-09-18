// Payment -> fulfillment wiring.
//
// Both providers reach fulfillment through the SAME call inside
// persistPaidOrder, so these tests drive the real Stripe webhook handler and
// the real tabby-verify handler and assert on the Supabase traffic each
// produces. Nothing here may create a CJ order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import stripeWebhookHandler from '../api/stripe-webhook.js';
import commerceHandler from '../api/commerce.js';
import { runFulfillmentPreparation, alreadyPrepared, FULFILLMENT_STATE } from '../lib/fulfillment-runner.js';

const WEBHOOK_SECRET = 'whsec_test_secret';
const SUPABASE_URL = 'https://supabase.test';
const ORDER_ID = 'AJ-FULFIL-1';

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
};

const makeRes = () => {
  const res = { statusCode: 0, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
};

const signedStripeReq = (payload) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex');
  return {
    method: 'POST',
    headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); }
  };
};

const stripeEvent = () => JSON.stringify({
  type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_fulfil_1', payment_status: 'paid', amount_total: 13500, currency: 'aed',
    payment_intent: 'pi_fulfil_1', created: Math.floor(Date.now() / 1000),
    customer_details: { email: 'buyer@example.com' },
    metadata: {
      order_id: ORDER_ID, items: 'أسود-L:5', customer_name: 'Test Buyer', phone: '+971500000001',
      country_code: 'AE', country_name: 'الإمارات', region: 'دبي', city: 'دبي',
      product_amount: '13500', shipping_amount: '0', shipping_zone: 'AE'
    }
  } }
});

// The persisted row the DB hands back, as saveOrder's select=* would.
const savedOrderRow = (overrides = {}) => ({
  id: 'order-uuid-1', order_number: ORDER_ID, status: 'paid',
  items: [{ variant: 'أسود-L', quantity: 5 }],
  shipping_city: 'دبي', shipping_country_code: 'AE', shipping_country_name: 'الإمارات',
  shipping_region: 'دبي', shipping_address: '1 Test St', customer_name: 'Test Buyer',
  customer_phone: '+971500000001', customer_email: 'buyer@example.com',
  product_amount: 13500, shipping_amount: 0, amount_total: 13500,
  fulfillment_status: null, fulfillment_external_order_id: null,
  ...overrides
});

// Simulates the whole external world: Supabase, Resend, CJ.
// cjBalance drives the balance preflight; every CJ endpoint is stubbed so a
// real CJ call would be visible as an unexpected URL.
const mockWorld = ({ cjBalance = 0, savedRow = savedOrderRow() } = {}) => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', body: options.body });

    if (u.includes('api.resend.com')) return { ok: true, status: 200, json: async () => ({}) };
    if (u.includes('process_paid_inventory')) return { ok: true, status: 200, json: async () => ({}) };
    // No shortages -> order validation passes.
    if (u.includes('rpc/check_inventory')) return { ok: true, status: 200, json: async () => ([]) };
    if (u.includes('/rest/v1/shipping_zones')) return { ok: true, status: 200, json: async () => ([{ code: 'AE', name_ar: 'الإمارات', country_codes: ['AE'], amount: 0, currency: 'aed', min_days: 7, max_days: 14, active: true }]) };
    if (u.includes('/rest/v1/orders') && options.method === 'POST') return { ok: true, status: 201, text: async () => JSON.stringify([savedRow]) };
    if (u.includes('/rest/v1/orders') && options.method === 'PATCH') return { ok: true, status: 204, text: async () => '' };

    // CJ
    if (u.includes('getAccessToken')) return { ok: true, json: async () => ({ data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) };
    if (u.includes('/product/conn/connection')) return { ok: true, json: async () => ({ code: 200, result: true, data: { list: [{ cjVariantId: '1581871544320667650', cjPrice: '2.21' }] } }) };
    if (u.includes('/logistic/freightCalculate')) return { ok: true, json: async () => ({ code: 200, result: true, data: [{ logisticName: 'CJPacket Liquid Line', totalPostageFee: 13.25, logisticAging: '7-10' }] }) };
    if (u.includes('/shopping/pay/getBalance')) return { ok: true, json: async () => ({ code: 200, result: true, data: { amount: cjBalance, freezeAmount: 0, noWithdrawalAmount: 0 } }) };

    throw new Error(`unexpected fetch: ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
};

const patchesToOrders = (calls) => calls
  .filter(c => c.url.includes('/rest/v1/orders') && c.method === 'PATCH')
  .map(c => JSON.parse(c.body));

const ENV = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, RESEND_API_KEY: 'resend_test', SUPABASE_URL, SUPABASE_SECRET_KEY: 'service_role_test', CJ_API_KEY: 'cj_test' };

// ---- STRIPE ------------------------------------------------------------------

test('a paid Stripe event triggers fulfillment preparation exactly once', async () => {
  await withEnv(ENV, async () => {
    const { calls, restore } = mockWorld({ cjBalance: 500 });
    try {
      const res = await stripeWebhookHandler(signedStripeReq(stripeEvent()), makeRes());
      assert.equal(res.statusCode, 200);
      const patches = patchesToOrders(calls);
      assert.equal(patches.length, 1, 'exactly one fulfillment write');
      assert.equal(patches[0].fulfillment_status, FULFILLMENT_STATE.READY_FOR_CJ);
      assert.equal(patches[0].fulfillment_provider, 'cj');
      assert.equal(patches[0].fulfillment_logistics_method, 'CJPacket Liquid Line');
    } finally { restore(); }
  });
});

test('the delivery promise passed to fulfillment comes from the shipping zone, not a hardcoded value', async () => {
  await withEnv(ENV, async () => {
    const { calls, restore } = mockWorld({ cjBalance: 500 });
    try {
      await stripeWebhookHandler(signedStripeReq(stripeEvent()), makeRes());
      assert.ok(calls.some(c => c.url.includes('/rest/v1/shipping_zones')), 'zones must be consulted for the promise');
    } finally { restore(); }
  });
});

// ---- TABBY -------------------------------------------------------------------

const tabbyVerifyReq = () => ({
  method: 'POST',
  query: { resource: 'tabby-verify' },
  headers: {},
  body: {
    payment_id: 'pay_fulfil_1',
    order: {
      id: ORDER_ID,
      customer: {
        email: 'buyer@example.com', name: 'Test Buyer', phone: '+971500000001',
        country_code: 'AE', country_name: 'الإمارات العربية المتحدة',
        region: 'دبي', city: 'دبي', address: '1 Test St'
      },
      // One entry per unit — the shape the cart actually submits (5 units).
      cart: { items: Array.from({ length: 5 }, () => ({ color: 'أسود', size: 'L' })) }
    }
  }
});

const mockWorldWithTabby = (opts) => {
  const world = mockWorld(opts);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/payments/')) { world.calls.push({ url: u, method: 'GET' }); return { ok: true, status: 200, json: async () => ({ id: 'pay_fulfil_1', status: 'CLOSED', amount: '135.00', currency: 'AED' }) }; }
    return inner(url, options);
  };
  return world;
};

test('a verified Tabby payment triggers the SAME fulfillment preparation exactly once', async () => {
  await withEnv({ ...ENV, TABBY_MODE: 'test', TABBY_PUBLIC_KEY: 'pk', TABBY_SECRET_KEY: 'sk' }, async () => {
    const { calls, restore } = mockWorldWithTabby({ cjBalance: 500 });
    try {
      const res = await commerceHandler(tabbyVerifyReq(), makeRes());
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.paid, true);
      const patches = patchesToOrders(calls);
      assert.equal(patches.length, 1, 'exactly one fulfillment write');
      assert.equal(patches[0].fulfillment_status, FULFILLMENT_STATE.READY_FOR_CJ);
    } finally { restore(); }
  });
});

test('Tabby and Stripe produce an identical fulfillment outcome — one shared pipeline, no per-provider logic', async () => {
  const shape = {};
  await withEnv(ENV, async () => {
    const { calls, restore } = mockWorld({ cjBalance: 500 });
    try { await stripeWebhookHandler(signedStripeReq(stripeEvent()), makeRes()); shape.stripe = patchesToOrders(calls)[0]; }
    finally { restore(); }
  });
  await withEnv({ ...ENV, TABBY_MODE: 'test', TABBY_PUBLIC_KEY: 'pk', TABBY_SECRET_KEY: 'sk' }, async () => {
    const { calls, restore } = mockWorldWithTabby({ cjBalance: 500 });
    try { await commerceHandler(tabbyVerifyReq(), makeRes()); shape.tabby = patchesToOrders(calls)[0]; }
    finally { restore(); }
  });
  for (const key of ['fulfillment_provider', 'fulfillment_status', 'fulfillment_logistics_method', 'fulfillment_cost', 'fulfillment_currency']) {
    assert.equal(shape.stripe[key], shape.tabby[key], `${key} differs between providers`);
  }
});

// ---- IDEMPOTENCY -------------------------------------------------------------

test('a re-delivered payment event does not prepare fulfillment a second time', async () => {
  await withEnv(ENV, async () => {
    // Second delivery sees the row as the DB now holds it: already prepared.
    const { calls, restore } = mockWorld({ cjBalance: 500, savedRow: savedOrderRow({ fulfillment_status: FULFILLMENT_STATE.READY_FOR_CJ }) });
    try {
      await stripeWebhookHandler(signedStripeReq(stripeEvent()), makeRes());
      assert.equal(patchesToOrders(calls).length, 0, 'an already-prepared order must not be re-prepared');
      assert.ok(!calls.some(c => c.url.includes('freightCalculate')), 'no CJ cost/freight work should be repeated');
    } finally { restore(); }
  });
});

test('the guard also holds once a real CJ order reference exists', () => {
  assert.equal(alreadyPrepared({ fulfillment_status: 'READY_FOR_CJ' }), true);
  assert.equal(alreadyPrepared({ fulfillment_external_order_id: 'cj-1' }), true);
  assert.equal(alreadyPrepared({ fulfillment_status: null, fulfillment_external_order_id: null }), false);
  assert.equal(alreadyPrepared(null), false);
});

// ---- ZERO BALANCE MUST NOT HARM THE PAID ORDER -------------------------------

test('an empty CJ wallet marks the order for review WITHOUT altering the paid order', async () => {
  await withEnv(ENV, async () => {
    // The real current state: CJ balance is 0.
    const { calls, restore } = mockWorld({ cjBalance: 0 });
    try {
      const res = await stripeWebhookHandler(signedStripeReq(stripeEvent()), makeRes());
      assert.equal(res.statusCode, 200, 'the payment must still be accepted');

      const patches = patchesToOrders(calls);
      assert.equal(patches.length, 1);
      assert.equal(patches[0].fulfillment_status, FULFILLMENT_STATE.REVIEW_REQUIRED);
      assert.equal(patches[0].fulfillment_error, 'INSUFFICIENT_CJ_BALANCE');

      // Nothing about the customer's paid order may be touched.
      for (const forbidden of ['status', 'amount_total', 'product_amount', 'shipping_amount', 'items', 'paid_at', 'customer_email']) {
        assert.equal(patches[0][forbidden], undefined, `${forbidden} must not be modified by fulfillment preparation`);
      }
    } finally { restore(); }
  });
});

test('a Tabby payment with an empty wallet also stays paid and is flagged for review', async () => {
  await withEnv({ ...ENV, TABBY_MODE: 'test', TABBY_PUBLIC_KEY: 'pk', TABBY_SECRET_KEY: 'sk' }, async () => {
    const { calls, restore } = mockWorldWithTabby({ cjBalance: 0 });
    try {
      const res = await commerceHandler(tabbyVerifyReq(), makeRes());
      assert.equal(res.body.paid, true, 'the customer payment must still be confirmed');
      const patches = patchesToOrders(calls);
      assert.equal(patches[0].fulfillment_status, FULFILLMENT_STATE.REVIEW_REQUIRED);
      assert.equal(patches[0].fulfillment_error, 'INSUFFICIENT_CJ_BALANCE');
    } finally { restore(); }
  });
});

test('a legacy order with no structured city is flagged for review, not fulfilled', async () => {
  await withEnv(ENV, async () => {
    const { calls, restore } = mockWorld({ cjBalance: 500, savedRow: savedOrderRow({ shipping_city: null }) });
    try {
      await stripeWebhookHandler(signedStripeReq(stripeEvent()), makeRes());
      const patches = patchesToOrders(calls);
      assert.equal(patches[0].fulfillment_status, FULFILLMENT_STATE.REVIEW_REQUIRED);
      assert.equal(patches[0].fulfillment_error, 'MISSING_SHIPPING_CITY');
    } finally { restore(); }
  });
});

test('fulfillment preparation never throws, so it can never fail a paid order', async () => {
  await withEnv(ENV, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('total outage'); };
    try {
      const result = await runFulfillmentPreparation(savedOrderRow(), { maxDeliveryDays: 14 });
      assert.equal(result.outcome, FULFILLMENT_STATE.REVIEW_REQUIRED);
    } finally { globalThis.fetch = original; }
  });
});

// ---- NO CJ ORDER CAN BE CREATED ----------------------------------------------

test('no CJ order is created anywhere in the payment path', async () => {
  await withEnv(ENV, async () => {
    const { calls, restore } = mockWorld({ cjBalance: 500 });
    try {
      await stripeWebhookHandler(signedStripeReq(stripeEvent()), makeRes());
      for (const call of calls) {
        assert.ok(!call.url.includes('createOrderV2'), 'createOrderV2 must never be called');
        assert.ok(!call.url.includes('/shopping/order/'), 'no CJ order endpoint may be called');
        assert.ok(!call.url.includes('payBalance'), 'the CJ wallet must never be spent');
      }
    } finally { restore(); }
  });
});

test('live CJ order creation is still disabled at the client', async () => {
  const { createFulfillmentOrder } = await import('../lib/cj-client.js');
  await assert.rejects(() => createFulfillmentOrder({}), /disabled/i);
});

test('the runner cannot reach order creation — it only ever prepares', async () => {
  const source = await readFile(new URL('../lib/fulfillment-runner.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/createFulfillmentOrder|createOrderV2/.test(code));
});

// ---- NO PROVIDER INTERNALS LEAK ----------------------------------------------

test('the fulfillment fields written are internal-only and never surface to customers', async () => {
  const { serializeOrderForCustomer } = await import('../lib/fulfillment-status.js');
  const order = {
    ...savedOrderRow(),
    status: 'shipped', currency: 'aed', tracking_number: 'TRACK1',
    fulfillment_provider: 'cj', fulfillment_status: FULFILLMENT_STATE.READY_FOR_CJ,
    fulfillment_external_order_number: 'AJLIB-AJ-FULFIL-1',
    fulfillment_logistics_method: 'CJPacket Liquid Line',
    fulfillment_cost: 25.51, fulfillment_currency: 'USD',
    fulfillment_error: 'INSUFFICIENT_CJ_BALANCE'
  };
  const serialized = serializeOrderForCustomer(order);
  const json = JSON.stringify(serialized);
  for (const key of Object.keys(serialized)) assert.ok(!key.toLowerCase().startsWith('fulfillment'), `leaked key: ${key}`);
  for (const secret of ['cj', 'CJPacket', 'AJLIB-AJ-FULFIL-1', 'INSUFFICIENT_CJ_BALANCE', 'READY_FOR_CJ', 'USD']) {
    assert.ok(!json.includes(secret), `leaked value: ${secret}`);
  }
});
