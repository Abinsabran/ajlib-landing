// Regression tests for the three defects found in the live Preview
// end-to-end Tabby validation:
//   1. customers could read internal fulfillment_* columns via select=*
//   2. Tabby re-verification rewrote paid_at to the verification time
//   3. REVIEW_REQUIRED orders discarded the route/cost already calculated

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import stripeWebhookHandler from '../api/stripe-webhook.js';
import commerceHandler, { tabbyTimestampToEpochSeconds } from '../api/commerce.js';
import { runFulfillmentPreparation, FULFILLMENT_STATE } from '../api/_lib/fulfillment-runner.js';

const FULFILLMENT_COLUMNS = [
  'fulfillment_provider', 'fulfillment_external_order_id', 'fulfillment_external_order_number',
  'fulfillment_status', 'fulfillment_tracking_number', 'fulfillment_logistics_method',
  'fulfillment_cost', 'fulfillment_currency', 'fulfillment_last_sync_at',
  'fulfillment_error', 'fulfillment_retry_count'
];

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
};

const makeRes = () => {
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  return res;
};

// ============================================================================
// 1. CUSTOMERS CANNOT READ INTERNAL FULFILLMENT COLUMNS
// ============================================================================
// The protection is a database privilege, verified live against Preview as a
// real non-admin customer (select=* and every fulfillment column -> 42501).
// These tests pin the migration that enforces it, so it cannot silently
// regress or be edited into leaking.

const loadGrantMigration = async () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const file = (await readdir(dir)).find(f => f.endsWith('_hide_fulfillment_columns_from_customers.sql'));
  assert.ok(file, 'the column-privilege migration must exist');
  const sql = (await readFile(new URL(file, dir), 'utf8')).replace(/--.*$/gm, '');
  const granted = sql.match(/grant select \(([^)]*)\)/s)[1].split(',').map(s => s.trim()).filter(Boolean);
  return { sql, granted };
};

test('no fulfillment_* column is granted to customers', async () => {
  const { granted } = await loadGrantMigration();
  for (const column of FULFILLMENT_COLUMNS) {
    assert.ok(!granted.includes(column), `${column} must never be customer-readable`);
  }
  assert.ok(!granted.some(c => c.startsWith('fulfillment_')), 'no internal column may be granted');
});

test('the table-wide SELECT is revoked BEFORE the column grant (a later revoke would wipe the grant)', async () => {
  const { sql } = await loadGrantMigration();
  const revokeAt = sql.search(/revoke select on table public\.orders from authenticated/i);
  const grantAt = sql.search(/grant select \(/i);
  assert.ok(revokeAt >= 0, 'the table-wide SELECT must be revoked');
  assert.ok(grantAt > revokeAt, 'the column grant must come after the revoke');
});

test('the migration narrows ONLY customer SELECT — server and anon grants are not touched', async () => {
  const { sql } = await loadGrantMigration();
  assert.ok(!/service_role/i.test(sql), 'service_role must keep full access');
  assert.ok(!/\banon\b/i.test(sql), 'anon grants must be untouched');
  assert.ok(!/\bpolicy\b/i.test(sql), 'RLS policies must be untouched');
  assert.ok(!/\b(drop|delete|update|truncate)\b/i.test(sql), 'privilege-only: no data may be touched');
});

// Normal order history must keep working: every column each real reader
// SELECTs — or FILTERS on, since PostgreSQL needs SELECT for a WHERE — must
// still be granted. These lists are the actual queries in the codebases.
test('normal customer order history still works for every real reader', async () => {
  const { granted } = await loadGrantMigration();
  const readers = {
    'storefront customer order list': 'order_number,items,amount_total,currency,status,shipping_company,tracking_number,created_at,updated_at',
    'storefront admin console': 'id,order_number,customer_name,customer_email,customer_phone,shipping_address,items,amount_total,currency,status,shipping_company,tracking_number,admin_note,created_at,updated_at',
    'Expo app customer list (+ .eq user_id)': 'order_number,amount_total,currency,status,items,tracking_number,shipping_company,created_at,updated_at,user_id',
    'Expo app admin console': 'id,order_number,customer_name,customer_email,customer_phone,shipping_address,items,amount_total,currency,status,shipping_company,tracking_number,created_at,updated_at'
  };
  for (const [reader, columns] of Object.entries(readers)) {
    const missing = columns.split(',').filter(c => !granted.includes(c));
    assert.deepEqual(missing, [], `${reader} would break — missing ${missing}`);
  }
});

test('the storefront order list really does request only granted columns', async () => {
  const { granted } = await loadGrantMigration();
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const selects = [...html.matchAll(/rest\/v1\/orders\?select=([a-z_,]+)/g)].map(m => m[1].split(','));
  // Customer history now reads through public.my_orders(); it must return
  // only columns a customer is already granted.
  assert.match(html, /\/rest\/v1\/rpc\/my_orders/);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  const file = (await readdir(migrations)).find(f => f.endsWith('_customer_my_orders.sql'));
  const sql = await readFile(new URL(file, migrations), 'utf8');
  selects.push(sql.match(/returns table \(([\s\S]*?)\n\)/)[1].split(',').map(line => line.trim().split(/\s+/)[0]));
  assert.equal(selects.at(-1).length, 9);
  for (const columns of selects) {
    const missing = columns.filter(c => !granted.includes(c));
    assert.deepEqual(missing, [], `storefront requests ungranted columns: ${missing}`);
  }
});

// ============================================================================
// 2. TABBY paid_at IS ANCHORED TO TABBY'S OWN TIMESTAMP
// ============================================================================

test("Tabby's created_at is parsed exactly, and a missing/garbage value yields null (never 'now')", () => {
  // The real value observed on a live sandbox payment.
  assert.equal(tabbyTimestampToEpochSeconds('2026-09-18T00:48:37Z'), Date.UTC(2026, 8, 18, 0, 48, 37) / 1000);
  assert.equal(tabbyTimestampToEpochSeconds(null), null);
  assert.equal(tabbyTimestampToEpochSeconds(undefined), null);
  assert.equal(tabbyTimestampToEpochSeconds(''), null);
  assert.equal(tabbyTimestampToEpochSeconds('not-a-date'), null);
});

const TABBY_CREATED_AT = '2026-09-18T00:48:37Z';

const tabbyWorld = ({ createdAt = TABBY_CREATED_AT } = {}) => {
  const upserts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/payments/')) return { ok: true, status: 200, json: async () => ({ id: 'pay_paidat_1', status: 'AUTHORIZED', amount: '135.00', currency: 'AED', ...(createdAt !== null ? { created_at: createdAt } : {}) }) };
    if (u.includes('rpc/check_inventory')) return { ok: true, json: async () => ([]) };
    if (u.includes('/rest/v1/shipping_zones')) return { ok: true, json: async () => ([{ code: 'AE', country_codes: ['AE'], amount: 0, currency: 'aed', min_days: 7, max_days: 14, active: true }]) };
    if (u.includes('/rest/v1/orders') && options.method === 'POST') {
      upserts.push(JSON.parse(options.body));
      // Already prepared, so the verification does no CJ work in this test.
      return { ok: true, status: 201, text: async () => JSON.stringify([{ id: 'o1', order_number: 'AJ-PAIDAT-1', status: 'paid', fulfillment_status: 'REVIEW_REQUIRED' }]) };
    }
    if (u.includes('api.resend.com') || u.includes('process_paid_inventory')) return { ok: true, json: async () => ({}) };
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { upserts, restore: () => { globalThis.fetch = original; } };
};

const tabbyVerifyReq = () => ({
  method: 'POST', query: { resource: 'tabby-verify' }, headers: {},
  body: {
    payment_id: 'pay_paidat_1',
    order: {
      id: 'AJ-PAIDAT-1',
      customer: { email: 'buyer@example.com', name: 'T', country_code: 'AE', country_name: 'الإمارات', region: 'دبي', city: 'دبي', address: '1 St' },
      cart: { items: Array.from({ length: 5 }, () => ({ color: 'أسود', size: 'L' })) }
    }
  }
});

const TABBY_ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SECRET_KEY: 'k', RESEND_API_KEY: 'r', TABBY_MODE: 'test', TABBY_PUBLIC_KEY: 'pk', TABBY_SECRET_KEY: 'sk' };

test("Tabby paid_at is Tabby's payment created_at, not the verification time", async () => {
  await withEnv(TABBY_ENV, async () => {
    const { upserts, restore } = tabbyWorld();
    try {
      const res = await commerceHandler(tabbyVerifyReq(), makeRes());
      assert.equal(res.body.paid, true);
      assert.equal(upserts[0].paid_at, '2026-09-18T00:48:37.000Z');
    } finally { restore(); }
  });
});

test('duplicate Tabby verification writes the IDENTICAL paid_at — it can no longer drift', async () => {
  await withEnv(TABBY_ENV, async () => {
    const { upserts, restore } = tabbyWorld();
    try {
      await commerceHandler(tabbyVerifyReq(), makeRes());
      // Real time passes between the two verifications, as it did live.
      await new Promise(r => setTimeout(r, 1100));
      await commerceHandler(tabbyVerifyReq(), makeRes());
      assert.equal(upserts.length, 2);
      assert.equal(upserts[0].paid_at, upserts[1].paid_at, 'paid_at must not move between verifications');
      assert.equal(upserts[1].paid_at, '2026-09-18T00:48:37.000Z');
    } finally { restore(); }
  });
});

test('if Tabby returns no timestamp, paid_at is OMITTED so an existing value is never overwritten', async () => {
  await withEnv(TABBY_ENV, async () => {
    // null = Tabby sends no created_at at all (undefined would just trigger the default).
    const { upserts, restore } = tabbyWorld({ createdAt: null });
    try {
      await commerceHandler(tabbyVerifyReq(), makeRes());
      // merge-duplicates leaves an omitted column untouched on conflict.
      assert.ok(!('paid_at' in upserts[0]), 'paid_at must be omitted, not fabricated as "now"');
    } finally { restore(); }
  });
});

// ---- Stripe unchanged ----------------------------------------------------------

test("Stripe paid_at is unchanged: still Stripe's own session.created, identical across re-deliveries", async () => {
  const SECRET = 'whsec_test_secret';
  const created = 1789000000;
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {
    id: 'cs_paidat_1', payment_status: 'paid', amount_total: 13500, currency: 'aed', payment_intent: 'pi_paidat_1', created,
    customer_details: { email: 'buyer@example.com' },
    metadata: { order_id: 'AJ-STRIPE-PAIDAT', items: 'أسود-L:5', country_code: 'AE', city: 'دبي', product_amount: '13500', shipping_amount: '0' }
  } } });
  const req = () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
    return { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); } };
  };
  await withEnv({ STRIPE_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: 'r', SUPABASE_URL: 'https://supabase.test', SUPABASE_SECRET_KEY: 'k' }, async () => {
    const upserts = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('/rest/v1/orders') && options.method === 'POST') { upserts.push(JSON.parse(options.body)); return { ok: true, status: 201, text: async () => JSON.stringify([{ id: 'o2', fulfillment_status: 'REVIEW_REQUIRED' }]) }; }
      return { ok: true, json: async () => ({}), text: async () => '' };
    };
    try {
      await stripeWebhookHandler(req(), makeRes());
      await stripeWebhookHandler(req(), makeRes());
      const expected = new Date(created * 1000).toISOString();
      assert.equal(upserts[0].paid_at, expected);
      assert.equal(upserts[1].paid_at, expected);
    } finally { globalThis.fetch = original; }
  });
});

// ============================================================================
// 3. REVIEW_REQUIRED KEEPS THE ROUTE AND COST ALREADY CALCULATED
// ============================================================================

const reviewWorld = ({ balance = 0 } = {}) => {
  const patches = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/orders') && options.method === 'PATCH') { patches.push(JSON.parse(options.body)); return { ok: true, status: 204, text: async () => '' }; }
    if (u.includes('getAccessToken')) return { ok: true, json: async () => ({ data: { accessToken: 't', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) };
    if (u.includes('/product/conn/connection')) return { ok: true, json: async () => ({ code: 200, result: true, data: { list: [{ cjVariantId: '1581871544320667650', cjPrice: '2.21' }] } }) };
    if (u.includes('/logistic/freightCalculate')) return { ok: true, json: async () => ({ code: 200, result: true, data: [{ logisticName: 'CJPacket Liquid Line', totalPostageFee: 23.15, logisticAging: '7-10' }] }) };
    if (u.includes('/shopping/pay/getBalance')) return { ok: true, json: async () => ({ code: 200, result: true, data: { amount: balance, freezeAmount: 0, noWithdrawalAmount: 0 } }) };
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { patches, restore: () => { globalThis.fetch = original; } };
};

// Mirrors the real validation order: 10 x أسود-L, 269 AED, Tabby.
const reviewOrderRow = () => ({
  id: 'order-review-1', order_number: 'AJ-REVIEW-1', status: 'paid',
  items: [{ variant: 'أسود-L', quantity: 10 }],
  customer_name: 'Test Buyer', customer_phone: '+971500000000', shipping_street: '1 Test St', shipping_city: 'دبي', shipping_country_code: 'AE',
  product_amount: 26900, shipping_amount: 0, amount_total: 26900,
  stripe_session_id: 'tabby_pay_review_1',
  fulfillment_status: null, fulfillment_external_order_id: null
});

test('an INSUFFICIENT_CJ_BALANCE block persists the selected route, amount required and currency', async () => {
  await withEnv({ SUPABASE_URL: 'https://supabase.test', SUPABASE_SECRET_KEY: 'k', CJ_API_KEY: 'cj' }, async () => {
    const { patches, restore } = reviewWorld({ balance: 0 });
    try {
      const result = await runFulfillmentPreparation(reviewOrderRow(), { maxDeliveryDays: 14, paymentMode: 'balance' });
      assert.equal(result.reason, 'INSUFFICIENT_CJ_BALANCE');
      const p = patches[0];
      assert.equal(p.fulfillment_status, FULFILLMENT_STATE.REVIEW_REQUIRED);
      assert.equal(p.fulfillment_error, 'INSUFFICIENT_CJ_BALANCE');
      assert.equal(p.fulfillment_logistics_method, 'CJPacket Liquid Line', 'the chosen route must be kept');
      assert.equal(p.fulfillment_currency, 'USD');
      assert.ok(p.fulfillment_last_sync_at);
      // product 10 x 2.21 + freight 23.15 + sticker 10 x 0.02 = 45.45
      assert.equal(p.fulfillment_cost, 45.45, 'amount required must be recorded exactly');
    } finally { restore(); }
  });
});

test('the recorded amount required INCLUDES the per-unit sticker, which CJ bills to the wallet', async () => {
  await withEnv({ SUPABASE_URL: 'https://supabase.test', SUPABASE_SECRET_KEY: 'k', CJ_API_KEY: 'cj' }, async () => {
    const { patches, restore } = reviewWorld({ balance: 0 });
    try {
      await runFulfillmentPreparation(reviewOrderRow(), { maxDeliveryDays: 14 });
      const withoutSticker = Number((10 * 2.21 + 23.15).toFixed(2));
      assert.ok(patches[0].fulfillment_cost > withoutSticker, 'must not under-state what CJ will charge');
      assert.equal(Number((patches[0].fulfillment_cost - withoutSticker).toFixed(2)), 0.20);
    } finally { restore(); }
  });
});

test('the payment fee is NOT part of the CJ amount required — it is paid to Tabby/Stripe, not CJ', async () => {
  await withEnv({ SUPABASE_URL: 'https://supabase.test', SUPABASE_SECRET_KEY: 'k', CJ_API_KEY: 'cj' }, async () => {
    const { patches, restore } = reviewWorld({ balance: 0 });
    try {
      await runFulfillmentPreparation(reviewOrderRow(), { maxDeliveryDays: 14 });
      // 45.45 exactly — any Tabby fee (6.99% + AED 1.50) would push it well above.
      assert.equal(patches[0].fulfillment_cost, 45.45);
    } finally { restore(); }
  });
});

test('a block that happens before any route exists (missing city) records no invented route/cost', async () => {
  await withEnv({ SUPABASE_URL: 'https://supabase.test', SUPABASE_SECRET_KEY: 'k', CJ_API_KEY: 'cj' }, async () => {
    const { patches, restore } = reviewWorld({ balance: 0 });
    try {
      await runFulfillmentPreparation({ ...reviewOrderRow(), shipping_city: null }, { maxDeliveryDays: 14 });
      assert.equal(patches[0].fulfillment_error, 'MISSING_SHIPPING_CITY');
      assert.ok(!('fulfillment_logistics_method' in patches[0]));
      assert.ok(!('fulfillment_cost' in patches[0]));
    } finally { restore(); }
  });
});

test('the review write never touches the paid order itself', async () => {
  await withEnv({ SUPABASE_URL: 'https://supabase.test', SUPABASE_SECRET_KEY: 'k', CJ_API_KEY: 'cj' }, async () => {
    const { patches, restore } = reviewWorld({ balance: 0 });
    try {
      await runFulfillmentPreparation(reviewOrderRow(), { maxDeliveryDays: 14 });
      for (const key of ['status', 'amount_total', 'product_amount', 'shipping_amount', 'items', 'paid_at']) {
        assert.ok(!(key in patches[0]), `${key} must not be written by fulfillment`);
      }
    } finally { restore(); }
  });
});

// ============================================================================
// NO PROVIDER DETAIL LEAKS THROUGH CUSTOMER-FACING APIs
// ============================================================================

test('the tabby-verify response to the customer carries no provider internals', async () => {
  await withEnv(TABBY_ENV, async () => {
    const { restore } = tabbyWorld();
    try {
      const res = await commerceHandler(tabbyVerifyReq(), makeRes());
      assert.deepEqual(Object.keys(res.body).sort(), ['order_id', 'paid']);
      const json = JSON.stringify(res.body);
      for (const s of ['cj', 'CJPacket', 'REVIEW_REQUIRED', 'INSUFFICIENT_CJ_BALANCE', 'fulfillment', 'USD']) {
        assert.ok(!json.includes(s), `leaked: ${s}`);
      }
    } finally { restore(); }
  });
});
