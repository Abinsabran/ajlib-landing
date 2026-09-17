import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import handler from '../api/stripe-webhook.js';

// Regression coverage for the native-checkout webhook branch added to
// api/stripe-webhook.js. This does not hit Stripe, Supabase or Resend — it
// mocks global.fetch and asserts on what OUR code sends, since the actual
// cross-request dedup guarantee is enforced by Postgres's unique constraint
// on orders.stripe_session_id (DB-level) and by Resend's own handling of the
// Idempotency-Key header (Resend-side) — neither of which a unit test in
// this repo can exercise without a live deployment. What we CAN and DO prove
// here: (a) the identifiers/headers this code sends are byte-identical
// across redeliveries of the same event, which is the precondition those
// external guarantees rely on, and (b) the metadata.order_id guard reliably
// tells native events apart from the web flow's own underlying PaymentIntent
// events, so the web flow is never double-processed by the new branch.

const WEBHOOK_SECRET = 'whsec_test_secret';
const SUPABASE_URL = 'https://example.supabase.co';

const sign = (payload, secret = WEBHOOK_SECRET) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
};

const makeReq = (bodyString) => ({
  method: 'POST',
  headers: { 'stripe-signature': sign(bodyString) },
  [Symbol.asyncIterator]: async function* () { yield Buffer.from(bodyString, 'utf8'); }
});

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
};

const mockFetch = () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'email_1' }) };
    if (String(url).includes('/rest/v1/orders')) return { ok: true, text: async () => '' };
    if (String(url).includes('/rpc/process_paid_inventory')) return { ok: true, json: async () => ({}) };
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
};

const nativePaymentIntentEvent = (overrides = {}) => JSON.stringify({
  type: 'payment_intent.succeeded',
  data: {
    object: {
      id: 'pi_native_test_1',
      metadata: {
        order_id: 'AJ00000001', items: 'أسود-L:5', customer_name: 'Test Customer', phone: '', address_id: '',
        country_code: 'AE', country_name: 'الإمارات العربية المتحدة', region: '', postal_code: '', address: 'x',
        notes: '', product_amount: '11900', shipping_amount: '0', shipping_zone: 'AE', user_id: '', preorder: ''
      },
      receipt_email: 'native-buyer@example.com',
      amount: 11900,
      currency: 'aed',
      created: Math.floor(Date.now() / 1000),
      ...overrides
    }
  }
});

const webUnderlyingPaymentIntentEvent = () => JSON.stringify({
  type: 'payment_intent.succeeded',
  data: {
    object: {
      id: 'pi_web_underlying_1',
      metadata: {}, // Checkout Session metadata is NOT copied to the underlying PaymentIntent
      receipt_email: 'web-buyer@example.com',
      amount: 11900,
      currency: 'aed',
      created: Math.floor(Date.now() / 1000)
    }
  }
});

const checkoutSessionCompletedEvent = () => JSON.stringify({
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_web_test_1',
      payment_status: 'paid',
      client_reference_id: 'AJ00000002',
      metadata: { order_id: 'AJ00000002', items: 'أسود-L:5', product_amount: '11900', shipping_amount: '0', shipping_zone: 'AE' },
      customer_details: { email: 'web-buyer@example.com' },
      amount_total: 11900,
      currency: 'aed',
      payment_intent: 'pi_web_underlying_1',
      created: Math.floor(Date.now() / 1000)
    }
  }
});

test('native PaymentIntent webhook: two identical deliveries send byte-identical idempotency keys', async () => {
  await withEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, RESEND_API_KEY: 'resend_test', SUPABASE_URL, SUPABASE_SECRET_KEY: 'service_role_test' }, async () => {
    const { calls, restore } = mockFetch();
    try {
      const payload = nativePaymentIntentEvent();
      const res1 = await handler(makeReq(payload), makeRes());
      const res2 = await handler(makeReq(payload), makeRes());

      assert.equal(res1.statusCode, 200);
      assert.equal(res2.statusCode, 200);

      const ordersCalls = calls.filter(c => c.url.includes('/rest/v1/orders'));
      const emailCalls = calls.filter(c => c.url.includes('api.resend.com'));
      const inventoryCalls = calls.filter(c => c.url.includes('process_paid_inventory'));

      // Two deliveries -> two attempts each (Promise.all runs regardless of
      // delivery count); what matters is every attempt carries the SAME
      // dedup identifier, which is what lets the DB/Resend collapse them.
      assert.equal(ordersCalls.length, 2, 'expected one order upsert attempt per delivery');
      const orderBodies = ordersCalls.map(c => JSON.parse(c.options.body));
      assert.equal(orderBodies[0].stripe_session_id, 'pi_native_test_1');
      assert.equal(orderBodies[0].stripe_session_id, orderBodies[1].stripe_session_id);
      assert.equal(ordersCalls[0].options.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
      assert.equal(ordersCalls[1].options.headers.Prefer, 'resolution=merge-duplicates,return=minimal');

      assert.equal(emailCalls.length, 2);
      assert.equal(emailCalls[0].options.headers['Idempotency-Key'], 'ajlib-order-pi_native_test_1');
      assert.equal(emailCalls[0].options.headers['Idempotency-Key'], emailCalls[1].options.headers['Idempotency-Key']);

      assert.equal(inventoryCalls.length, 2);
      const inventoryBodies = inventoryCalls.map(c => JSON.parse(c.options.body));
      assert.equal(inventoryBodies[0].session_id, 'pi_native_test_1');
      assert.equal(inventoryBodies[0].session_id, inventoryBodies[1].session_id);
    } finally { restore(); }
  });
});

test('native PaymentIntent idempotency key equals the Stripe PaymentIntent id (same column the hosted flow uses)', async () => {
  await withEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, RESEND_API_KEY: 'resend_test', SUPABASE_URL, SUPABASE_SECRET_KEY: 'service_role_test' }, async () => {
    const { calls, restore } = mockFetch();
    try {
      await handler(makeReq(nativePaymentIntentEvent()), makeRes());
      const orderBody = JSON.parse(calls.find(c => c.url.includes('/rest/v1/orders')).options.body);
      assert.equal(orderBody.stripe_session_id, 'pi_native_test_1');
      assert.equal(orderBody.stripe_payment_intent_id, 'pi_native_test_1');
    } finally { restore(); }
  });
});

test("hosted Checkout's own underlying PaymentIntent event is NOT double-processed", async () => {
  await withEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, RESEND_API_KEY: 'resend_test', SUPABASE_URL, SUPABASE_SECRET_KEY: 'service_role_test' }, async () => {
    const { calls, restore } = mockFetch();
    try {
      const res = await handler(makeReq(webUnderlyingPaymentIntentEvent()), makeRes());
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 0, 'no order/email/inventory calls should fire for a web-originated PaymentIntent event');
    } finally { restore(); }
  });
});

test('hosted checkout.session.completed still processes exactly as before (one attempt per delivery)', async () => {
  await withEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, RESEND_API_KEY: 'resend_test', SUPABASE_URL, SUPABASE_SECRET_KEY: 'service_role_test' }, async () => {
    const { calls, restore } = mockFetch();
    try {
      const payload = checkoutSessionCompletedEvent();
      await handler(makeReq(payload), makeRes());
      const ordersCalls = calls.filter(c => c.url.includes('/rest/v1/orders'));
      assert.equal(ordersCalls.length, 1);
      const orderBody = JSON.parse(ordersCalls[0].options.body);
      assert.equal(orderBody.stripe_session_id, 'cs_web_test_1');
      assert.equal(orderBody.stripe_payment_intent_id, 'pi_web_underlying_1');
    } finally { restore(); }
  });
});

test('invalid Stripe signature is rejected before any processing (unchanged behavior)', async () => {
  await withEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, RESEND_API_KEY: 'resend_test' }, async () => {
    const { calls, restore } = mockFetch();
    try {
      const payload = nativePaymentIntentEvent();
      const badReq = { method: 'POST', headers: { 'stripe-signature': 't=1,v1=deadbeef' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); } };
      const res = await handler(badReq, makeRes());
      assert.equal(res.statusCode, 400);
      assert.equal(calls.length, 0);
    } finally { restore(); }
  });
});
