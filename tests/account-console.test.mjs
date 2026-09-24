import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';

// Owner Console KPI cards and exit, and the customer's order history. The
// storefront's REAL functions are pulled out of index.html and run against a
// small fake DOM, so these tests exercise the shipped code, not a copy.

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const catalogSource = readFileSync(new URL('../assets/store-translations.js', import.meta.url), 'utf8');

// Each storefront function sits on its own line; take it from its keyword to
// the end of that line.
const fnSource = (name) => {
  const start = html.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing function ${name}`);
  const end = html.indexOf('\n', start);
  return html.slice(start, end < 0 ? undefined : end);
};
const orderStatusesSource = html.match(/const orderStatuses=\{[^}]*\};/)[0];

// ---- tiny DOM -------------------------------------------------------------------

const classList = () => {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
};
const element = (extra = {}) => ({ classList: classList(), attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, innerHTML: '', textContent: '', value: '', ...extra });

const consoleWorld = () => {
  const els = {
    adminDrawer: element(), accountDrawer: element(), adminStatusFilter: element({ value: 'all' }), adminSearch: element({ value: 'AJ123' }),
    adminOrders: element(), adminSummary: element(),
    'admin-view-orders': element({ scrollIntoView(opts) { this.scrolled = opts; } })
  };
  els.adminDrawer.classList.add('open');
  const ordersNav = element({ dataset: { view: 'orders' } });
  const cards = ['all', 'active', 'delivered', 'sales'].map(kpi => element({ dataset: { kpi } }));
  const log = { views: [], renders: 0, accountRendered: 0, ordersLoaded: 0 };
  const context = {
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === '.admin-nav button[data-view="orders"]' ? ordersNav : null),
      querySelectorAll: (sel) => (sel === '#adminSummary [data-kpi]' ? cards : [])
    },
    matchMedia: () => ({ matches: false }),
    showAdminView: (view, button) => log.views.push({ view, button }),
    renderAdminOrders: () => { log.renders += 1; },
    renderAccount: () => { log.accountRendered += 1; },
    loadOrders: () => { log.ordersLoaded += 1; },
    authSession: { access_token: 'token', user: { id: 'u1' } },
    localStorage: { removed: [], removeItem(k) { this.removed.push(k); } }
  };
  vm.createContext(context);
  vm.runInContext(['closeAdmin', 'backToAccount', 'adminKpi', 'markAdminKpi', 'openAccount'].map(fnSource).join('\n'), context);
  return { context, els, cards, ordersNav, log };
};

const pressed = (cards) => cards.filter(c => c.attributes['aria-pressed'] === 'true').map(c => c.dataset.kpi);

// ---- KPI cards ------------------------------------------------------------------------

test('the four KPI cards are real buttons wired to adminKpi', () => {
  for (const kpi of ['all', 'active', 'delivered', 'sales']) {
    assert.ok(html.includes(`<button type=\\"button\\" class=\\"admin-stat\\" data-kpi=\\"${kpi}\\" onclick=\\"adminKpi('${kpi}')\\">`) ||
      html.includes(`<button type="button" class="admin-stat" data-kpi="${kpi}" onclick="adminKpi('${kpi}')">`), kpi);
  }
  assert.match(html, /button\.admin-stat:hover\{/);
  assert.match(html, /button\.admin-stat:focus-visible\{outline:3px solid/);
});

for (const [kpi, filter] of [['all', 'all'], ['active', 'active'], ['delivered', 'delivered'], ['sales', 'sales']]) {
  test(`${kpi} card: Orders view, "${filter}" filter, search cleared, smooth scroll, card marked`, () => {
    const w = consoleWorld();
    w.context.adminKpi(kpi);
    assert.deepEqual(w.log.views, [{ view: 'orders', button: w.ordersNav }]);
    assert.equal(w.els.adminStatusFilter.value, filter);
    assert.equal(w.els.adminSearch.value, '');
    assert.equal(w.log.renders, 1);
    assert.equal(JSON.stringify(w.els['admin-view-orders'].scrolled), JSON.stringify({ behavior: 'smooth', block: 'start' }));
    assert.deepEqual(pressed(w.cards), [kpi]);
  });
}

test('an unknown card falls back to all orders; reduced motion is respected', () => {
  const w = consoleWorld();
  w.context.matchMedia = () => ({ matches: true });
  w.context.adminKpi('nope');
  assert.equal(w.els.adminStatusFilter.value, 'all');
  assert.equal(w.els['admin-view-orders'].scrolled.behavior, 'auto');
});

// The real filter used by the order list and the numbers on the cards.
const adminOrders = [
  { order_number: 'A1', status: 'paid' }, { order_number: 'A2', status: 'processing' }, { order_number: 'A3', status: 'packed' },
  { order_number: 'A4', status: 'shipped' }, { order_number: 'A5', status: 'delivered' }, { order_number: 'A6', status: 'delivered' },
  { order_number: 'A7', status: 'cancelled' }, { order_number: 'A8', status: 'refunded' }
];
const renderedAdmin = (filter) => {
  const box = element();
  const context = {
    document: { getElementById: (id) => ({ adminOrders: box, adminSearch: { value: '' }, adminStatusFilter: { value: filter } })[id] || null },
    adminOrdersCache: adminOrders, escapeHtml: String, storeDate: () => '', orderItemsHtml: () => '', encodeURIComponent
  };
  vm.createContext(context);
  vm.runInContext(`${orderStatusesSource}\n${fnSource('renderAdminOrders')}\nrenderAdminOrders()`, context);
  return [...box.innerHTML.matchAll(/<b class="order-number">([^<]+)<\/b>/g)].map(m => m[1]);
};

test('each card opens exactly the orders it counts', () => {
  assert.deepEqual(renderedAdmin('all'), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
  assert.deepEqual(renderedAdmin('active'), ['A1', 'A2', 'A3', 'A4']);
  assert.deepEqual(renderedAdmin('delivered'), ['A5', 'A6']);
  // Sales = every order summed into the Sales card (not cancelled/refunded).
  assert.deepEqual(renderedAdmin('sales'), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
  const summary = fnSource('loadAdminOrders');
  assert.match(summary, /revenue=adminOrdersCache\.filter\(o=>!\['cancelled','refunded'\]\.includes\(o\.status\)\)/);
  assert.match(summary, /active=adminOrdersCache\.filter\(o=>!\['delivered','cancelled','refunded'\]\.includes\(o\.status\)\)/);
});

test('Refresh keeps the selected filter and re-marks its card', () => {
  const load = fnSource('loadAdminOrders');
  // The summary is rebuilt, then the list re-renders from the untouched <select>.
  assert.match(load, /renderAdminOrders\(\);markAdminKpi\(\)\}/);
  assert.doesNotMatch(load, /adminStatusFilter/);
  assert.match(html, /<select id="adminStatusFilter" onchange="renderAdminOrders\(\);markAdminKpi\(\)">/);
});

// ---- exit -----------------------------------------------------------------------------

test('"Back to my account" closes the console and opens the account page without signing out', () => {
  assert.match(html, /<button type="button" class="secondary" id="adminBackToAccount" onclick="backToAccount\(\)">العودة إلى حسابي<\/button>/);
  const w = consoleWorld();
  const session = w.context.authSession;
  w.context.backToAccount();
  assert.equal(w.els.adminDrawer.classList.contains('open'), false);
  assert.equal(w.els.accountDrawer.classList.contains('open'), true);
  assert.equal(w.log.accountRendered, 1);
  assert.equal(w.log.ordersLoaded, 1, 'the account page loads the customer orders');
  assert.equal(w.context.authSession, session, 'session untouched');
  assert.deepEqual(w.context.localStorage.removed, []);
});

test('the X still closes the console', () => {
  assert.match(html, /<aside class="panel admin-panel"><button class="close" onclick="closeAdmin\(\)" aria-label="إغلاق">×<\/button>/);
  const w = consoleWorld();
  w.context.closeAdmin();
  assert.equal(w.els.adminDrawer.classList.contains('open'), false);
  assert.equal(w.els.accountDrawer.classList.contains('open'), false);
});

// ---- customer history -----------------------------------------------------------------

const renderCustomer = (orders, group) => {
  const list = element();
  const context = {
    document: { getElementById: (id) => (id === 'ordersList' ? list : null) },
    customerOrdersCache: orders, activeOrderGroup: group, escapeHtml: String, storeDate: () => '', orderItemsHtml: () => ''
  };
  vm.createContext(context);
  vm.runInContext([orderStatusesSource, fnSource('orderTrackerHtml'), fnSource('customerStage'), 'const PREVIOUS_ORDER_STAGES=[\'delivered\',\'cancelled\',\'refunded\'];', fnSource('isPreviousOrder'), fnSource('renderCustomerOrders'), 'renderCustomerOrders()'].join('\n'), context);
  return list.innerHTML;
};

const current = { order_number: 'AJ75446351', status: 'processing', amount_total: 41900, currency: 'aed', items: [] };
const delivered = { order_number: 'AJ63054082', status: 'delivered', amount_total: 26900, currency: 'aed', items: [] };

test('an order being prepared (AJ75446351-style) is a Current order shown as "قيد التجهيز"', () => {
  const now = renderCustomer([current, delivered], 'current');
  assert.match(now, /AJ75446351/);
  assert.match(now, /<strong>قيد التجهيز<\/strong>/);
  assert.doesNotMatch(now, /AJ63054082/);
});

test('delivered orders are Previous orders', () => {
  const past = renderCustomer([current, delivered], 'previous');
  assert.match(past, /AJ63054082/);
  assert.match(past, /<strong>تم التسليم<\/strong>/);
  assert.doesNotMatch(past, /AJ75446351/);
  for (const status of ['cancelled', 'refunded']) assert.match(renderCustomer([{ ...delivered, order_number: 'X', status }], 'previous'), /X/);
});

test('internal CJ / fulfillment states never reach the customer; they read as a current "order received" stage', () => {
  for (const internal of ['WAITING_FOR_CJ_PAYMENT', 'PENDING', 'SUBMITTING', 'REVIEW_REQUIRED', 'READY_FOR_CJ', 'pending', '', null, undefined]) {
    const out = renderCustomer([{ ...current, order_number: 'AJ1', status: internal }], 'current');
    assert.match(out, /AJ1/, String(internal));
    assert.match(out, /<strong>تم الدفع<\/strong>/, String(internal));
    for (const leak of ['WAITING_FOR_CJ_PAYMENT', 'PENDING', 'SUBMITTING', 'REVIEW_REQUIRED', 'READY_FOR_CJ', 'undefined', 'null']) assert.ok(!out.includes(leak), `${internal} leaked ${leak}`);
    assert.doesNotMatch(renderCustomer([{ ...current, order_number: 'AJ1', status: internal }], 'previous'), /AJ1/);
  }
});

test('history loads through my_orders(), with a fresh session; Refresh keeps the selected group', () => {
  const load = fnSource('loadOrders');
  assert.match(load, /await ensureFreshSession\(\)/);
  assert.match(load, /supabaseRequest\('\/rest\/v1\/rpc\/my_orders',\{method:'POST',body:\{\}\}\)/);
  assert.doesNotMatch(load, /user_id=eq/);
  assert.doesNotMatch(load, /activeOrderGroup=/);
  assert.match(html, /<button class="secondary" onclick="loadOrders\(\)">تحديث<\/button>/);
});

// ---- session freshness ------------------------------------------------------------------

const jwt = (expSecondsFromNow) => ['x', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString('base64url'), 'sig'].join('.');
const sessionWorld = (session, refresh) => {
  const store = {};
  const log = { refreshes: 0, rendered: 0 };
  const context = {
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    authSession: session,
    localStorage: { setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
    authRequest: async (path, body) => { log.refreshes += 1; log.path = path; log.body = body; return refresh(); },
    renderAccount: () => { log.rendered += 1; }, renderAdminAccess: () => {}
  };
  vm.createContext(context);
  vm.runInContext(['let sessionRefresh=null;', fnSource('tokenExpiry'), fnSource('ensureFreshSession'), fnSource('expireSession')].join('\n'), context);
  return { context, store, log };
};

test('a valid token is used as-is; no refresh call', async () => {
  const w = sessionWorld({ access_token: jwt(1800), refresh_token: 'r1', user: { id: 'u1' } }, () => { throw new Error('should not refresh'); });
  const s = await w.context.ensureFreshSession();
  assert.equal(w.log.refreshes, 0);
  assert.equal(s.user.id, 'u1');
});

test('an expired token (the AJ75446351 cause) is refreshed before use and stored', async () => {
  const fresh = jwt(3600);
  const w = sessionWorld({ access_token: jwt(-9 * 3600), refresh_token: 'r1', user: { id: 'u1' } }, async () => ({ access_token: fresh, refresh_token: 'r2', user: { id: 'u1', email: 'a@b.c' } }));
  const [a, b] = await Promise.all([w.context.ensureFreshSession(), w.context.ensureFreshSession()]);
  assert.equal(w.log.refreshes, 1, 'concurrent callers share one refresh (refresh tokens rotate)');
  assert.equal(w.log.path, '/auth/v1/token?grant_type=refresh_token');
  assert.equal(JSON.stringify(w.log.body), JSON.stringify({ refresh_token: 'r1' }));
  assert.equal(a.access_token, fresh);
  assert.equal(b.access_token, fresh);
  assert.equal(JSON.parse(w.store.ajlibSession).refresh_token, 'r2');
});

test('a session that cannot be refreshed is cleared instead of sending a dead token', async () => {
  const w = sessionWorld({ access_token: jwt(-60), refresh_token: 'revoked', user: { id: 'u1' } }, async () => { throw new Error('invalid refresh token'); });
  assert.equal(await w.context.ensureFreshSession(), null);
  assert.equal(w.context.authSession, null);
  assert.equal(w.log.rendered, 1);
});

test('checkout (Stripe and Tabby) and every Supabase call refresh the session before sending the token', () => {
  const guarded = [...html.matchAll(/if\(typeof ensureFreshSession==='function'\)await ensureFreshSession\(\);const headers=\{'Content-Type':'application\/json'\};if\(authSession\?\.access_token\)headers\.Authorization='Bearer '\+authSession\.access_token;/g)];
  assert.equal(guarded.length, 2);
  const currentCheckout = html.slice(html.lastIndexOf('async function submitOrder('));
  assert.match(currentCheckout, /await ensureFreshSession\(\)/);
  assert.match(currentCheckout, /if\(authSession\?\.access_token\)headers\.Authorization='Bearer '\+authSession\.access_token/);
  assert.match(fnSource('supabaseRequest'), /if\(token===undefined\)\{await ensureFreshSession\(\);token=authSession\?\.access_token\}/);
  assert.match(fnSource('customerApi'), /await ensureFreshSession\(\)/);
});

// ---- server-side ownership (public.my_orders) --------------------------------------------

const migration = readFileSync(new URL(`../supabase/migrations/${readdirSync(new URL('../supabase/migrations/', import.meta.url)).find(f => f.endsWith('_customer_my_orders.sql'))}`, import.meta.url), 'utf8');
const body = migration.replace(/--.*$/gm, '');

test('my_orders(): own orders by user_id; unlinked orders only by the VERIFIED account email', () => {
  assert.match(body, /create or replace function public\.my_orders\(\)\s*returns table/, 'takes no arguments: nothing client-supplied');
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = public, pg_temp/);
  assert.match(body, /where u\.id = auth\.uid\(\)/);
  assert.match(body, /when u\.email_confirmed_at is not null then lower\(trim\(u\.email\)\) end as verified_email/);
  assert.match(body, /where o\.user_id = me\.id\s+or \(o\.user_id is null\s+and me\.verified_email is not null\s+and o\.customer_email is not null\s+and lower\(trim\(o\.customer_email\)\) = me\.verified_email\)/);
  // No admin shortcut: ownership only, so an admin sees only their own orders here.
  assert.doesNotMatch(body, /is_admin/);
});

test('my_orders(): returns only customer-safe columns and is not callable anonymously', () => {
  const columns = body.match(/returns table \(([\s\S]*?)\n\)/)[1].split(',').map(l => l.trim().split(/\s+/)[0]);
  assert.deepEqual(columns, ['order_number', 'items', 'amount_total', 'currency', 'status', 'shipping_company', 'tracking_number', 'created_at', 'updated_at']);
  for (const hidden of ['fulfillment', 'customer_email', 'user_id', 'stripe', 'admin_note', 'paid_amount']) assert.ok(!columns.some(c => c.includes(hidden)), hidden);
  assert.match(body, /revoke all on function public\.my_orders\(\) from public;/);
  assert.match(body, /revoke all on function public\.my_orders\(\) from anon;/);
  assert.match(body, /grant execute on function public\.my_orders\(\) to authenticated;/);
});

// ---- Arabic / English -------------------------------------------------------------------

test('every new label has English, and the preparing stage reads "Preparing order"', () => {
  const window = {};
  vm.runInNewContext(catalogSource, { window, Intl });
  const { exact } = window.AJLIB_TRANSLATIONS;
  const expected = {
    'العودة إلى حسابي': 'Back to my account', 'الطلبات المحتسبة في المبيعات': 'Orders counted in sales', 'قيد التجهيز': 'Preparing order',
    'إجمالي الطلبات': 'Total orders', 'طلبات نشطة': 'Active orders', 'تم تسليمها': 'Delivered', 'درهم مبيعات': 'Sales in AED',
    'تم الدفع': 'Paid', 'تم التسليم': 'Delivered', 'لا توجد طلبات حالية.': 'You have no current orders.'
  };
  for (const [ar, en] of Object.entries(expected)) assert.equal(exact[ar], en, ar);
  // Direction follows the page language (the language switcher flips dir), so
  // the new controls inherit RTL/LTR — none hard-codes a direction.
  assert.doesNotMatch(html.slice(html.indexOf('id="adminBackToAccount"') - 80, html.indexOf('id="adminBackToAccount"') + 120), /dir=/);
});

test('an empty cart never requests a shipping quote (the fee needs a quantity)', async () => {
  const box = element();
  const calls = [];
  const form = { elements: { country_code: { value: 'US' }, country_name: { value: '' } } };
  const context = {
    document: { getElementById: (id) => ({ checkout: form, shippingQuote: box })[id] || null },
    fetch: async (...args) => { calls.push(args); throw new Error('no network'); },
    countryName: (c) => c, cart: null, shippingQuote: 'stale', JSON
  };
  vm.createContext(context);
  vm.runInContext(fnSource('updateShippingQuote'), context);
  assert.equal(await context.updateShippingQuote(), null);
  context.cart = { items: [] };
  assert.equal(await context.updateShippingQuote(), null);
  assert.equal(calls.length, 0);
  assert.equal(context.shippingQuote, null);
});
