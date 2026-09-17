import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/checkout-session.js';

// Locks the exact status codes/messages api/checkout-session.js returned
// BEFORE its validation logic was extracted into lib/order-validation.js
// (for reuse by the new Tabby checkout path). No behavior here should have
// changed — these are the same checks, same wording, just relocated.

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

const validOrder = () => ({
  id: 'AJ-TEST-1',
  customer: {
    email: 'buyer@example.com', name: 'Test Buyer', country_code: 'AE', country_name: 'الإمارات العربية المتحدة',
    region: 'دبي', city: 'دبي', address: '1 Test St'
  },
  cart: { items: [{ color: 'أسود', size: 'L' }, { color: 'أسود', size: 'L' }, { color: 'أسود', size: 'L' }, { color: 'أسود', size: 'L' }, { color: 'أسود', size: 'L' }] }
});

test('returns 503 when Stripe is not configured, without touching validation', async () => {
  await withEnv({ STRIPE_SECRET_KEY: '' }, async () => {
    const res = await handler({ method: 'POST', body: validOrder(), headers: {} }, makeRes());
    assert.equal(res.statusCode, 503);
  });
});

test('GET with no session_id/payment_intent_id still returns 400', async () => {
  await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
    const res = await handler({ method: 'GET', query: {}, headers: {} }, makeRes());
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'جلسة غير صحيحة');
  });
});

test('rejects an empty cart with the original quantity error', async () => {
  await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
    const order = { ...validOrder(), cart: { items: [] } };
    const res = await handler({ method: 'POST', body: order, headers: {} }, makeRes());
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'كمية الطلب غير صحيحة');
  });
});

test('rejects an over-limit cart (>100) with the original quantity error', async () => {
  await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
    const items = Array.from({ length: 101 }, () => ({ color: 'أسود', size: 'L' }));
    const order = { ...validOrder(), cart: { items } };
    const res = await handler({ method: 'POST', body: order, headers: {} }, makeRes());
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'كمية الطلب غير صحيحة');
  });
});

test('rejects an invalid email with the original message', async () => {
  await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
    const order = validOrder();
    order.customer.email = 'not-an-email';
    const res = await handler({ method: 'POST', body: order, headers: {} }, makeRes());
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'اكتب بريدًا إلكترونيًا صحيحًا');
  });
});

test('rejects a common email domain typo with the original message', async () => {
  await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
    const order = validOrder();
    order.customer.email = 'buyer@gamil.com';
    const res = await handler({ method: 'POST', body: order, headers: {} }, makeRes());
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /نطاق البريد/);
  });
});

test('valid order + mobile:false still returns a Stripe Checkout Session shape', async () => {
  await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      assert.ok(String(url).includes('checkout/sessions'));
      return { ok: true, json: async () => ({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/x' }) };
    };
    try {
      const res = await handler({ method: 'POST', body: { ...validOrder(), mobile: false }, headers: {} }, makeRes());
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.id, 'cs_test_abc');
      assert.ok(res.body.url);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('valid order + mobile:true returns a PaymentIntent client secret shape', async () => {
  await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PUBLISHABLE_KEY: 'pk_test_x' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      assert.ok(String(url).includes('payment_intents'));
      return { ok: true, json: async () => ({ id: 'pi_test_abc', client_secret: 'pi_test_abc_secret_x' }) };
    };
    try {
      const res = await handler({ method: 'POST', body: { ...validOrder(), mobile: true }, headers: {} }, makeRes());
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.id, 'pi_test_abc');
      assert.equal(res.body.clientSecret, 'pi_test_abc_secret_x');
      assert.equal(res.body.publishableKey, 'pk_test_x');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('mobile:true without STRIPE_PUBLISHABLE_KEY safely 503s instead of misbehaving', async () => {
  await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PUBLISHABLE_KEY: '' }, async () => {
    const res = await handler({ method: 'POST', body: { ...validOrder(), mobile: true }, headers: {} }, makeRes());
    assert.equal(res.statusCode, 503);
  });
});
