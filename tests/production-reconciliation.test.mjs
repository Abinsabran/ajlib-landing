// Reconciliation of the live Production source (deploy-staging, commit
// 3081ac7 + uncommitted work) into the launch branch. These pin the
// Production-only behaviour that was carried over, so a later edit cannot
// silently drop it, and the one place where both sides had to be combined.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import handler from '../api/stripe-webhook.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const html = await read('index.html');
const legal = await read('legal.html');

// ---- storefront: Production-only behaviour kept ---------------------------------

test('the English/Arabic language toggle is wired on the store and the policies page', async () => {
  for (const asset of ['assets/store-language.css', 'assets/store-translations.js', 'assets/store-language.js']) assert.ok(html.includes(asset), asset);
  assert.match(html, /<button id="languageToggle" class="language-toggle"/);
  assert.match(legal, /\/assets\/legal-translations\.js/);
  assert.match(legal, /\/assets\/store-language\.js/);
  assert.match(legal, /<button id="languageToggle"/);
});

test('every asset the pages reference exists in the repo', async () => {
  const refs = new Set([...(html + legal).matchAll(/["(]\/?(assets\/[A-Za-z0-9_.-]+)/g)].map(m => m[1]));
  assert.ok(refs.size >= 8);
  for (const ref of refs) await access(new URL(ref, root));
});

test('customer-facing prompts and dates go through the translation helpers', () => {
  assert.match(html, /function ajlibConfirm\(value\)/);
  assert.doesNotMatch(html, /[^A-Za-z.]confirm\(/, 'a bare confirm() would skip the English translation');
  assert.match(html, /function storeDate\(value,withTime=true\)/);
  assert.match(html, /setCustomValidity\(ajlibText\(message\)\)/);
});

test('checkout profile sync: update-then-insert, and a sync failure never blocks payment', () => {
  assert.match(html, /async function updateOwnProfile\(profile\)/);
  assert.doesNotMatch(html, /profiles\?on_conflict=id/, 'the old upsert failed under the column-level profile grants');
  assert.match(html, /try\{await saveCheckoutToProfile\(data\)\}catch\(profileError\)/);
});

test('an app cart handed over via ?app_cart= is still imported, and checkout still enforces the minimum', () => {
  assert.match(html, /function importAppCart\(\)/);
  assert.match(html, /importedFromApp=importAppCart\(\)/);
  assert.match(html, /if\(cart\.items\.length<MIN_QTY\)\{toast/);
});

test('the admin customer list reads the saved address book, and the stock feed is never cached', async () => {
  const customers = await read('api/customers.js');
  assert.match(customers, /\/rest\/v1\/addresses\?select=/);
  assert.match(customers, /\/rest\/v1\/profiles\?select=id,full_name,phone,role'/);
  const inventory = await read('api/inventory.js');
  assert.match(inventory, /Cache-Control','private, no-store, max-age=0'/);
});

// ---- storefront: launch-branch behaviour kept where the two collided --------------

test('one compact App Store badge in the hero; the full-width link and the U+F8FF glyph are gone', () => {
  const hero = html.slice(html.indexOf('<section class="hero'), html.indexOf('</section>', html.indexOf('<section class="hero')));
  assert.equal((hero.match(/apps\.apple\.com/g) || []).length, 1);
  assert.match(hero, /class="app-badge"/);
  assert.ok(!html.includes('app-store-link'));
  assert.ok(!html.includes(String.fromCharCode(0xF8FF)));
});

test('the approved ladder, not the Production one, drives the storefront', () => {
  assert.match(html, /const MIN_QTY=5,MAX_QTY=100;/);
  assert.match(html, /\{n:50,p:1249,label:'باقة الجملة'\}/);
  assert.doesNotMatch(html, /p:119|p:219|p:309|p:389|selected=\{n:1,/);
});

test('English exists for every string the launch builder added', async () => {
  const catalog = await read('assets/store-translations.js');
  for (const key of ['باقة الجملة', 'كمية مخصصة', '3. دولة التوصيل', 'دولة التوصيل', 'الأسواق الرئيسية', 'جميع الدول', 'حمّل التطبيق من', 'الشحن والتوصيل']) {
    assert.ok(catalog.includes(`'${key}':`), `missing English for ${key}`);
  }
  // Dynamic summary lines are covered by patterns.
  for (const pattern of ['من (.+) إلى (.+) قطعة', 'الشحن: (.+)', 'مدة التوصيل: (.+)–(.+) أيام عمل', 'تقريبي — الدفع بالدرهم']) assert.ok(catalog.includes(pattern), pattern);
  // The <optgroup> headings of the delivery-country dropdown are translated.
  assert.match(await read('assets/store-language.js'), /const attributes = \[[^\]]*'label'\]/);
});

test('the local-only dev server is not carried over (it trusted a client-sent amount)', async () => {
  await assert.rejects(access(new URL('server.js', root)));
});

// ---- webhook: PaymentIntents created by the previous (live) checkout ----------------

const SECRET = 'whsec_reconcile_test';
const sign = (payload) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex')}`; };
const request = (payload) => ({ method: 'POST', headers: { 'stripe-signature': sign(payload) }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); } });
const response = () => { const r = { statusCode: null, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const env = { STRIPE_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: 'resend_test', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service_role_test' };
const withEnv = async (fn) => {
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

const PENDING = {
  order_number: 'AJ12345678', user_id: null, customer_email: 'legacy-buyer@example.com', customer_name: 'Legacy Buyer', customer_phone: '+971500000000',
  shipping_address: 'Street 1, Dubai, Dubai, الإمارات, ', shipping_address_id: null, shipping_country_code: 'AE', shipping_country_name: 'الإمارات',
  shipping_region: 'Dubai', shipping_postal_code: '', notes: '', item_summary: 'أسود-L:5', product_amount: 13500, shipping_amount: 0,
  shipping_zone: 'AE', amount_total: 13500, currency: 'aed', preorder: '', stripe_payment_intent_id: 'pi_legacy_1'
};

const mock = (pendingRows) => {
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url); calls.push({ url, method: options.method || 'GET', body: options.body });
    if (url.includes('/pending_mobile_orders')) return { ok: true, json: async () => ((options.method || 'GET') === 'GET' ? pendingRows : []) };
    if (url.includes('api.resend.com')) return { ok: true, json: async () => ({}) };
    if (url.includes('/rest/v1/orders')) return { ok: true, text: async () => JSON.stringify([{ id: 'row-1', order_number: 'AJ12345678', shipping_country_code: 'AE' }]) };
    if (url.includes('/rpc/process_paid_inventory')) return { ok: true, json: async () => ({}) };
    // Shipping-zone lookup and fulfillment preparation may run; nothing here
    // is allowed to reach CJ.
    if (url.includes('cjdropshipping')) throw new Error('CJ must not be called');
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
};

const legacyEvent = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: {
  id: 'pi_legacy_1', metadata: { order_id: 'AJ12345678' }, receipt_email: '', amount: 13500, amount_received: 13500, currency: 'aed', created: 1789000000
} } });

test('a live-checkout PaymentIntent (order_id only) is persisted from pending_mobile_orders, then the pending row is removed', async () => {
  await withEnv(async () => {
    const { calls, restore } = mock([PENDING]);
    try {
      const res = await handler(request(legacyEvent), response());
      assert.equal(res.statusCode, 200);
      const save = calls.find(c => c.url.includes('/rest/v1/orders') && c.method === 'POST');
      assert.ok(save, 'order was saved');
      const row = JSON.parse(save.body);
      assert.equal(row.order_number, 'AJ12345678');
      assert.deepEqual(row.items, [{ variant: 'أسود-L', quantity: 5 }]);
      assert.equal(row.customer_email, 'legacy-buyer@example.com');
      assert.equal(row.customer_name, 'Legacy Buyer');
      assert.equal(row.shipping_country_code, 'AE');
      assert.equal(row.amount_total, 13500);
      assert.equal(row.stripe_session_id, 'pi_legacy_1');
      // No structured city exists in the old table: left empty, never guessed.
      assert.equal(row.shipping_city, null);
      const del = calls.filter(c => c.url.includes('/pending_mobile_orders') && c.method === 'DELETE');
      assert.equal(del.length, 1);
      assert.ok(calls.findIndex(c => c === del[0]) > calls.findIndex(c => c === save), 'deleted only after saving');
    } finally { restore(); }
  });
});

test('a live-checkout PaymentIntent with no pending row fails loudly (Stripe retries) instead of saving an empty order', async () => {
  await withEnv(async () => {
    const { calls, restore } = mock([]);
    try {
      const res = await handler(request(legacyEvent), response());
      assert.equal(res.statusCode, 500);
      assert.equal(calls.filter(c => c.url.includes('/rest/v1/orders') && c.method === 'POST').length, 0);
      assert.equal(calls.filter(c => c.method === 'DELETE').length, 0);
    } finally { restore(); }
  });
});

test('a launch-branch PaymentIntent (full metadata) never touches pending_mobile_orders', async () => {
  await withEnv(async () => {
    const { calls, restore } = mock([PENDING]);
    try {
      const modern = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: {
        id: 'pi_modern_1', metadata: { order_id: 'AJ87654321', items: 'كحلي-M:10', city: 'Dubai', country_code: 'AE', product_amount: '26900', shipping_amount: '0' },
        receipt_email: 'modern@example.com', amount: 26900, currency: 'aed', created: 1789000000
      } } });
      const res = await handler(request(modern), response());
      assert.equal(res.statusCode, 200);
      assert.equal(calls.filter(c => c.url.includes('pending_mobile_orders')).length, 0);
      const row = JSON.parse(calls.find(c => c.url.includes('/rest/v1/orders') && c.method === 'POST').body);
      assert.equal(row.shipping_city, 'Dubai');
    } finally { restore(); }
  });
});
