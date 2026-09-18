// End-to-end: verified AJLIB payment -> preparation -> automatic UNPAID CJ
// order -> owner alert -> CJ payment detected by the sync -> tracking.
// Supabase (with real conditional-update semantics), CJ, Resend and Tabby are
// simulated in memory; nothing leaves the process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import stripeWebhook from '../api/stripe-webhook.js';
import commerce from '../api/commerce.js';
import { syncTracking } from '../api/_lib/fulfillment-tracking.js';
import { serializeOrderForCustomer } from '../api/_lib/fulfillment-status.js';
import { CJ_VARIANT_MAP } from '../api/_lib/cj-variant-map.js';

// ---- simulated services --------------------------------------------------------------

const US_METHODS = [
  { logisticName: 'LuWei Ordinary US', totalPostageFee: 25.83, logisticAging: '5-11' },
  { logisticName: 'YunExpress Ordinary', totalPostageFee: 27.48, logisticAging: '4-7' },
  { logisticName: 'DHL Official', totalPostageFee: 54.56, logisticAging: '3-7' }
];

// PostgREST-style row conditions: eq, is.null, not.is.null, in, not.in, or=(...)
const cond = (row, key, v) => {
  if (v === 'is.null') return row[key] == null;
  if (v === 'not.is.null') return row[key] != null;
  if (v.startsWith('eq.')) return String(row[key]) === v.slice(3);
  let m = v.match(/^in\.\((.*)\)$/); if (m) return m[1].split(',').includes(String(row[key]));
  m = v.match(/^not\.in\.\((.*)\)$/); if (m) return row[key] != null && !m[1].split(',').includes(String(row[key]));
  return true;
};
const matches = (row, params) => {
  for (const [key, value] of params) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(key)) continue;
    if (key === 'or') {
      const parts = [...value.matchAll(/(\w+)\.(is\.null|in\.\([^)]*\)|eq\.[^,)]+)/g)];
      if (!parts.some(([, k, op]) => cond(row, k, op))) return false;
      continue;
    }
    if (!cond(row, key, value)) return false;
  }
  return true;
};

const world = ({ methods = US_METHODS, cjDetail = null } = {}) => {
  const orders = new Map();
  const cjOrders = [];
  const log = { creates: [], emails: [], cj: [] };
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const method = options.method || 'GET';
    if (u.pathname.endsWith('/rest/v1/orders')) {
      if (method === 'POST') { // saveOrder upsert on stripe_session_id
        const body = JSON.parse(options.body);
        let row = [...orders.values()].find(r => r.stripe_session_id === body.stripe_session_id);
        if (row) Object.assign(row, body);
        else { row = { id: crypto.randomUUID(), status: 'paid', fulfillment_status: null, fulfillment_external_order_id: null, ...body }; orders.set(row.id, row); }
        return json([{ ...row }], 201);
      }
      const rows = [...orders.values()].filter(r => matches(r, u.searchParams));
      if (method === 'GET') return json(rows.map(r => ({ ...r })));
      if (method === 'PATCH') {
        const patch = JSON.parse(options.body);
        for (const r of rows) Object.assign(r, patch);
        return (options.headers?.Prefer || '').includes('representation') ? json(rows.map(r => ({ id: r.id }))) : { ok: true, status: 204, text: async () => '' };
      }
    }
    if (u.pathname.endsWith('/rest/v1/shipping_zones')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    if (u.pathname.endsWith('/rpc/process_paid_inventory') || u.pathname.endsWith('/rpc/check_inventory')) return json([]);
    if (u.hostname === 'api.resend.com') { log.emails.push(JSON.parse(options.body)); return json({ id: 'email' }); }
    if (u.hostname === 'api.tabby.ai') return json({ id: 'pay_tabby_1', status: 'CLOSED', amount: '419.00', currency: 'AED', created_at: '2026-09-18T10:00:00Z' });
    if (u.hostname.includes('cjdropshipping')) {
      log.cj.push(u.pathname);
      if (u.pathname.endsWith('/authentication/getAccessToken')) return json({ code: 200, result: true, data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } });
      if (u.pathname.endsWith('/product/conn/connection')) return json({ code: 200, result: true, data: { list: CJ_VARIANT_MAP.map(v => ({ cjVariantId: v.cjVariantId, cjPrice: '2.21' })) } });
      if (u.pathname.endsWith('/logistic/freightCalculate')) return json({ code: 200, result: true, data: methods });
      if (u.pathname.endsWith('/shopping/order/list')) return json({ code: 200, result: true, data: { list: cjOrders.map(o => ({ ...o })) } });
      if (u.pathname.endsWith('/shopping/order/createOrderV2')) {
        const body = JSON.parse(options.body);
        log.creates.push(body);
        const orderId = `CJ-${log.creates.length}`;
        cjOrders.push({ orderNum: body.orderNumber, orderId, orderStatus: 'UNPAID' });
        return json({ code: 200, result: true, data: { orderId, orderNumber: body.orderNumber, cjPayUrl: `https://cjdropshipping.com/pay/${orderId}`, orderStatus: 'UNPAID' } });
      }
      if (u.pathname.endsWith('/shopping/order/getOrderDetail')) return json(cjDetail ? cjDetail() : { code: 200, result: true, data: { orderStatus: 'UNPAID' } });
      if (u.pathname.endsWith('/logistic/trackInfo')) return json({ code: 200, result: true, data: [{ trackingNumber: 'YT1', trackingStatus: 'In transit', lastMileCarrier: 'USPS', lastTrackNumber: '9400100000000000000001' }] });
    }
    throw new Error(`unexpected fetch ${method} ${u}`);
  };
  return { orders, cjOrders, log, fetch, only: () => [...orders.values()][0] };
};

const SECRET = 'whsec_auto';
const BASE_ENV = { STRIPE_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: 're_test', SUPABASE_URL: 'https://db.example.co', SUPABASE_SECRET_KEY: 's', SUPABASE_PUBLISHABLE_KEY: 'p', CJ_API_KEY: 'cj' };
const SWITCHES = ['CJ_AUTO_CREATE_ENABLED', 'CJ_LIVE_ORDER_CREATION_ENABLED', 'TABBY_MODE', 'TABBY_SECRET_KEY', 'TABBY_PUBLIC_KEY', 'CRON_SECRET'];
const within = async (w, env, fn) => {
  const vars = { ...BASE_ENV, ...env };
  const saved = Object.fromEntries([...Object.keys(vars), ...SWITCHES].map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  for (const k of SWITCHES) if (!(k in env)) delete process.env[k];
  const original = globalThis.fetch; globalThis.fetch = w.fetch;
  try { return await fn(); } finally {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const AUTO_ON = { CJ_AUTO_CREATE_ENABLED: 'true' };

const res = () => { const r = { statusCode: null, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = () => {}; return r; };
const signed = (payload) => { const t = Math.floor(Date.now() / 1000); return { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${crypto.createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex')}` }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); } }; };

// A 10-piece US order as the storefront submits it (any colour/size mix).
const paidEvent = (metadata = {}) => JSON.stringify({ type: 'checkout.session.completed', data: { object: {
  id: 'cs_live_auto_1', payment_status: 'paid', client_reference_id: 'AJ30000001', amount_total: 41900, currency: 'aed', created: 1789000000,
  customer_details: { email: 'owner@example.com' },
  metadata: {
    order_id: 'AJ30000001', items: 'أسود-L:4,كحلي-XL:3,أبيض-M:3', customer_name: 'Abdulla Albreiki', phone: '+16506531606',
    country_code: 'US', country_name: 'الولايات المتحدة', region: 'California', city: 'Lake Forest', street: '528 Catalonia', street2: '',
    postal_code: '92630', address: '528 Catalonia, Lake Forest, California, الولايات المتحدة, 92630',
    product_amount: '26900', shipping_amount: '15000', shipping_zone: 'AMERICAS', ...metadata
  }
} } });
const pay = async (w, env, metadata) => within(w, env, async () => { const r = res(); await stripeWebhook(signed(paidEvent(metadata)), r); return r; });
const payAlerts = (w) => w.log.emails.filter(e => /pay CJ order/.test(e.subject));
const reviewAlerts = (w) => w.log.emails.filter(e => /review AJLIB order/.test(e.subject));

// ---- automatic creation ---------------------------------------------------------------------

test('a verified Stripe payment automatically creates ONE unpaid CJ order and alerts the owner', async () => {
  const w = world();
  const r = await pay(w, AUTO_ON);
  assert.equal(r.statusCode, 200);
  assert.equal(w.log.creates.length, 1);
  const payload = w.log.creates[0];
  assert.equal(payload.payType, 1, 'created unpaid: no automatic CJ payment');
  assert.equal(payload.orderNumber, 'AJLIB-AJ30000001');
  assert.equal(payload.logisticName, 'YunExpress Ordinary');
  assert.equal(payload.shippingCountry, 'United States');
  assert.equal(payload.shippingAddress, '528 Catalonia');
  assert.equal(payload.products.reduce((n, p) => n + p.quantity, 0), 10, 'variants come from the paid order itself');
  assert.ok(!w.log.cj.some(p => /getBalance|payBalance|confirmOrder/.test(p)), 'wallet never read or spent');
  const row = w.only();
  assert.equal(row.fulfillment_status, 'WAITING_FOR_CJ_PAYMENT');
  assert.equal(row.fulfillment_external_order_id, 'CJ-1');
  assert.equal(row.fulfillment_payment_url, 'https://cjdropshipping.com/pay/CJ-1');
  assert.equal(row.status, 'processing');
  assert.equal(serializeOrderForCustomer(row).status, 'PREPARING_ORDER');
  const alerts = payAlerts(w);
  assert.equal(alerts.length, 1);
  for (const text of ['PAY THIS ORDER IN CJ', 'AJ30000001', 'CJ-1', 'Lake Forest', '10 pieces', 'YunExpress Ordinary', 'USD 49.78']) assert.ok(alerts[0].html.includes(text), text);
  assert.ok(row.fulfillment_alert_sent_at);
});

test('with CJ_AUTO_CREATE_ENABLED off, the order is only prepared (READY_FOR_CJ) — no CJ order, no alert', async () => {
  const w = world();
  await pay(w, {});
  assert.equal(w.log.creates.length, 0);
  assert.equal(w.only().fulfillment_status, 'READY_FOR_CJ');
  assert.equal(w.only().status, 'paid');
  assert.equal(payAlerts(w).length, 0);
});

test('a duplicate payment webhook never creates a second CJ order or a second alert', async () => {
  const w = world();
  await pay(w, AUTO_ON);
  await pay(w, AUTO_ON);
  assert.equal(w.log.creates.length, 1);
  assert.equal(payAlerts(w).length, 1);
  assert.equal(w.only().fulfillment_external_order_id, 'CJ-1');
});

test('two concurrent deliveries of the same payment create exactly one CJ order', async () => {
  const w = world();
  const [a, b] = await Promise.all([pay(w, AUTO_ON), pay(w, AUTO_ON)]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(w.log.creates.length, 1);
  assert.equal(w.only().fulfillment_status, 'WAITING_FOR_CJ_PAYMENT');
});

// ---- anything wrong -> REVIEW_REQUIRED, never a CJ order ---------------------------------------

test('a missing street goes to REVIEW_REQUIRED with a clear reason, and the owner is asked to review', async () => {
  const w = world();
  await pay(w, AUTO_ON, { street: '' });
  assert.equal(w.log.creates.length, 0);
  assert.equal(w.only().fulfillment_status, 'REVIEW_REQUIRED');
  assert.equal(w.only().fulfillment_error, 'MISSING_SHIPPING_STREET');
  assert.equal(reviewAlerts(w).length, 1);
  assert.ok(reviewAlerts(w)[0].html.includes('MISSING_SHIPPING_STREET'));
});

test('an incomplete US address (no ZIP) goes to REVIEW_REQUIRED', async () => {
  const w = world();
  await pay(w, AUTO_ON, { postal_code: '' });
  assert.equal(w.log.creates.length, 0);
  assert.equal(w.only().fulfillment_error, 'INCOMPLETE_SHIPPING_ADDRESS');
});

test('an unmapped variant goes to REVIEW_REQUIRED', async () => {
  const w = world();
  await pay(w, AUTO_ON, { items: 'أحمر-L:10' });
  assert.equal(w.log.creates.length, 0);
  assert.equal(w.only().fulfillment_error, 'UNRESOLVED_VARIANT');
});

test('a margin below GREEN goes to REVIEW_REQUIRED', async () => {
  const w = world();
  await pay(w, AUTO_ON, { product_amount: '9000', shipping_amount: '0' });
  assert.equal(w.log.creates.length, 0);
  assert.equal(w.only().fulfillment_status, 'REVIEW_REQUIRED');
  assert.ok(['MARGIN_BELOW_FLOOR', 'FULFILLMENT_REVIEW_REQUIRED', 'MARGIN_NOT_GREEN'].includes(w.only().fulfillment_error));
});

test('no route inside the delivery promise goes to REVIEW_REQUIRED', async () => {
  const w = world({ methods: [{ logisticName: 'CJPacket Eub', totalPostageFee: 20, logisticAging: '12-50' }] });
  await pay(w, AUTO_ON);
  assert.equal(w.log.creates.length, 0);
  assert.equal(w.only().fulfillment_error, 'NO_LOGISTICS_AVAILABLE');
});

// ---- Tabby enters the same workflow (only when enabled) --------------------------------------

test('a verified Tabby payment enters the exact same automatic workflow', async () => {
  const w = world();
  const r = await within(w, { ...AUTO_ON, TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk', TABBY_PUBLIC_KEY: 'pk' }, async () => {
    const out = res();
    await commerce({ method: 'POST', query: { resource: 'tabby-verify' }, headers: {}, body: { payment_id: 'pay_tabby_1', order: {
      id: 'AJ30000002',
      customer: { name: 'Abdulla Albreiki', email: 'owner@example.com', phone: '+16506531606', country_code: 'US', country_name: 'United States', region: 'California', city: 'Lake Forest', address: '528 Catalonia', postal_code: '92630' },
      cart: { items: [...Array(5).fill({ color: 'أسود', size: 'L' }), ...Array(5).fill({ color: 'أبيض', size: 'XL' })] }
    } } }, out);
    return out;
  });
  assert.equal(r.body.paid, true);
  assert.equal(w.log.creates.length, 1);
  assert.equal(w.log.creates[0].payType, 1);
  assert.equal(w.only().fulfillment_status, 'WAITING_FOR_CJ_PAYMENT');
});

test('with Tabby disabled (Production), Tabby verification is refused and nothing reaches CJ', async () => {
  const w = world();
  const r = await within(w, AUTO_ON, async () => {
    const out = res();
    await commerce({ method: 'POST', query: { resource: 'tabby-verify' }, headers: {}, body: { payment_id: 'pay_tabby_1', order: {} } }, out);
    return out;
  });
  assert.equal(r.statusCode, 503);
  assert.equal(w.log.creates.length, 0);
  assert.equal(w.orders.size, 0);
});

// ---- CJ payment and tracking are picked up by the sync --------------------------------------------

test('the sync keeps WAITING_FOR_CJ_PAYMENT while CJ is unpaid, detects the manual payment, then follows shipping', async () => {
  let stage = 'unpaid';
  const details = {
    unpaid: { orderStatus: 'UNPAID' },
    paid: { orderStatus: 'UNSHIPPED', subStatus: 'PROCESSING', paymentDate: '2026-09-19 08:00:00' },
    shipped: { orderStatus: 'SHIPPED', paymentDate: '2026-09-19 08:00:00', trackNumber: 'YT1', trackingProvider: 'YunExpress', trackingUrl: 'https://track.example/YT1' }
  };
  const w = world({ cjDetail: () => ({ code: 200, result: true, data: details[stage] }) });
  await pay(w, AUTO_ON);
  const sync = () => within(w, {}, () => syncTracking({ ...w.only() }));

  let r = await sync();
  assert.equal(r.cjPaid, false);
  assert.equal(w.only().fulfillment_status, 'WAITING_FOR_CJ_PAYMENT');
  assert.equal(serializeOrderForCustomer(w.only()).status, 'PREPARING_ORDER');

  stage = 'paid';
  r = await sync();
  assert.equal(r.cjPaid, true);
  assert.equal(w.only().fulfillment_status, 'PROCESSING');
  assert.equal(w.only().fulfillment_cj_paid_at, '2026-09-19 08:00:00');
  assert.equal(serializeOrderForCustomer(w.only()).status, 'PREPARING_SHIPMENT');

  stage = 'shipped';
  await sync();
  const row = w.only();
  assert.equal(row.fulfillment_status, 'SHIPPED');
  assert.equal(row.fulfillment_tracking_number, 'YT1');
  assert.equal(row.fulfillment_carrier, 'USPS');
  const customer = serializeOrderForCustomer(row);
  assert.equal(customer.status, 'SHIPPED');
  assert.equal(customer.tracking_number, '9400100000000000000001');
  for (const key of Object.keys(customer)) assert.ok(!/fulfillment|cj|provider|payment_url/i.test(key), key);
  assert.equal(w.log.creates.length, 1, 'syncing never creates or pays anything');
});

test('the scheduled sync endpoint requires the Vercel cron secret and syncs open CJ orders', async () => {
  const w = world();
  await pay(w, AUTO_ON);
  const call = (env, auth) => within(w, env, async () => {
    const out = res();
    await commerce({ method: 'GET', query: { resource: 'fulfillment-sync' }, headers: auth ? { authorization: auth } : {} }, out);
    return out;
  });
  assert.equal((await call({}, 'Bearer anything')).statusCode, 401, 'refused when CRON_SECRET is not configured');
  assert.equal((await call({ CRON_SECRET: 'cron_1' }, 'Bearer wrong')).statusCode, 401);
  assert.equal((await call({ CRON_SECRET: 'cron_1' }, null)).statusCode, 401);
  const ok = await call({ CRON_SECRET: 'cron_1' }, 'Bearer cron_1');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.checked, 1);
  assert.equal(ok.body.results[0].order_number, 'AJ30000001');
  assert.equal(w.log.creates.length, 1);
});
