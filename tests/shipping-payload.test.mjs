// CJ shipping payload: English country from the ISO code, street-only
// shippingAddress, trimmed fields, structured street lines persisted for
// both Stripe and Tabby, and orders without a street held for review.
// All network calls are simulated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { prepareFulfillment, FulfillmentBlockedError, cjCountryName, buildCjOrderPayload } from '../api/_lib/cj-fulfillment.js';
import { runFulfillmentPreparation } from '../api/_lib/fulfillment-runner.js';
import checkoutSession from '../api/checkout-session.js';
import stripeWebhook from '../api/stripe-webhook.js';
import commerce from '../api/commerce.js';

const ARABIC = /[؀-ۿ]/;

const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const withFetch = async (impl, fn) => {
  const original = globalThis.fetch; globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const makeRes = () => { const r = { statusCode: null, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = () => {}; return r; };

// The first controlled US order as the storefront stores it today: localized
// (Arabic) country name, a flattened address, and stray whitespace.
const usOrder = (over = {}) => ({
  id: 'order-us-1', order_number: 'AJ20000001',
  items: [{ variant: 'أسود-L', quantity: 5 }, { variant: 'أبيض-XL', quantity: 5 }],
  product_amount: 26900, shipping_amount: 15000, stripe_session_id: 'cs_live_x',
  customer_name: ' Abdulla Albreiki ', customer_phone: ' +16506531606 ', customer_email: ' owner@example.com ',
  shipping_country_code: 'US', shipping_country_name: 'الولايات المتحدة',
  shipping_region: 'California ', shipping_city: 'Lake Forest ', shipping_postal_code: ' 92630',
  shipping_street: ' 528 Catalonia ', shipping_street2: null,
  shipping_address: '528 Catalonia , Lake Forest , California , الولايات المتحدة, 92630',
  ...over
});

const cjMock = () => {
  let cjCalls = 0;
  const fetch = async (url) => {
    const u = String(url);
    cjCalls += 1;
    if (u.includes('getAccessToken')) return ok({ code: 200, result: true, data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } });
    if (u.includes('/product/conn/connection')) return ok({ code: 200, result: true, data: { list: [{ cjVariantId: '1581871544320667650', cjPrice: '2.21' }, { cjVariantId: '1581871544316473344', cjPrice: '2.21' }] } });
    if (u.includes('/logistic/freightCalculate')) return ok({ code: 200, result: true, data: [{ logisticName: 'YunExpress Ordinary', totalPostageFee: 27.48, logisticAging: '4-7' }] });
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetch, calls: () => cjCalls };
};

// ---- payload ----------------------------------------------------------------------

test('US is sent to CJ in English from the country code, never the stored Arabic name', async () => {
  assert.equal(cjCountryName('US'), 'United States');
  assert.equal(cjCountryName(' us '), 'United States');
  const cj = cjMock();
  const prepared = await withEnv({ CJ_API_KEY: 'x' }, () => withFetch(cj.fetch, () => prepareFulfillment(usOrder(), { maxDeliveryDays: 16, checkBalance: false })));
  assert.equal(prepared.payload.shippingCountryCode, 'US');
  assert.equal(prepared.payload.shippingCountry, 'United States');
});

test('shippingAddress is the street line only — never the combined address — and every field is trimmed', async () => {
  const cj = cjMock();
  const { payload } = await withEnv({ CJ_API_KEY: 'x' }, () => withFetch(cj.fetch, () => prepareFulfillment(usOrder(), { maxDeliveryDays: 16, checkBalance: false })));
  assert.equal(payload.shippingAddress, '528 Catalonia');
  assert.equal(payload.shippingAddress2, '');
  for (const part of ['Lake Forest', 'California', '92630', 'الولايات']) assert.ok(!payload.shippingAddress.includes(part), `street contains ${part}`);
  assert.equal(payload.shippingProvince, 'California');
  assert.equal(payload.shippingCity, 'Lake Forest');
  assert.equal(payload.shippingZip, '92630');
  assert.equal(payload.shippingPhone, '+16506531606');
  assert.equal(payload.shippingCustomerName, 'Abdulla Albreiki');
  assert.equal(payload.email, 'owner@example.com');
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      assert.equal(value, value.trim(), `${key} not trimmed`);
      assert.ok(!ARABIC.test(value), `${key} carries Arabic text: ${value}`);
    }
  }
  assert.deepEqual(Object.keys(payload).sort(), ['email', 'fromCountryCode', 'logisticName', 'orderNumber', 'payType', 'products', 'shippingAddress', 'shippingAddress2', 'shippingCity', 'shippingCountry', 'shippingCountryCode', 'shippingCustomerName', 'shippingPhone', 'shippingProvince', 'shippingZip']);
});

test('a second street line travels separately as shippingAddress2', async () => {
  const payload = buildCjOrderPayload({
    ajlibOrderNumber: 'AJ1', resolvedItems: [], logisticName: 'x', shippingCountryCode: 'us', shippingCountry: 'United States',
    shippingAddress: ' 528 Catalonia ', shippingAddress2: ' Apt 4 '
  });
  assert.equal(payload.shippingAddress, '528 Catalonia');
  assert.equal(payload.shippingAddress2, 'Apt 4');
  assert.equal(payload.shippingCountryCode, 'US');
});

// ---- missing street --------------------------------------------------------------------

test('a missing or blank street blocks preparation before any CJ call — never guessed from the address', async () => {
  for (const street of [null, undefined, '', '   ']) {
    const cj = cjMock();
    await withEnv({ CJ_API_KEY: 'x' }, () => withFetch(cj.fetch, () => assert.rejects(
      () => prepareFulfillment(usOrder({ shipping_street: street }), { maxDeliveryDays: 16 }),
      (err) => err instanceof FulfillmentBlockedError && err.reason === 'MISSING_SHIPPING_STREET'
    )));
    assert.equal(cj.calls(), 0, `CJ called for street=${JSON.stringify(street)}`);
  }
});

test('the missing-city guard still applies first', async () => {
  await assert.rejects(
    () => prepareFulfillment(usOrder({ shipping_city: '  ' }), { maxDeliveryDays: 16 }),
    (err) => err.reason === 'MISSING_SHIPPING_CITY'
  );
});

test('a historical order without a street goes to REVIEW_REQUIRED (MISSING_SHIPPING_STREET), paid order untouched', async () => {
  const patches = [];
  const fetch = async (url, options = {}) => {
    if (String(url).includes('/rest/v1/orders')) { patches.push(JSON.parse(options.body)); return ok([{ id: 'order-us-1' }]); }
    throw new Error(`CJ must not be called: ${url}`);
  };
  const result = await withEnv({ SUPABASE_URL: 'https://db.example.co', SUPABASE_SECRET_KEY: 's' }, () => withFetch(fetch, () =>
    runFulfillmentPreparation(usOrder({ shipping_street: null, fulfillment_status: null }), { maxDeliveryDays: 16 })));
  assert.equal(result.outcome, 'REVIEW_REQUIRED');
  assert.equal(result.reason, 'MISSING_SHIPPING_STREET');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].fulfillment_status, 'REVIEW_REQUIRED');
  assert.equal(patches[0].fulfillment_error, 'MISSING_SHIPPING_STREET');
  assert.ok(!('status' in patches[0]) && !('amount_total' in patches[0]), 'the customer order itself is not changed');
});

// ---- persistence: Stripe ------------------------------------------------------------------

const customer = { name: ' Abdulla Albreiki ', email: 'owner@example.com', phone: ' +16506531606 ', country_code: 'US', country_name: 'الولايات المتحدة', region: ' California ', city: ' Lake Forest ', address: '  528 Catalonia ', address_line2: '', postal_code: ' 92630' };
const tenItems = [...Array(5).fill({ color: 'أسود', size: 'L' }), ...Array(5).fill({ color: 'أبيض', size: 'XL' })];

test('Stripe checkout carries the street line on its own (trimmed) in the session metadata', async () => {
  let params = null;
  const fetch = async (url, options = {}) => {
    if (String(url).includes('api.stripe.com')) { params = new URLSearchParams(String(options.body)); return ok({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' }); }
    if (String(url).includes('/rest/v1/shipping_zones')) return { ok: false };
    throw new Error(`unexpected fetch ${url}`);
  };
  const res = await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, () => withFetch(fetch, async () => {
    const r = makeRes();
    await checkoutSession({ method: 'POST', headers: { host: 'store.test' }, body: { id: 'AJ20000001', customer, cart: { items: tenItems } } }, r);
    return r;
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(params.get('metadata[street]'), '528 Catalonia');
  assert.equal(params.get('metadata[street2]'), '');
  assert.equal(params.get('metadata[city]').trim(), 'Lake Forest');
});

const SECRET = 'whsec_street_test';
const signed = (payload) => { const t = Math.floor(Date.now() / 1000); return { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${crypto.createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex')}` }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); } }; };

test('the Stripe webhook persists shipping_street trimmed, and trims every shipping field', async () => {
  let saved = null;
  const fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/orders') && options.method === 'POST') { saved = JSON.parse(options.body); return ok([{ id: 'row-1', ...saved }]); }
    if (u.includes('/rest/v1/orders')) return ok([]);
    if (u.includes('api.resend.com')) return ok({});
    if (u.includes('process_paid_inventory')) return ok({});
    if (u.includes('/rest/v1/shipping_zones')) return { ok: false };
    if (u.includes('cjdropshipping')) return ok({ code: 1600200, result: false, message: 'not in this test' });
    throw new Error(`unexpected fetch ${u}`);
  };
  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: {
    id: 'cs_live_street', payment_status: 'paid', client_reference_id: 'AJ20000001', amount_total: 41900, currency: 'aed', created: 1789000000,
    customer_details: { email: ' owner@example.com ' },
    metadata: { order_id: 'AJ20000001', items: 'أسود-L:5,أبيض-XL:5', customer_name: ' Abdulla Albreiki ', phone: ' +16506531606 ', country_code: 'us', country_name: 'الولايات المتحدة', region: 'California ', city: ' Lake Forest', street: ' 528 Catalonia ', street2: '', postal_code: ' 92630 ', address: '528 Catalonia, Lake Forest, California, الولايات المتحدة, 92630', product_amount: '26900', shipping_amount: '15000' }
  } } });
  const res = await withEnv({ STRIPE_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: 'r', SUPABASE_URL: 'https://db.example.co', SUPABASE_SECRET_KEY: 's', CJ_API_KEY: 'x' }, () => withFetch(fetch, async () => {
    const r = makeRes(); await stripeWebhook(signed(event), r); return r;
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(saved.shipping_street, '528 Catalonia');
  assert.equal(saved.shipping_street2, null);
  assert.equal(saved.shipping_city, 'Lake Forest');
  assert.equal(saved.shipping_region, 'California');
  assert.equal(saved.shipping_postal_code, '92630');
  assert.equal(saved.shipping_country_code, 'US');
  assert.equal(saved.customer_phone, '+16506531606');
  assert.equal(saved.customer_name, 'Abdulla Albreiki');
  assert.equal(saved.customer_email, 'owner@example.com');
});

// ---- persistence: Tabby ---------------------------------------------------------------------

test('Tabby verify persists shipping_street through the same shared path', async () => {
  let saved = null;
  const fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/payments/')) return ok({ id: 'pay_street_1', status: 'CLOSED', amount: '419.00', currency: 'AED', created_at: '2026-09-18T10:00:00Z' });
    if (u.includes('/rest/v1/orders') && options.method === 'POST') { saved = JSON.parse(options.body); return ok([{ id: 'row-t', ...saved }]); }
    if (u.includes('/rest/v1/orders')) return ok([]);
    if (u.includes('api.resend.com')) return ok({});
    if (u.includes('/rpc/process_paid_inventory')) return ok({});
    if (u.includes('/rpc/check_inventory')) return ok([]);
    if (u.includes('/rest/v1/shipping_zones')) return { ok: false };
    if (u.includes('cjdropshipping')) return ok({ code: 1600200, result: false, message: 'not in this test' });
    throw new Error(`unexpected fetch ${u}`);
  };
  const res = await withEnv({ TABBY_MODE: 'test', TABBY_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'https://db.example.co', SUPABASE_SECRET_KEY: 's', RESEND_API_KEY: 'r', CJ_API_KEY: 'x' }, () => withFetch(fetch, async () => {
    const r = makeRes();
    await commerce({ method: 'POST', query: { resource: 'tabby-verify' }, headers: {}, body: { payment_id: 'pay_street_1', order: { id: 'AJ20000002', customer, cart: { items: tenItems } } } }, r);
    return r;
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paid, true);
  assert.equal(saved.shipping_street, '528 Catalonia');
  assert.equal(saved.shipping_city, 'Lake Forest');
  assert.equal(saved.shipping_region, 'California');
  assert.equal(saved.shipping_postal_code, '92630');
});

// ---- privacy -------------------------------------------------------------------------------

test('the street columns are additive and never granted to customers; no customer read selects them', async () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const files = (await readdir(dir)).sort();
  const streetFile = files.find(f => f.endsWith('_shipping_street_lines.sql'));
  const sql = (await readFile(new URL(streetFile, dir), 'utf8')).replace(/--.*$/gm, '');
  assert.match(sql, /add column if not exists shipping_street text/);
  assert.doesNotMatch(sql, /\bgrant\b|\bdrop\b|\brevoke\b/i);
  // The newest customer grant is still the admin_note hardening, and it does not list the new columns.
  const grantFiles = [];
  for (const f of files) { if (/grant select \(/i.test(await readFile(new URL(f, dir), 'utf8'))) grantFiles.push(f); }
  const latestGrant = (await readFile(new URL(grantFiles.at(-1), dir), 'utf8')).replace(/--.*$/gm, '');
  assert.ok(grantFiles.at(-1).endsWith('_hide_admin_note_from_customers.sql'));
  assert.doesNotMatch(latestGrant, /shipping_street/);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /rest\/v1\/orders\?select=[^'"`]*shipping_street/);
});
