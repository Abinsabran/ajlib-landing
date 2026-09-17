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
      // Real Tabby shape (confirmed against a live sandbox session): the
      // top-level session id and payment.id are DIFFERENT values.
      return { ok: true, json: async () => ({ id: 'session_test_1', status: 'created', payment: { id: 'payment_test_1' }, configuration: { available_products: { installments: [{ web_url: 'https://checkout.tabby.ai/x' }] } } }) };
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

test('tabby-checkout returns the nested payment.id, not the top-level session id, as paymentId', async () => {
  // Regression test: a live Preview sandbox run showed these are DIFFERENT
  // Tabby ids. Returning the session id here silently breaks verification
  // (GET /payments/{id} 404s with "no such payment").
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x', TABBY_PUBLIC_KEY: 'pk_test_x' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'session_test_2', status: 'created', payment: { id: 'payment_test_2' }, configuration: { available_products: { installments: [{ web_url: 'https://checkout.tabby.ai/x' }] } } }) });
    try {
      const res = await handler({ method: 'POST', query: { resource: 'tabby-checkout' }, body: validOrder(), headers: {} }, makeRes());
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.paymentId, 'payment_test_2');
      assert.notEqual(res.body.paymentId, 'session_test_2');
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
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service_role_test', RESEND_API_KEY: 'resend_test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/payments/')) return { ok: true, json: async () => ({ id: 'pay_test_1', status: 'CLOSED', amount: '119.00', currency: 'AED' }) };
      if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'email_1' }) };
      if (String(url).includes('/rest/v1/orders')) return { ok: true, text: async () => JSON.stringify([{ id: 'order-uuid-verified', order_number: 'AJ-TABBY-TEST-1', stripe_session_id: 'tabby_pay_test_1' }]) };
      if (String(url).includes('/rpc/process_paid_inventory')) return { ok: true, json: async () => ({}) };
      if (String(url).includes('/rpc/check_inventory')) return { ok: true, json: async () => ([]) };
      if (String(url).includes('/rest/v1/shipping_zones')) return { ok: false };
      throw new Error(`unexpected fetch in test: ${url}`);
    };
    try {
      const res = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body: { payment_id: 'pay_test_1', order: validOrder() }, headers: {} }, makeRes());
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.paid, true);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('THE BUG: tabby-verify must NOT report paid:true when the order upsert reports success but returns no row', async () => {
  // Reproduces the general shape of the real-world failure: any 2xx from
  // the orders upsert with an empty representation must not be trusted as
  // persistence. (The CONFIRMED live root cause turned out to be simpler —
  // see the next test — but this covers other silent-no-op shapes too, e.g.
  // an RLS-restricted read-back.)
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'restricted_key_test', RESEND_API_KEY: 'resend_test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/payments/')) return { ok: true, json: async () => ({ id: 'pay_norow_1', status: 'CLOSED', amount: '119.00', currency: 'AED' }) };
      if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'email_1' }) };
      // The exact failure mode: PostgREST reports 201 (ok) but the
      // representation is empty — e.g. an RLS-restricted read-back, a key
      // that isn't actually privileged, or any other silent no-op.
      if (String(url).includes('/rest/v1/orders')) return { ok: true, text: async () => '[]' };
      if (String(url).includes('/rpc/process_paid_inventory')) return { ok: true, json: async () => ({}) };
      if (String(url).includes('/rpc/check_inventory')) return { ok: true, json: async () => ([]) };
      if (String(url).includes('/rest/v1/shipping_zones')) return { ok: false };
      throw new Error(`unexpected fetch in test: ${url}`);
    };
    try {
      const res = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body: { payment_id: 'pay_norow_1', order: validOrder({ id: 'AJ-TABBY-NOROW-1' }) }, headers: {} }, makeRes());
      assert.notEqual(res.statusCode, 200, 'must not report success when no row was actually persisted');
      assert.equal(res.body.paid, undefined);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('CONFIRMED LIVE ROOT CAUSE: missing SUPABASE_SECRET_KEY silently no-ops saveOrder — must not report paid:true', async () => {
  // Confirmed against live Preview via a boolean-only env-presence check
  // (no secret value ever read/exposed): SUPABASE_SECRET_KEY was never
  // added to Preview. saveOrder()/updateInventory() both silently return
  // via their existing `if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return;`
  // guard — no fetch attempted, no error thrown — while sendOrderEmail()
  // (no such guard) succeeds independently. The pre-fix code took
  // Promise.all resolving cleanly as proof of persistence; it proved
  // nothing. No fetch to /rest/v1/orders should even happen here.
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: '', RESEND_API_KEY: 'resend_test' }, async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('/payments/')) return { ok: true, json: async () => ({ id: 'pay_nokey_1', status: 'CLOSED', amount: '119.00', currency: 'AED' }) };
      if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'email_1' }) };
      if (String(url).includes('/rest/v1/shipping_zones')) return { ok: false };
      throw new Error(`unexpected fetch in test: ${url}`);
    };
    try {
      const res = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body: { payment_id: 'pay_nokey_1', order: validOrder({ id: 'AJ-TABBY-NOKEY-1' }) }, headers: {} }, makeRes());
      assert.notEqual(res.statusCode, 200);
      assert.equal(res.body.paid, undefined);
      assert.ok(!calls.some(u => u.includes('/rest/v1/orders')), 'no order upsert should even be attempted without the key');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('tabby-verify treats an EXPIRED session (real sandbox-observed status) as not paid', async () => {
  // A live Preview sandbox session that was never completed within its
  // window came back with status: "EXPIRED" when re-verified — confirmed
  // real, not assumed. Must be refused exactly like REJECTED, not persisted.
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'pay_test_1', status: 'EXPIRED', amount: '119.00', currency: 'AED' }) });
    try {
      const res = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body: { payment_id: 'pay_test_1', order: validOrder() }, headers: {} }, makeRes());
      assert.equal(res.statusCode, 402);
      assert.equal(res.body.status, 'EXPIRED');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('an email-provider failure does not prevent the order/inventory writes from being attempted (live Preview finding)', async () => {
  // Live Preview walkthrough: a real completed Tabby sandbox payment
  // verified successfully, but RESEND_API_KEY was rejected (401) by Resend,
  // so the overall response was 502. Because persistPaidOrder runs
  // save/email/inventory in parallel (Promise.all), the order and inventory
  // calls are still dispatched independently of the email failure — this
  // locks that in so a future refactor doesn't accidentally serialize them
  // behind email success.
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service_role_test', RESEND_API_KEY: 'invalid_key' }, async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push(String(url));
      if (String(url).includes('/payments/')) return { ok: true, json: async () => ({ id: 'pay_email_fail', status: 'CLOSED', amount: '119.00', currency: 'AED' }) };
      if (String(url).includes('api.resend.com')) return { ok: false, status: 401 }; // matches the real observed failure
      if (String(url).includes('/rest/v1/orders')) return { ok: true, text: async () => JSON.stringify([{ id: 'order-uuid-emailfail', order_number: 'AJ-TABBY-EMAILFAIL-1', stripe_session_id: 'tabby_pay_email_fail' }]) };
      if (String(url).includes('/rpc/process_paid_inventory')) return { ok: true, json: async () => ({}) };
      if (String(url).includes('/rpc/check_inventory')) return { ok: true, json: async () => ([]) };
      if (String(url).includes('/rest/v1/shipping_zones')) return { ok: false };
      throw new Error(`unexpected fetch in test: ${url}`);
    };
    try {
      const res = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body: { payment_id: 'pay_email_fail', order: validOrder({ id: 'AJ-TABBY-EMAILFAIL-1' }) }, headers: {} }, makeRes());
      assert.equal(res.statusCode, 502); // overall call reports failure...
      assert.ok(calls.some(u => u.includes('/rest/v1/orders')), '...but the order upsert was still attempted');
      assert.ok(calls.some(u => u.includes('process_paid_inventory')), '...and the inventory update was still attempted');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('duplicate tabby-verify calls for the same payment send byte-identical idempotency keys (no duplicate order/email/inventory)', async () => {
  await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service_role_test', RESEND_API_KEY: 'resend_test' }, async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/payments/')) return { ok: true, json: async () => ({ id: 'pay_dup_1', status: 'CLOSED', amount: '119.00', currency: 'AED' }) };
      if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'email_1' }) };
      if (String(url).includes('/rest/v1/orders')) return { ok: true, text: async () => JSON.stringify([{ id: 'order-uuid-dup', order_number: 'AJ-TABBY-DUP-1', stripe_session_id: 'tabby_pay_dup_1' }]) };
      if (String(url).includes('/rpc/process_paid_inventory')) return { ok: true, json: async () => ({}) };
      if (String(url).includes('/rpc/check_inventory')) return { ok: true, json: async () => ([]) };
      if (String(url).includes('/rest/v1/shipping_zones')) return { ok: false }; // forces shipping-quote.js's own fallbackZones, no live rule change
      throw new Error(`unexpected fetch in test: ${url}`);
    };
    try {
      const body = { payment_id: 'pay_dup_1', order: validOrder({ id: 'AJ-TABBY-DUP-1' }) };
      const res1 = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body, headers: {} }, makeRes());
      const res2 = await handler({ method: 'POST', query: { resource: 'tabby-verify' }, body, headers: {} }, makeRes());
      assert.equal(res1.statusCode, 200);
      assert.equal(res2.statusCode, 200);

      const orderCalls = calls.filter(c => c.url.includes('/rest/v1/orders') && !c.url.includes('rpc'));
      const emailCalls = calls.filter(c => c.url.includes('api.resend.com'));
      const inventoryCalls = calls.filter(c => c.url.includes('process_paid_inventory'));

      assert.equal(orderCalls.length, 2, 'one upsert attempt per verify call');
      const bodies = orderCalls.map(c => JSON.parse(c.options.body));
      assert.equal(bodies[0].stripe_session_id, 'tabby_pay_dup_1');
      assert.equal(bodies[0].stripe_session_id, bodies[1].stripe_session_id);
      assert.equal(orderCalls[0].options.headers.Prefer, 'resolution=merge-duplicates,return=representation');

      assert.equal(emailCalls.length, 2);
      assert.equal(emailCalls[0].options.headers['Idempotency-Key'], emailCalls[1].options.headers['Idempotency-Key']);

      assert.equal(inventoryCalls.length, 2);
      const invBodies = inventoryCalls.map(c => JSON.parse(c.options.body));
      assert.equal(invBodies[0].session_id, invBodies[1].session_id);
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
