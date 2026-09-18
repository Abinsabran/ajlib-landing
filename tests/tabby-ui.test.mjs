// The storefront's Tabby payment option. The #tabby-checkout script is run
// against a minimal fake page so its behaviour — not just its text — is
// checked: when Tabby is shown, what is sent, where the browser goes, and
// that card (Stripe) payment is never taken away.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const catalog = await readFile(new URL('assets/store-translations.js', root), 'utf8');
const vercel = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'));
const script = html.match(/<script id="tabby-checkout">([\s\S]*?)<\/script>/)[1];

const element = (props = {}) => ({ hidden: false, textContent: '', innerHTML: '', disabled: false, classList: { add() {}, remove() {}, toggle() {} }, ...props });

// A fresh fake page per test. fetchImpl receives (url, options).
const page = (fetchImpl, { pending = null } = {}) => {
  const card = { value: 'card', checked: true };
  const tabby = { value: 'tabby', checked: false };
  const els = {
    tabbyMethod: element({ hidden: true, querySelector: () => tabby }),
    tabbyNote: element({ hidden: true }),
    payButton: element({ textContent: 'الانتقال للدفع الإلكتروني' }),
    orderSuccess: element({ hidden: true }),
    drawer: element(), cartBody: element(), checkout: element(), count: element({ textContent: '5' })
  };
  const calls = [], toasts = [], store = new Map(pending ? [['ajlibTabbyPending', JSON.stringify(pending)]] : []);
  const removed = [];
  const ctx = {
    console, URL, URLSearchParams, JSON, encodeURIComponent,
    cart: { items: Array.from({ length: 5 }, () => ({ color: 'أسود', size: 'L' })), pack: { n: 5, p: 1 } },
    authSession: null,
    location: { href: 'https://store.test/', search: '', pathname: '/', hash: '' },
    history: { replaceState() {} },
    document: {
      getElementById: id => els[id],
      querySelector: sel => sel.includes(':checked') ? [card, tabby].find(r => r.checked) : sel.includes('[value="card"]') ? card : null
    },
    sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    localStorage: { removeItem: k => removed.push(k) },
    fetch: async (url, options = {}) => { calls.push({ url, options }); return fetchImpl(url, options); },
    updateShippingQuote: async () => ({}),
    saveCheckoutToProfile: async () => {},
    toast: m => toasts.push(m),
    openCart: () => { calls.push({ url: 'openCart' }); },
    escapeHtml: s => String(s)
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return { ctx, els, card, tabby, calls, toasts, store, removed };
};
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const quoteAndAvailability = (available) => (url) =>
  url.startsWith('/api/order-quote') ? json({ total: 13500, currency: 'aed' }) : json({ available, currency: 'AED', mode: 'test' });

// ---- eligibility ----------------------------------------------------------------

test('card (Stripe) is present and selected by default; Tabby starts hidden', () => {
  assert.match(html, /<input type="radio" name="pay_method" value="card" checked/);
  assert.match(html, /<label class="pay-method" id="tabbyMethod" hidden>/);
});

test('Tabby appears only when the server says the order is eligible', async () => {
  const p = page(quoteAndAvailability(true));
  await p.ctx.refreshTabbyOption('AE');
  assert.equal(p.els.tabbyMethod.hidden, false);
  assert.equal(p.card.checked, true, 'card stays the default even when Tabby is offered');
});

test('eligibility uses the server quote total, never a browser-side amount', async () => {
  const p = page(quoteAndAvailability(true));
  await p.ctx.refreshTabbyOption('AE');
  assert.equal(p.calls[0].url, '/api/order-quote?quantity=5&country=AE');
  assert.equal(p.calls[1].url, '/api/tabby-availability?country_code=AE&amount_fils=13500');
});

test('ineligible: Tabby is hidden and card is selected again', async () => {
  const p = page(quoteAndAvailability(false));
  p.tabby.checked = true; p.card.checked = false;
  await p.ctx.refreshTabbyOption('US');
  assert.equal(p.els.tabbyMethod.hidden, true);
  assert.equal(p.card.checked, true);
});

test('if the eligibility check fails, Tabby stays hidden and card payment is untouched', async () => {
  const p = page(() => { throw new Error('network down'); });
  await p.ctx.refreshTabbyOption('AE');
  assert.equal(p.els.tabbyMethod.hidden, true);
  assert.equal(p.card.checked, true);
  assert.equal(p.els.payButton.disabled, false);
});

test('a slow, outdated eligibility answer cannot override a newer one', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  let n = 0;
  const p = page(async (url) => {
    if (url.startsWith('/api/order-quote')) return json({ total: 13500 });
    n += 1;
    if (n === 1) { await slow; return json({ available: true }); }
    return json({ available: false });
  });
  const first = p.ctx.refreshTabbyOption('AE');
  await p.ctx.refreshTabbyOption('US');
  release();
  await first;
  assert.equal(p.els.tabbyMethod.hidden, true);
});

// ---- starting Tabby ----------------------------------------------------------------

const tabbySession = (url = 'https://checkout.tabby.ai/123') => (u) =>
  u === '/api/tabby-checkout' ? json({ provider: 'tabby', available: true, paymentId: 'pay_1', checkoutUrl: url, status: 'created' }) : json({});

test('Tabby checkout sends the order but no amount, and goes to the server-generated Tabby URL', async () => {
  const p = page(tabbySession());
  const data = { email: 'a@b.co', country_code: 'AE' };
  await p.ctx.startTabbyCheckout(p.els.payButton, data, 'AJ00000001');
  const call = p.calls.find(c => c.url === '/api/tabby-checkout');
  const body = JSON.parse(call.options.body);
  assert.deepEqual(Object.keys(body).sort(), ['cart', 'customer', 'id']);
  assert.equal(body.cart.items.length, 5);
  assert.ok(!JSON.stringify(body).includes('"amount"'), 'no client amount');
  assert.equal(p.ctx.location.href, 'https://checkout.tabby.ai/123');
  assert.deepEqual(JSON.parse(p.store.get('ajlibTabbyPending')).paymentId, 'pay_1');
});

test('a checkout URL that is not Tabby\'s is refused; the customer falls back to card', async () => {
  for (const bad of ['https://evil.example/pay', 'http://checkout.tabby.ai/x', 'https://tabby.ai.evil.example/x', 'javascript:alert(1)']) {
    const p = page(tabbySession(bad));
    await p.ctx.startTabbyCheckout(p.els.payButton, {}, 'AJ1');
    assert.equal(p.ctx.location.href, 'https://store.test/', `must not redirect to ${bad}`);
    assert.equal(p.els.tabbyMethod.hidden, true);
    assert.equal(p.card.checked, true);
    assert.equal(p.els.payButton.disabled, false);
  }
});

test('if Tabby declines the order at checkout, card stays available with a clear note', async () => {
  const p = page((u) => json({ provider: 'tabby', available: false, reason: 'NO_CHECKOUT_URL' }));
  await p.ctx.startTabbyCheckout(p.els.payButton, {}, 'AJ1');
  assert.equal(p.els.tabbyMethod.hidden, true);
  assert.equal(p.els.tabbyNote.hidden, false);
  assert.match(p.els.tabbyNote.textContent, /يمكنك الدفع بالبطاقة/);
  assert.equal(p.els.payButton.disabled, false);
  assert.equal(p.els.payButton.textContent, 'الانتقال للدفع الإلكتروني');
});

// ---- returning from Tabby ------------------------------------------------------------

const PENDING = { id: 'AJ1', paymentId: 'pay_1', customer: { email: 'a@b.co' }, cart: { items: [] } };

test('cancel or failure never calls verify and keeps the cart', async () => {
  for (const status of ['cancelled', 'failed']) {
    const p = page(() => json({}), { pending: PENDING });
    await p.ctx.handleTabbyReturn(new URLSearchParams(`tabby=${status}&order_id=AJ1`));
    assert.equal(p.calls.filter(c => String(c.url).includes('tabby-verify')).length, 0);
    assert.ok(!p.removed.includes('ajlibCart'));
  }
});

test('success is confirmed by the server with the stored payment id before the cart is cleared', async () => {
  const p = page((u) => json({ paid: true, order_id: 'AJ1' }), { pending: PENDING });
  await p.ctx.handleTabbyReturn(new URLSearchParams('tabby=success&order_id=AJ1&payment_id=ignored'));
  const verify = p.calls.find(c => c.url === '/api/tabby-verify');
  assert.equal(JSON.parse(verify.options.body).payment_id, 'pay_1');
  assert.ok(p.removed.includes('ajlibCart'));
  assert.match(p.els.orderSuccess.innerHTML, /تم تأكيد الدفع عبر Tabby/);
});

test('a redirect alone never confirms the order: an unconfirmed payment keeps the cart', async () => {
  const p = page(() => json({ error: 'لم يكتمل الدفع عبر Tabby بعد' }, 402), { pending: PENDING });
  await p.ctx.handleTabbyReturn(new URLSearchParams('tabby=success&order_id=AJ1'));
  assert.ok(!p.removed.includes('ajlibCart'));
  assert.match(p.els.orderSuccess.innerHTML, /الدفع قيد التحقق/);
});

test('returning without a stored order (e.g. the app flow) shows guidance and calls nothing', async () => {
  const p = page(() => json({}));
  await p.ctx.handleTabbyReturn(new URLSearchParams('tabby=success&order_id=AJ9'));
  assert.equal(p.calls.length, 0);
  assert.match(p.els.orderSuccess.innerHTML, /تطبيق AJLIB/);
});

// ---- Stripe unchanged, routes, secrets, labels ---------------------------------------------

test('the card (Stripe) path is unchanged: only a Tabby selection is diverted', () => {
  assert.match(html, /if\(selectedPayMethod\(\)==='tabby'\)return startTabbyCheckout\(button,data,id\);button\.disabled=true;button\.textContent='جارٍ حفظ البيانات وتجهيز صفحة Stripe…';/);
  assert.match(html, /fetch\('\/api\/checkout-session',\{method:'POST',headers,body:JSON\.stringify\(\{id,amount:cart\.pack\.p,customer:data,cart\}\)\}\)/);
});

test('Tabby checkout and verify have clean routes to the commerce function', () => {
  const map = Object.fromEntries(vercel.rewrites.map(r => [r.source, r.destination]));
  assert.equal(map['/api/tabby-checkout'], '/api/commerce?resource=tabby-checkout');
  assert.equal(map['/api/tabby-verify'], '/api/commerce?resource=tabby-verify');
  assert.equal(map['/api/tabby-availability'], '/api/commerce?resource=tabby-availability');
});

test('the storefront carries no payment secret and never reads Tabby configuration', () => {
  for (const secret of ['TABBY_SECRET', 'TABBY_PUBLIC_KEY', 'STRIPE_SECRET', 'sk_live_', 'sk_test_', 'whsec_']) assert.ok(!html.includes(secret), secret);
});

test('every Arabic payment string in the Tabby UI has an English translation', () => {
  const markup = html.slice(html.indexOf('<fieldset class="pay-methods"'), html.indexOf('</fieldset>', html.indexOf('<fieldset class="pay-methods"')));
  const fromMarkup = [...markup.matchAll(/>([^<>]*[؀-ۿ][^<>]*)</g)].map(m => m[1].trim());
  // Plain string literals only; literals holding markup are covered by the
  // text-between-tags scan below.
  const fromScript = [...script.matchAll(/'([^'\n`;{}<>]*[؀-ۿ][^'\n`;{}<>]*)'/g)].map(m => m[1]);
  const fromTemplates = [...script.matchAll(/>([^<>`$]*[؀-ۿ][^<>`$]*)</g)].map(m => m[1].trim()).filter(t => !/^رقم الطلب|^للاستفسار|^احتفظ/.test(t));
  const strings = [...new Set([...fromMarkup, ...fromScript, ...fromTemplates])].filter(Boolean);
  assert.ok(strings.length >= 12, `found ${strings.length} strings`);
  const missing = strings.filter(s => !catalog.includes(`'${s}':`));
  assert.deepEqual(missing, []);
});

test('the Tabby script loads before the page runs its payment-return handler', () => {
  // Found on Preview: appended after the main script, handleTabbyReturn did
  // not exist yet when handlePaymentReturn() ran at load.
  const tabbyAt = html.indexOf('<script id="tabby-checkout">');
  const initAt = html.indexOf('handlePaymentReturn().then');
  assert.ok(tabbyAt > 0 && initAt > tabbyAt, 'tabby-checkout must come before the load-time handlePaymentReturn() call');
});
