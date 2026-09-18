// Final pre-launch pass: storefront purchase flow, pricing parity, the
// delivery-country picker, and the staged customer-column hardening.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { computeProductPricing, MIN_QUANTITY, MAX_QUANTITY } from '../api/_lib/pricing.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const migrationsDir = new URL('../supabase/migrations/', import.meta.url);
const migrationFiles = await readdir(migrationsDir);
const readMigration = async (suffix) => {
  const file = migrationFiles.find(f => f.endsWith(suffix));
  assert.ok(file, `missing migration *${suffix}`);
  return (await readFile(new URL(file, migrationsDir), 'utf8')).replace(/--.*$/gm, '');
};
const grantedIn = (sql) => sql.match(/grant select \(([^)]*)\)/s)[1].split(',').map(s => s.trim()).filter(Boolean);

// ---- pricing ------------------------------------------------------------------

const APPROVED = { 5: 135, 10: 269, 15: 399, 20: 519, 50: 1249 };

test('the server charges exactly the five approved UAE prices', () => {
  for (const [qty, aed] of Object.entries(APPROVED)) {
    assert.equal(computeProductPricing(Number(qty)).productAmount, aed * 100, `qty ${qty}`);
  }
});

test('the storefront offers all five approved tiers, each matching the server', () => {
  const packs = [...html.matchAll(/\{n:(\d+),p:(\d+),label:'([^']+)'\}/g)].map(m => ({ n: Number(m[1]), p: Number(m[2]), label: m[3] }));
  assert.deepEqual(packs.map(p => p.n), [5, 10, 15, 20, 50]);
  for (const pack of packs) {
    assert.equal(pack.p, APPROVED[pack.n], `tier ${pack.n} shows ${pack.p}`);
    assert.equal(pack.p * 100, computeProductPricing(pack.n).productAmount);
  }
  assert.deepEqual(packs.map(p => p.label), ['باقة البداية', 'الأكثر طلبًا', 'باقة التوفير', 'أفضل قيمة', 'باقة الجملة']);
});

test('no stale price or copy remains on the storefront', () => {
  for (const stale of ['129', '307.5', '390', '925', '119', '309', '389']) {
    assert.doesNotMatch(html, new RegExp(`(^|[^0-9.])${stale.replace('.', '\\.')} ?(د\\.إ|درهم|AED)`), `stale price ${stale}`);
  }
  assert.ok(!html.includes('>25 د.إ<'), 'stale 25 AED placeholder total');
  assert.ok(!html.includes('من قطعة واحدة'), '"from one piece" contradicts the 5-unit minimum');
  assert.ok(!html.includes('pack-old-price'), 'no struck-through reference price');
});

test('the website minimum and maximum match the server', () => {
  assert.match(html, new RegExp(`const MIN_QTY=${MIN_QUANTITY},MAX_QTY=${MAX_QUANTITY};`));
  assert.match(html, /من \$\{MIN_QTY\} إلى \$\{MAX_QTY\} قطعة/);
});

test('the builder opens on the 5-piece Starter Pack, not an unhighlighted custom mode', () => {
  assert.match(html, /cart=null,flexible=false,/);
  assert.match(html, /<div id="flexQty" hidden /);
});

// ---- purchase flow ----------------------------------------------------------------

test('build flow order: quantity -> colour/size -> delivery country -> summary -> add to cart', () => {
  const at = (needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i; };
  const order = ['id="packs"', 'id="pieces"', 'id="buildCountry"', 'class="summary"', 'onclick="addPack()"'].map(at);
  for (let i = 1; i < order.length; i += 1) assert.ok(order[i] > order[i - 1], 'flow is out of order');
});

test('the multi-group colour/size distribution is preserved', () => {
  assert.match(html, /onclick="addAllocation\(\)"/);
  assert.match(html, /onclick="splitColors\(\)"/);
});

test('the delivery country is one dropdown that re-queries the backend quote', () => {
  assert.match(html, /<select id="buildCountry"[^>]*onchange="onBuildCountry\(this\.value\)"/);
  assert.match(html, /function onBuildCountry\(code\)\{buildCountry=code;refreshBuildQuote\(\)\}/);
  assert.match(html, /fetch\('\/api\/order-quote\?quantity='\+encodeURIComponent\(n\)\+'&country='\+encodeURIComponent\(code\)\)/);
  // Main markets first, then every other country.
  assert.match(html, /const primary=\['AE','SA','KW','QA','BH','OM','US','AU'\]/);
});

test('the summary is filled from the server quote, and stale responses are dropped', () => {
  for (const field of ['q.total/100', 'q.unitPrice/100', 'q.shipping/100', 'q.minDays', 'q.maxDays']) {
    assert.ok(html.includes(field), `summary must use ${field} from the server`);
  }
  assert.match(html, /const seq=\+\+quoteSeq/);
  assert.match(html, /if\(seq!==quoteSeq\)return/);
});

test('the builder country carries into checkout without overriding a chosen one', () => {
  assert.match(html, /const cc=form\.elements\.country_code;if\(cc&&!cc\.value&&buildCountry\)\{cc\.value=buildCountry\}/);
});

test('the local-currency figure is a labelled, display-only estimate', () => {
  assert.match(html, /\/api\/currency\?country_code=/);
  assert.match(html, /if\(!c\.display_is_estimate/);
  assert.match(html, /تقريبي — الدفع بالدرهم/);
});

// ---- layout ------------------------------------------------------------------------

test('App Store link is a compact badge, never a full-width block', () => {
  assert.match(html, /class="app-badge" href="https:\/\/apps\.apple\.com\/app\/id6807229578"/);
  const css = html.slice(html.indexOf('<style id="launch-pass">'), html.indexOf('</style>', html.indexOf('<style id="launch-pass">')));
  assert.doesNotMatch(css, /\.app-badge[^{]*\{[^}]*width:\s*100%/);
  // The Apple mark is an SVG: U+F8FF renders as an empty box off Apple devices.
  assert.match(html, /<svg class="apple-mark"/);
  assert.ok(!html.includes(''));
});

test('shipping / returns / privacy are compact accordions', () => {
  const policies = html.slice(html.indexOf('id="policies"'), html.indexOf('</section>', html.indexOf('id="policies"')));
  assert.equal((policies.match(/<details>/g) || []).length, 3);
  for (const title of ['الشحن والتوصيل', 'الاستبدال', 'الخصوصية والجمارك']) assert.ok(policies.includes(`<summary>${title}</summary>`));
  assert.match(policies, /7–14 يوم عمل/);
});

test('colour cards become a horizontal carousel on phones', () => {
  assert.match(html, /#colors \.products\{display:flex;[^}]*overflow-x:auto;[^}]*scroll-snap-type:x mandatory/);
});

// ---- customer column hardening -----------------------------------------------------

test('Stripe identifiers are hidden from customers; fulfillment_* stays hidden', async () => {
  const granted = grantedIn(await readMigration('_hide_operational_columns_and_admin_order_read.sql'));
  for (const hidden of ['stripe_session_id', 'stripe_payment_intent_id']) assert.ok(!granted.includes(hidden), `${hidden} leaks`);
  assert.ok(!granted.some(c => c.startsWith('fulfillment_')));
});

test('admin_note is staged: still granted now (the live admin console needs it), revoked in the deploy-time step', async () => {
  const now = grantedIn(await readMigration('_hide_operational_columns_and_admin_order_read.sql'));
  assert.ok(now.includes('admin_note'), 'must stay granted until the new website is live');
  const pendingFile = migrationFiles.find(f => f.startsWith('PENDING_AT_PRODUCTION_DEPLOY_'));
  assert.ok(pendingFile, 'the deploy-time step must exist');
  assert.ok(pendingFile.endsWith('.sql.txt'), 'must NOT be pushable by `supabase db push`');
  const pending = grantedIn((await readFile(new URL(pendingFile, migrationsDir), 'utf8')).replace(/--.*$/gm, ''));
  assert.ok(!pending.includes('admin_note'));
  assert.ok(!pending.includes('stripe_session_id'));
});

test('every live and shipped reader keeps working under the current grant', async () => {
  const granted = grantedIn(await readMigration('_hide_operational_columns_and_admin_order_read.sql'));
  const readers = {
    'LIVE Production admin console': 'id,order_number,customer_name,customer_email,customer_phone,shipping_address,items,amount_total,currency,status,shipping_company,tracking_number,admin_note,created_at,updated_at',
    'storefront customer order list': 'order_number,items,amount_total,currency,status,shipping_company,tracking_number,created_at,updated_at',
    'shipped Expo customer list (+user_id filter)': 'order_number,amount_total,currency,status,items,tracking_number,shipping_company,created_at,updated_at,user_id',
    'shipped Expo admin console': 'id,order_number,customer_name,customer_email,customer_phone,shipping_address,items,amount_total,currency,status,shipping_company,tracking_number,created_at,updated_at'
  };
  for (const [reader, cols] of Object.entries(readers)) {
    const missing = cols.split(',').filter(c => !granted.includes(c));
    assert.deepEqual(missing, [], `${reader} would break: ${missing}`);
  }
});

test('the storefront reads NO hidden column directly', async () => {
  const pending = grantedIn((await readFile(new URL(migrationFiles.find(f => f.startsWith('PENDING_AT_PRODUCTION_DEPLOY_')), migrationsDir), 'utf8')).replace(/--.*$/gm, ''));
  for (const m of html.matchAll(/rest\/v1\/orders\?select=([a-z_,]+)/g)) {
    const missing = m[1].split(',').filter(c => !pending.includes(c));
    assert.deepEqual(missing, [], `storefront selects a column customers will lose: ${missing}`);
  }
});

test('the admin console reads through admin_list_orders(), which refuses non-admins', async () => {
  assert.match(html, /supabaseRequest\('\/rest\/v1\/rpc\/admin_list_orders',\{method:'POST',body:\{\}\}\)/);
  assert.doesNotMatch(html, /rest\/v1\/orders\?select=[^'"`]*admin_note/);
  const sql = await readMigration('_hide_operational_columns_and_admin_order_read.sql');
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path = ''/);
  assert.match(sql, /if not public\.is_admin\(\) then\s+raise exception/);
  assert.match(sql, /revoke all on function public\.admin_list_orders\(\) from public, anon/);
});
