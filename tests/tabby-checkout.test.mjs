import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/commerce.js';

// Covers: test-mode enforcement, secret never exposed, checkout totals come
// from the server-authoritative quote logic (never the client), a redirect
// alone cannot mark an order paid, cancel/failure stay safe, and Stripe is
// never affected by Tabby's availability.

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

const validOrder = (overrides = {}) => ({
  id: 'AJ-TABBY-TEST-1',
  customer: {
    email: 'buyer@example.com', name: 'Test Buyer', country_code: 'AE', country_name: 'الإمارات العربية المتحدة',
    region: 'دبي', city: 'دبي', address: '1 Test St'
  },
  cart: { items: [{ color: 'أسود', size: 'L' }, { color: 'أسود', size: 'L' }, { color: 'أسود', size: 'L' }, { color: 'أسود', size: 'L' }, { color: 'أسود', size: 'L' }] },
  ...overrides
});

test('tabby-checkout is disabled (503) when TABBY_MODE is not "test" — production Tabby transactions structurally impossible', async () => {
  await withEnv({ TABBY_MODE: 'live' }, async () => {
    const res = await handler({ method: 'POST', query: { resource: 'tabby-checkout' }, body: validOrder(), headers: {} }, makeRes());
    assert.equal(res.statusCode, 503);
  });
});

test('tabby-checkout never returns TABBY_SECRET_KEY or any secret value', async () => {
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_should_never_appear', TABBY_PUBLIC_KEY: 'pk_test_x' }, async () => {
    const res = await handler({ method: 'POST', query: { resource: 'tabby-checkout' }, body: validOrder(), headers: {} }, makeRes());
    assert.equal(JSON.stringify(res.body).includes('sk_should_never_appear'), false);
  });
});

test('tabby-checkout uses the server-authoritative quote, not any client-submitted amount', async () => {
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x', TABBY_PUBLIC_KEY: 'pk_test_x' }, async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody = null;
    globalThis.fetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: 'pay_test_1', status: 'created', configuration: { available_products: { installments: [{ web_url: 'https://checkout.tabby.ai/x' }] } } }) };
    };
    try {
      // Client tries to claim a tiny amount — order-validation.js recomputes
      // the real 5-piece total (119 AED) server-side regardless.
      const order = validOrder({ claimedAmountFils: 1 });
      const res = await handler({ method: 'POST', query: { resource: 'tabby-checkout' }, body: order, headers: {} }, makeRes());
      assert.equal(res.statusCode, 200);
      assert.equal(capturedBody.payment.amount, '119.00'); // 5 x 23.80 AED, the real tiered price
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('tabby-verify requires a payment_id and never marks paid from a bare redirect', async () => {
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x' }, async () => {
    const res = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body: { order: validOrder() }, headers: {} }, makeRes());
    assert.equal(res.statusCode, 400);
  });
});

test('tabby-verify calls Tabby server-side and rejects an incomplete payment status', async () => {
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'pay_test_1', status: 'REJECTED', amount: '119.00', currency: 'AED' }) });
    try {
      const res = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body: { payment_id: 'pay_test_1', order: validOrder() }, headers: {} }, makeRes());
      assert.equal(res.statusCode, 402);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('tabby-verify rejects when Tabby\'s recorded amount does not match the recomputed order total', async () => {
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'pay_test_1', status: 'CLOSED', amount: '1.00', currency: 'AED' }) });
    try {
      const res = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body: { payment_id: 'pay_test_1', order: validOrder() }, headers: {} }, makeRes());
      assert.equal(res.statusCode, 409);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('tabby-verify persists the order only once amount and status both check out (server-side verified)', async () => {
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x', SUPABASE_URL: '', SUPABASE_SECRET_KEY: '', RESEND_API_KEY: '' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/payments/')) return { ok: true, json: async () => ({ id: 'pay_test_1', status: 'CLOSED', amount: '119.00', currency: 'AED' }) };
      if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'email_1' }) }; // sendOrderEmail has no env-var guard, unlike saveOrder/updateInventory
      throw new Error(`unexpected fetch in test: ${url}`);
    };
    try {
      const res = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body: { payment_id: 'pay_test_1', order: validOrder() }, headers: {} }, makeRes());
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.paid, true);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('Stripe checkout is unaffected when Tabby is unavailable/disabled', async () => {
  await withEnv({ TABBY_MODE: 'live', STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
    const checkoutSessionHandler = (await import('../api/checkout-session.js')).default;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'cs_test_x', url: 'https://checkout.stripe.com/x' }) });
    try {
      const res = await checkoutSessionHandler({ method: 'POST', body: { ...validOrder(), mobile: false }, headers: {} }, makeRes());
      assert.equal(res.statusCode, 200);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('tabby-availability reports ineligible without ever calling the Tabby API', async () => {
  await withEnv({ TABBY_MODE: 'live' }, async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { fetchCalled = true; return originalFetch(...args); };
    try {
      const res = await handler({ method: 'GET', query: { resource: 'tabby-availability', country_code: 'AE', amount_fils: '11900' } }, makeRes());
      assert.equal(res.body.available, false);
      assert.equal(fetchCalled, false);
    } finally { globalThis.fetch = originalFetch; }
  });
});
