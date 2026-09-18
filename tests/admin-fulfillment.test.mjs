// Admin-only CJ fulfillment control: access, re-preparation after funding,
// the one-order-at-a-time explicit submit, route policy, tracking sync and
// customer-safe output. Supabase and CJ are both simulated in memory — no
// network, no real order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import commerce from '../api/commerce.js';
import { selectLogisticsMethod, isExcludedLogisticsMethod, CJ_BALANCE_LOW_WARNING_AED } from '../api/_lib/logistics-policy.js';
import { buildTrackingPatch, effectiveCjStatus } from '../api/_lib/fulfillment-tracking.js';
import { serializeOrderForCustomer } from '../api/_lib/fulfillment-status.js';
import { CJ_VARIANT_MAP } from '../api/_lib/cj-variant-map.js';

// ---- fixtures --------------------------------------------------------------------

// Live CJ freight, 2026-09-18, US, the approved first-order mix (10 units).
const US_10_METHODS = [
  { logisticName: "YunExpress Ordinary", totalPostageFee: 27.48, logisticAging: "4-7" },
  { logisticName: "LuWei Ordinary US", totalPostageFee: 25.83, logisticAging: "5-11" },
  { logisticName: "YunExpress Sensitive", totalPostageFee: 31.98, logisticAging: "4-7" },
  { logisticName: "CJPacket Ordinary", totalPostageFee: 32.06, logisticAging: "4-9" },
  { logisticName: "CJPacket Sensitive", totalPostageFee: 34.69, logisticAging: "4-9" },
  { logisticName: "CJPacket Eub", totalPostageFee: 36.53, logisticAging: "12-50" },
  { logisticName: "CJPacket Fast Ordinary", totalPostageFee: 38.41, logisticAging: "4-6" },
  { logisticName: "CJPacket Eub Special Line", totalPostageFee: 39.86, logisticAging: "10-23" },
  { logisticName: "CJPacket Liquid US", totalPostageFee: 41.38, logisticAging: "5-11" },
  { logisticName: "CJPacket FJTY Eub Special Line", totalPostageFee: 43.29, logisticAging: "15-25" },
  { logisticName: "CJPacket Sensitive Pro+", totalPostageFee: 43.56, logisticAging: "6-11" },
  { logisticName: "CJPacket Super Pure Electricity", totalPostageFee: 44.22, logisticAging: "5-11" },
  { logisticName: "CJPacket Pure Electricity", totalPostageFee: 44.22, logisticAging: "7-14" },
  { logisticName: "USPS", totalPostageFee: 43.66, logisticAging: "4-9" },
  { logisticName: "USPS Ordinary", totalPostageFee: 40.74, logisticAging: "5-11" },
  { logisticName: "CJPacket Ordinary Over Length", totalPostageFee: 44.84, logisticAging: "7-11" },
  { logisticName: "CJPacket Fast Line", totalPostageFee: 46.28, logisticAging: "4-9" },
  { logisticName: "CJPacket Fast US", totalPostageFee: 46.58, logisticAging: "7-12" },
  { logisticName: "Qfulfillment A line", totalPostageFee: 47.65, logisticAging: "10-25" },
  { logisticName: "CJPacket Liquid Line", totalPostageFee: 48.52, logisticAging: "20-60" },
  { logisticName: "CJPacket Ordinary Oversize Line", totalPostageFee: 48.55, logisticAging: "7-15" },
  { logisticName: "CJPacket LX Sensitive Plant", totalPostageFee: 51.74, logisticAging: "8-20" },
  { logisticName: "CJPacket Sensitive Over Length", totalPostageFee: 51.42, logisticAging: "7-12" },
  { logisticName: "CJPacket Sensitive Oversize Line", totalPostageFee: 52.17, logisticAging: "8-16" },
  { logisticName: "DHL Official", totalPostageFee: 54.56, logisticAging: "3-7" },
  { logisticName: "CJPacket USPS Remote", totalPostageFee: 60.29, logisticAging: "5-10" },
  { logisticName: "CJPacket Postal", totalPostageFee: 61.38, logisticAging: "5-9" },
  { logisticName: "CJPacket Sea", totalPostageFee: 82.98, logisticAging: "25-30" }
];
// Live CJ freight, 2026-09-18, UAE, 5 x Black L.
const AE_5_METHODS = [
  { logisticName: "CJPacket Eub", totalPostageFee: 10.52, logisticAging: "12-50" },
  { logisticName: "CJPacket Eub Special Line", totalPostageFee: 12.46, logisticAging: "8-15" },
  { logisticName: "CJPacket Liquid Line", totalPostageFee: 13.25, logisticAging: "7-10" },
  { logisticName: "CJPacket Ordinary", totalPostageFee: 16.19, logisticAging: "7-11" },
  { logisticName: "CJPacket Sensitive", totalPostageFee: 16.85, logisticAging: "7-11" },
  { logisticName: "CJPacket Postal", totalPostageFee: 17.96, logisticAging: "12-50" },
  { logisticName: "PostNL", totalPostageFee: 32.61, logisticAging: "15-45" },
  { logisticName: "DHL Official", totalPostageFee: 118.44, logisticAging: "3-5" }
];
// Live CJ freight, 2026-09-18, UAE, the approved 10-unit mix.
const AE_10_METHODS = [
  { logisticName: "CJPacket Eub", totalPostageFee: 19.03, logisticAging: "12-50" },
  { logisticName: "CJPacket Eub Special Line", totalPostageFee: 22.98, logisticAging: "8-15" },
  { logisticName: "CJPacket Liquid Line", totalPostageFee: 23.43, logisticAging: "7-10" },
  { logisticName: "CJPacket Ordinary", totalPostageFee: 27.54, logisticAging: "7-11" },
  { logisticName: "CJPacket Sensitive", totalPostageFee: 28.87, logisticAging: "7-11" },
  { logisticName: "CJPacket Postal", totalPostageFee: 31.64, logisticAging: "12-50" },
  { logisticName: "PostNL", totalPostageFee: 60.99, logisticAging: "15-45" },
  { logisticName: "DHL Official", totalPostageFee: 151.23, logisticAging: "3-5" }
];

// The approved first US order: 2 Black L, 2 Black XL, 1 each Navy/Gray/White L and XL.
const FIRST_ORDER_ITEMS = [['أسود-L', 2], ['أسود-XL', 2], ['كحلي-L', 1], ['كحلي-XL', 1], ['رمادي-L', 1], ['رمادي-XL', 1], ['أبيض-L', 1], ['أبيض-XL', 1]].map(([variant, quantity]) => ({ variant, quantity }));
const vidOf = (key) => CJ_VARIANT_MAP.find(v => v.ajlibKey === key).cjVariantId;

const baseOrder = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  order_number: 'AJ10000001',
  status: 'paid',
  items: FIRST_ORDER_ITEMS,
  product_amount: 26900, shipping_amount: 15000, amount_total: 41900, currency: 'aed',
  shipping_country_code: 'US', shipping_country_name: 'United States', shipping_region: 'California',
  shipping_city: 'Lake Forest', shipping_address: 'Test street 1', shipping_postal_code: '92630',
  customer_name: 'Owner Test', customer_phone: '+10000000000', customer_email: 'owner@example.com',
  stripe_session_id: 'cs_live_test', tracking_number: null, shipping_company: null,
  fulfillment_status: 'REVIEW_REQUIRED', fulfillment_error: 'INSUFFICIENT_CJ_BALANCE',
  fulfillment_external_order_id: null,
  ...over
});

// ---- in-memory Supabase + CJ ---------------------------------------------------------

const world = ({ orders = [baseOrder()], balanceUSD = 85, methods = US_10_METHODS, cj = {} } = {}) => {
  const db = new Map(orders.map(o => [o.id, { ...o }]));
  const calls = { create: [], cj: [], dbPatches: [], orderReads: 0 };
  const matches = (row, params) => {
    for (const [key, value] of params) {
      if (['select', 'order', 'limit'].includes(key)) continue;
      if (value === 'is.null') { if (row[key] != null) return false; continue; }
      if (value.startsWith('eq.') && String(row[key]) !== value.slice(3)) return false;
    }
    return true;
  };
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const method = options.method || 'GET';
    if (u.pathname.endsWith('/rpc/is_admin')) {
      const auth = options.headers?.Authorization || '';
      return ok(auth === 'Bearer admin-token');
    }
    if (u.pathname.endsWith('/rest/v1/shipping_zones')) return { ok: false, status: 404, json: async () => ({}) };
    if (u.pathname.endsWith('/rest/v1/orders')) {
      const rows = [...db.values()].filter(r => matches(r, u.searchParams));
      if (method === 'GET') { calls.orderReads += 1; return ok(rows.map(r => ({ ...r }))); }
      if (method === 'PATCH') {
        const patch = JSON.parse(options.body);
        calls.dbPatches.push({ filter: u.search, patch });
        for (const r of rows) Object.assign(r, patch);
        return ok((options.headers?.Prefer || '').includes('representation') ? rows.map(r => ({ id: r.id })) : []);
      }
    }
    if (u.hostname.includes('cjdropshipping')) {
      calls.cj.push(u.pathname);
      if (u.pathname.endsWith('/authentication/getAccessToken')) return ok({ code: 200, result: true, data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } });
      if (u.pathname.endsWith('/product/conn/connection')) return ok({ code: 200, result: true, data: { list: CJ_VARIANT_MAP.map(v => ({ cjVariantId: v.cjVariantId, cjPrice: '2.21' })) } });
      if (u.pathname.endsWith('/logistic/freightCalculate')) return ok({ code: 200, result: true, data: methods });
      if (u.pathname.endsWith('/shopping/pay/getBalance')) return ok({ code: 200, result: true, data: { amount: balanceUSD, freezeAmount: 0, noWithdrawalAmount: 0 } });
      if (u.pathname.endsWith('/shopping/order/createOrderV2')) {
        calls.create.push(JSON.parse(options.body));
        return ok(cj.createResponse || { code: 200, result: true, data: { orderId: 'CJ-ORDER-1', orderNumber: JSON.parse(options.body).orderNumber, orderStatus: 'CREATED' } });
      }
      if (u.pathname.endsWith('/shopping/order/getOrderDetail')) return ok(cj.detail || { code: 200, result: true, data: { orderStatus: 'CREATED' } });
      if (u.pathname.endsWith('/logistic/trackInfo')) { calls.track = u.searchParams.get('trackNumber'); return ok(cj.track || { code: 200, result: true, data: [] }); }
      if (u.pathname.endsWith('/shopping/order/list')) return ok({ code: 200, result: true, data: { list: [] } });
    }
    throw new Error(`unexpected fetch ${method} ${u}`);
  };
  return { db, calls, fetch };
};

const ENV = { SUPABASE_URL: 'https://db.example.co', SUPABASE_SECRET_KEY: 'service_x', SUPABASE_PUBLISHABLE_KEY: 'pub_x', CJ_API_KEY: 'cj_x' };
const run = async (w, { token = 'admin-token', method = 'POST', body = {}, env = {} } = {}) => {
  const saved = {}; const vars = { ...ENV, ...env };
  for (const k of [...Object.keys(vars), 'CJ_LIVE_ORDER_CREATION_ENABLED']) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  if (!('CJ_LIVE_ORDER_CREATION_ENABLED' in env)) delete process.env.CJ_LIVE_ORDER_CREATION_ENABLED;
  const original = globalThis.fetch; globalThis.fetch = w.fetch;
  const res = { statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  try {
    await commerce({ method, query: { resource: 'admin-fulfillment' }, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
    return res;
  } finally {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const ORDER_ID = baseOrder().id;

// ---- access ----------------------------------------------------------------------------

test('admin-only: no token 401, a customer 403 — before any order or CJ call', async () => {
  const w = world();
  assert.equal((await run(w, { token: null, body: { action: 'status', order_id: ORDER_ID } })).statusCode, 401);
  const customer = await run(w, { token: 'customer-token', body: { action: 'submit', order_id: ORDER_ID, confirm_order_number: 'AJ10000001' }, env: { CJ_LIVE_ORDER_CREATION_ENABLED: 'true' } });
  assert.equal(customer.statusCode, 403);
  assert.equal(w.calls.orderReads, 0);
  assert.equal(w.calls.cj.length, 0);
  assert.equal((await run(w, { method: 'GET', body: {} })).statusCode, 405);
});

test('the admin route is reachable only through the commerce dispatcher and is never cached', async () => {
  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(vercel.rewrites.some(r => r.source === '/api/admin-fulfillment' && r.destination === '/api/commerce?resource=admin-fulfillment'));
  const res = await run(world(), { body: { action: 'status', order_id: ORDER_ID } });
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
});

// ---- re-preparation ----------------------------------------------------------------------

test('an order stuck in REVIEW_REQUIRED (empty wallet) becomes READY_FOR_CJ once the wallet is funded', async () => {
  const w = world({ balanceUSD: 85 });
  const res = await run(w, { body: { action: 'reprepare', order_id: ORDER_ID } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'READY_FOR_CJ');
  assert.equal(res.body.route.method, 'YunExpress Ordinary');
  assert.equal(res.body.requiredUSD, 49.78); // 10 x 2.21 + 27.48 (live YunExpress) + 10 x 0.02
  assert.equal(res.body.margin.band, 'GREEN');
  assert.equal(res.body.payload.payType, 2);
  assert.equal(res.body.payload.orderNumber, 'AJLIB-AJ10000001');
  const row = w.db.get(ORDER_ID);
  assert.equal(row.fulfillment_status, 'READY_FOR_CJ');
  assert.equal(row.fulfillment_error, null);
  assert.equal(row.status, 'paid', 'the customer order itself is untouched');
  assert.equal(w.calls.create.length, 0, 're-preparation never creates a CJ order');
});

test('the low-balance warning does not block an affordable order; an insufficient balance does', async () => {
  assert.equal(CJ_BALANCE_LOW_WARNING_AED, 150);
  // $85 - $49.78 leaves ~129 AED: below the 150 AED warning, still affordable.
  const warned = await run(world({ balanceUSD: 85 }), { body: { action: 'reprepare', order_id: ORDER_ID } });
  assert.equal(warned.body.outcome, 'READY_FOR_CJ');
  assert.equal(warned.body.balance.lowBalanceWarning, true);
  const w = world({ balanceUSD: 49.77 });
  const blocked = await run(w, { body: { action: 'reprepare', order_id: ORDER_ID } });
  assert.equal(blocked.body.outcome, 'REVIEW_REQUIRED');
  assert.equal(blocked.body.reason, 'INSUFFICIENT_CJ_BALANCE');
  assert.equal(w.db.get(ORDER_ID).fulfillment_status, 'REVIEW_REQUIRED');
});

test('re-preparation is refused once a CJ order exists or while a submission is in flight', async () => {
  for (const over of [{ fulfillment_external_order_id: 'CJ-9', fulfillment_status: 'CREATED' }, { fulfillment_status: 'SUBMITTING' }, { fulfillment_status: 'SHIPPED' }]) {
    const w = world({ orders: [baseOrder(over)] });
    const res = await run(w, { body: { action: 'reprepare', order_id: ORDER_ID } });
    assert.equal(res.statusCode, 409, JSON.stringify(over));
    assert.equal(w.calls.cj.length, 0);
  }
});

// ---- submission ----------------------------------------------------------------------------

const ready = () => baseOrder({ fulfillment_status: 'READY_FOR_CJ', fulfillment_error: null });
const submitBody = { action: 'submit', order_id: ORDER_ID, confirm_order_number: 'AJ10000001' };

test('submit requires CJ_LIVE_ORDER_CREATION_ENABLED=true: with it off nothing is claimed or called', async () => {
  const w = world({ orders: [ready()] });
  const res = await run(w, { body: submitBody });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.outcome, 'LIVE_ORDER_CREATION_DISABLED');
  assert.equal(w.calls.dbPatches.length, 0);
  assert.equal(w.calls.cj.length, 0);
  assert.equal(w.db.get(ORDER_ID).fulfillment_status, 'READY_FOR_CJ');
});

test('submit requires typing the exact order number', async () => {
  const w = world({ orders: [ready()] });
  const res = await run(w, { body: { ...submitBody, confirm_order_number: 'AJ10000002' }, env: { CJ_LIVE_ORDER_CREATION_ENABLED: 'true' } });
  assert.equal(res.statusCode, 400);
  assert.equal(w.calls.create.length, 0);
});

test('submit sends exactly one createOrderV2 (payType=2, preferred route), records the CJ id, and a second submit is refused', async () => {
  const w = world({ orders: [ready()] });
  const env = { CJ_LIVE_ORDER_CREATION_ENABLED: 'true' };
  const first = await run(w, { body: submitBody, env });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.outcome, 'SUBMITTED');
  assert.equal(w.calls.create.length, 1);
  const payload = w.calls.create[0];
  assert.equal(payload.payType, 2);
  assert.equal(payload.logisticName, 'YunExpress Ordinary');
  assert.equal(payload.orderNumber, 'AJLIB-AJ10000001');
  assert.deepEqual(payload.products, FIRST_ORDER_ITEMS.map(i => ({ vid: vidOf(i.variant), quantity: i.quantity })));
  assert.equal(payload.products.reduce((n, p) => n + p.quantity, 0), 10);
  const row = w.db.get(ORDER_ID);
  assert.equal(row.fulfillment_external_order_id, 'CJ-ORDER-1');
  assert.notEqual(row.fulfillment_status, 'SUBMITTING');
  const second = await run(w, { body: submitBody, env });
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.outcome, 'ALREADY_SUBMITTED');
  assert.equal(w.calls.create.length, 1, 'never a second CJ order');
});

test('two simultaneous submits for the same order create exactly one CJ order', async () => {
  const w = world({ orders: [ready()] });
  const env = { CJ_LIVE_ORDER_CREATION_ENABLED: 'true' };
  const [a, b] = await Promise.all([run(w, { body: submitBody, env }), run(w, { body: submitBody, env })]);
  assert.equal(w.calls.create.length, 1);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
});

test('one order at a time: while another order is SUBMITTING, nothing else is claimed', async () => {
  const other = baseOrder({ id: '22222222-2222-4222-8222-222222222222', order_number: 'AJ10000002', fulfillment_status: 'SUBMITTING' });
  const w = world({ orders: [ready(), other] });
  const res = await run(w, { body: submitBody, env: { CJ_LIVE_ORDER_CREATION_ENABLED: 'true' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.outcome, 'ANOTHER_SUBMISSION_IN_PROGRESS');
  assert.equal(w.db.get(ORDER_ID).fulfillment_status, 'READY_FOR_CJ');
  assert.equal(w.calls.create.length, 0);
});

test('submit re-checks live: an order whose wallet emptied since preparation is not sent', async () => {
  const w = world({ orders: [ready()], balanceUSD: 10 });
  const res = await run(w, { body: submitBody, env: { CJ_LIVE_ORDER_CREATION_ENABLED: 'true' } });
  assert.equal(res.body.outcome, 'BLOCKED_ON_RECHECK');
  assert.equal(res.body.reason, 'INSUFFICIENT_CJ_BALANCE');
  assert.equal(w.calls.create.length, 0);
  assert.equal(w.db.get(ORDER_ID).fulfillment_status, 'REVIEW_REQUIRED');
});

test('only an admin action can submit: no payment path or other module calls submitReadyOrder', async () => {
  const files = ['api/stripe-webhook.js', 'api/commerce.js', 'api/_lib/fulfillment-runner.js', 'api/checkout-session.js', 'api/cj-webhook.js'];
  for (const file of files) {
    const code = (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replace(/\/\/[^\n]*/g, '');
    assert.ok(!/submitReadyOrder\(/.test(code), `${file} must not submit`);
  }
  const admin = await readFile(new URL('../api/_lib/admin-fulfillment.js', import.meta.url), 'utf8');
  assert.match(admin, /if \(!isLiveOrderCreationEnabled\(\)\) return/);
});

// ---- route policy --------------------------------------------------------------------------

test('US prefers YunExpress Ordinary when CJ offers it inside the promise', () => {
  const sel = selectLogisticsMethod(US_10_METHODS, { countryCode: 'US', maxDeliveryDays: 16 });
  assert.equal(sel.method, 'YunExpress Ordinary');
  assert.equal(sel.reason, 'PREFERRED_METHOD');
  assert.equal(sel.fallback.method, 'LuWei Ordinary US');
});

test('without YunExpress the US order uses the cheapest appropriate route (LuWei)', () => {
  const sel = selectLogisticsMethod(US_10_METHODS.filter(m => m.logisticName !== 'YunExpress Ordinary'), { countryCode: 'US', maxDeliveryDays: 16 });
  assert.equal(sel.method, 'LuWei Ordinary US');
  assert.equal(sel.reason, 'CHEAPEST_MEETING_PROMISE');
});

test('the preference applies to the US only; other markets stay cheapest-appropriate', () => {
  assert.equal(selectLogisticsMethod(US_10_METHODS, { countryCode: 'SA', maxDeliveryDays: 16 }).method, 'LuWei Ordinary US');
});

test('routes are never rejected by name: UAE keeps CJPacket Liquid Line when CJ returns it (5 and 10 units)', () => {
  const ae5 = selectLogisticsMethod(AE_5_METHODS, { countryCode: 'AE', maxDeliveryDays: 14 });
  assert.equal(ae5.method, 'CJPacket Liquid Line');
  assert.equal(ae5.cost, 13.25);
  assert.equal(ae5.reason, 'CHEAPEST_MEETING_PROMISE');
  const ae10 = selectLogisticsMethod(AE_10_METHODS, { countryCode: 'AE', maxDeliveryDays: 14 });
  assert.equal(ae10.method, 'CJPacket Liquid Line');
  assert.equal(ae10.cost, 23.43);
  assert.equal(ae10.fallback, undefined, 'no preference applies outside the US');
  for (const name of ['CJPacket Liquid Line', 'CJPacket Sensitive', 'CJPacket Pure Electricity', 'CJPacket Sea', 'CJPacket USPS Remote']) {
    assert.equal(isExcludedLogisticsMethod(name), false, name);
  }
});

test('the approved first US order resolves to exactly 10 units through the confirmed 16-variant map', () => {
  assert.equal(FIRST_ORDER_ITEMS.reduce((n, i) => n + i.quantity, 0), 10);
  for (const item of FIRST_ORDER_ITEMS) {
    const mapped = CJ_VARIANT_MAP.find(v => v.ajlibKey === item.variant);
    assert.ok(mapped && /^\d{19}$/.test(mapped.cjVariantId), item.variant);
  }
  const us = selectLogisticsMethod(US_10_METHODS, { countryCode: 'US', maxDeliveryDays: 16 });
  assert.equal(us.method, 'YunExpress Ordinary');
  assert.equal(us.cost, 27.48);
  assert.equal(us.agingDays, 7);
});

test('if the preferred route would miss the 25% band, the cheaper appropriate route is used instead', async () => {
  // At 250 AED collected: YunExpress lands just under 25%, LuWei just over.
  const w = world({ orders: [baseOrder({ product_amount: 25000, shipping_amount: 0 })], balanceUSD: 85 });
  const res = await run(w, { body: { action: 'reprepare', order_id: ORDER_ID } });
  assert.equal(res.body.outcome, 'READY_FOR_CJ');
  assert.equal(res.body.route.method, 'LuWei Ordinary US');
  assert.equal(res.body.route.reason, 'PREFERRED_MISSED_MARGIN_FALLBACK');
});

// ---- tracking --------------------------------------------------------------------------------

const submitted = (over = {}) => baseOrder({ fulfillment_status: 'CREATED', fulfillment_error: null, fulfillment_external_order_id: 'CJ-ORDER-1', ...over });

test('CJ UNSHIPPED/PROCESSING shows the customer "Preparing shipment" and stores CJ status internally', () => {
  assert.equal(effectiveCjStatus({ orderStatus: 'UNSHIPPED', subStatus: 'PROCESSING' }), 'PROCESSING');
  const { patch } = buildTrackingPatch(submitted(), { orderStatus: 'UNSHIPPED', subStatus: 'PROCESSING' }, null, 'T');
  assert.equal(patch.fulfillment_status, 'PROCESSING');
  assert.equal(patch.status, 'packed');
  assert.equal(serializeOrderForCustomer({ ...submitted(), ...patch }).status, 'PREPARING_SHIPMENT');
  assert.equal(patch.tracking_number, undefined, 'no customer tracking before shipping');
});

test('tracking sync (admin): SHIPPED stores number, carrier and URL, and the customer sees SHIPPED with tracking only', async () => {
  const w = world({
    orders: [submitted()],
    cj: {
      detail: { code: 200, result: true, data: { orderStatus: 'SHIPPED', trackNumber: 'YT123', trackingProvider: 'YunExpress', trackingUrl: 'https://track.example/YT123', logisticName: 'YunExpress Ordinary' } },
      track: { code: 200, result: true, data: [{ trackingNumber: 'YT123', logisticName: 'YunExpress Ordinary', trackingStatus: 'In transit', lastMileCarrier: 'USPS', lastTrackNumber: '9400100000000000000000' }] }
    }
  });
  const res = await run(w, { body: { action: 'sync-tracking', order_id: ORDER_ID } });
  assert.equal(res.statusCode, 200);
  assert.equal(w.calls.track, 'YT123', 'the official trackInfo endpoint is queried with CJ\'s tracking number');
  const row = w.db.get(ORDER_ID);
  assert.equal(row.fulfillment_status, 'SHIPPED');
  assert.equal(row.fulfillment_tracking_number, 'YT123');
  assert.equal(row.fulfillment_carrier, 'USPS');
  assert.equal(row.fulfillment_tracking_url, 'https://track.example/YT123');
  assert.ok(row.fulfillment_last_sync_at);
  assert.equal(row.status, 'shipped');
  assert.equal(row.tracking_number, '9400100000000000000000');
  assert.equal(row.shipping_company, 'USPS');
  const customer = res.body.customer;
  assert.equal(customer.status, 'SHIPPED');
  assert.ok(['ORDER_RECEIVED', 'PREPARING_ORDER', 'PREPARING_SHIPMENT', 'SHIPPED', 'DELIVERED'].includes(customer.status));
  for (const key of Object.keys(customer)) assert.ok(!/fulfillment|cj|stripe|provider/i.test(key), `customer output leaks ${key}`);
  assert.ok(!JSON.stringify(customer).includes('CJ-ORDER-1'));
  assert.equal(w.calls.create.length, 0, 'tracking never creates orders');
});

test('tracking never regresses, never overwrites admin-entered tracking, and a CJ cancellation only flags ops', () => {
  const delivered = submitted({ status: 'delivered' });
  assert.equal(buildTrackingPatch(delivered, { orderStatus: 'SHIPPED' }, null).patch.status, undefined);
  const manual = submitted({ status: 'shipped', tracking_number: 'MANUAL-1', shipping_company: 'Aramex' });
  const { patch } = buildTrackingPatch(manual, { orderStatus: 'SHIPPED', trackNumber: 'YT1' }, { trackingNumber: 'YT1', lastTrackNumber: 'L1', lastMileCarrier: 'USPS' });
  assert.equal(patch.tracking_number, undefined);
  assert.equal(patch.shipping_company, undefined);
  const cancelled = buildTrackingPatch(submitted(), { orderStatus: 'CANCELLED' }, null).patch;
  assert.equal(cancelled.status, undefined, 'a paid customer order is never auto-cancelled');
  assert.equal(cancelled.fulfillment_error, 'CJ_ORDER_CANCELLED');
});

test('a failed CJ read writes nothing', async () => {
  const w = world({ orders: [submitted()], cj: { detail: { code: 1600200, result: false, message: 'Too Many Requests' } } });
  const res = await run(w, { body: { action: 'sync-tracking', order_id: ORDER_ID } });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.reason, 'CJ_ORDER_DETAIL_ERROR');
  assert.equal(w.calls.dbPatches.length, 0);
});
