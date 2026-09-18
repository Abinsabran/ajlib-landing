import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHIPPING_COUNTRIES, isShippingCountry } from '../api/_lib/markets.js';
import { quoteShipping } from '../api/shipping-quote.js';
import shippingQuoteHandler from '../api/shipping-quote.js';
import commerce from '../api/commerce.js';
import checkoutSession from '../api/checkout-session.js';
import { buildValidatedOrder, OrderValidationError } from '../api/_lib/order-validation.js';

// AJLIB ships only to its approved markets. The whitelist is enforced
// server-side (quoteShipping, which every quote and checkout path calls), so
// hiding countries in the UI is not what keeps them out: a tampered request
// for any other country is rejected by the API itself.

const APPROVED = ['AE', 'SA', 'KW', 'QA', 'BH', 'US', 'AU'];
// Oman first (removed: DDU route), then a spread of every former zone.
const REJECTED = ['OM', 'GB', 'FR', 'DE', 'EG', 'JO', 'IN', 'CN', 'NZ', 'CA', 'MX', 'BR', 'ZA', 'NG', 'TR', 'IL', 'XK', 'ZZ'];
// Every ISO 3166-1 alpha-2 code the storefront used to offer.
const ALL_ISO = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' ');

const makeRes = () => {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  return res;
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
};

const orderTo = (countryCode) => ({
  id: 'AJ-MARKETS-1',
  customer: { email: 'buyer@example.com', name: 'Test Buyer', country_code: countryCode, country_name: countryCode, region: 'R', city: 'C', address: '1 Test St', phone: '+971500000000', postal_code: '12345' },
  cart: { items: Array.from({ length: 5 }, () => ({ color: 'أسود', size: 'L' })) }
});

const orderQuote = (country) => commerce({ method: 'GET', query: { resource: 'order-quote', quantity: '10', country } }, makeRes());

// Supabase is deliberately not configured in these tests, so no real order,
// inventory row or shipping zone is touched.
const noDb = (fn) => withEnv({ SUPABASE_URL: '', SUPABASE_SECRET_KEY: '' }, fn);

test('the whitelist is exactly the 7 approved markets, frozen, without Oman', () => {
  assert.deepEqual([...SHIPPING_COUNTRIES], APPROVED);
  assert.ok(Object.isFrozen(SHIPPING_COUNTRIES));
  assert.equal(isShippingCountry('OM'), false);
  for (const code of APPROVED) assert.equal(isShippingCountry(code.toLowerCase()), true, code);
});

test('all 7 approved markets are accepted by quoteShipping, order-quote and shipping-quote', () => noDb(async () => {
  for (const code of APPROVED) {
    const quote = await quoteShipping(code);
    assert.equal(quote.country_code, code);

    const res = await orderQuote(code);
    assert.equal(res.statusCode, 200, `order-quote ${code}`);
    assert.deepEqual(res.body.supportedCountries, APPROVED);

    const shipping = await shippingQuoteHandler({ method: 'GET', query: { country_code: code } }, makeRes());
    assert.equal(shipping.statusCode, 200, `shipping-quote ${code}`);
  }
}));

test('Oman is rejected by every quote endpoint', () => noDb(async () => {
  await assert.rejects(quoteShipping('OM'), /غير متاح/);
  const res = await orderQuote('OM');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'UNSUPPORTED_SHIPPING_COUNTRY');
  const shipping = await shippingQuoteHandler({ method: 'POST', body: { country_code: 'om' } }, makeRes());
  assert.equal(shipping.statusCode, 400);
}));

test('every other country (the whole former ISO list) is rejected server-side', () => noDb(async () => {
  const others = ALL_ISO.filter(code => !APPROVED.includes(code));
  assert.equal(others.length, ALL_ISO.length - APPROVED.length);
  for (const code of [...others, ...REJECTED]) {
    await assert.rejects(quoteShipping(code), Error, code);
  }
  for (const code of REJECTED) {
    const res = await orderQuote(code);
    assert.equal(res.statusCode, 400, `order-quote ${code}`);
    assert.equal(res.body.code, 'UNSUPPORTED_SHIPPING_COUNTRY');
  }
}));

test('checkout (Stripe web/app and Tabby share buildValidatedOrder) rejects OM and others with 400 before any payment call', () => noDb(async () => {
  for (const code of REJECTED) {
    await assert.rejects(buildValidatedOrder(orderTo(code)), (error) => error instanceof OrderValidationError && error.status === 400, code);
  }
  await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
    const originalFetch = globalThis.fetch;
    let paymentCalls = 0;
    globalThis.fetch = async () => { paymentCalls += 1; throw new Error('no network in tests'); };
    try {
      for (const code of ['OM', 'GB', 'EG']) {
        const res = await checkoutSession({ method: 'POST', body: orderTo(code), headers: {} }, makeRes());
        assert.equal(res.statusCode, 400, `checkout ${code}`);
        assert.match(res.body.error, /غير متاح/);
      }
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(paymentCalls, 0, 'Stripe must never be called for an unsupported country');
  });
  for (const code of APPROVED) {
    const order = await buildValidatedOrder(orderTo(code));
    assert.equal(order.countryCode, code);
    assert.equal(order.shipping.country_code, code);
  }
}));

// ---- website dropdowns --------------------------------------------------

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the website offers exactly the 7 approved markets in every country dropdown', () => {
  const literal = html.match(/const SHIPPING_COUNTRIES=(\[[^\]]*\])/);
  assert.ok(literal, 'index.html must define SHIPPING_COUNTRIES');
  const siteList = JSON.parse(literal[1].replace(/'/g, '"'));
  assert.deepEqual(siteList, APPROVED);

  // Evaluate the real dropdown builder with the real list.
  const fn = html.match(/function countryOptions\(selected='AE'\)\{[^\n]*?\.join\(''\)\}/);
  assert.ok(fn, 'countryOptions must exist');
  const countryOptions = new Function('SHIPPING_COUNTRIES', 'countryName', 'escapeHtml', `${fn[0]};return countryOptions;`)(siteList, (c) => c, (s) => s);
  const values = [...countryOptions('').matchAll(/<option value="([A-Z]{2})"/g)].map(m => m[1]);
  assert.deepEqual(values, APPROVED);

  // The builder dropdown uses the same list, with no "all countries" group.
  assert.match(html, /function initBuildCountry\(\)\{[^}]*el\.innerHTML=SHIPPING_COUNTRIES\.map\(/);
  assert.doesNotMatch(html, /ISO_COUNTRY_CODES/);
  assert.doesNotMatch(html, /جميع الدول/);
  assert.doesNotMatch(html, /'OM'/);
});

// ---- mobile parity --------------------------------------------------------

const mobileRuntime = fileURLToPath(new URL('../../../outputs/ajlib-mobile/commercial-runtime.js', import.meta.url));

test('the mobile app country lists equal the backend whitelist', { skip: !existsSync(mobileRuntime) && 'mobile repo not present' }, async () => {
  const mobile = await import(pathToFileURL(mobileRuntime).href);
  assert.deepEqual([...mobile.PRIMARY_DELIVERY_MARKETS], [...SHIPPING_COUNTRIES]);
  assert.deepEqual([...mobile.FALLBACK_SHIPPING_COUNTRIES], [...SHIPPING_COUNTRIES]);
});

// ---- shipping copy ----------------------------------------------------------

const catalog = readFileSync(new URL('../assets/store-translations.js', import.meta.url), 'utf8');

test('customer-facing shipping copy no longer promises worldwide delivery and names no countries', () => {
  for (const text of [html, catalog]) {
    assert.doesNotMatch(text, /جميع دول العالم|شحن عالمي|أي دولة|Worldwide delivery|Worldwide shipping|deliver worldwide|any other country/);
  }
  assert.ok(html.includes('<div class="badge">✓ شحن سريع ومباشر إلى بابك</div>'));
  assert.ok(html.includes('<p class="note">خيارات الشحن والتكلفة ومدة التوصيل تظهر عند اختيار دولة التوصيل.</p>'));
  assert.ok(catalog.includes("'✓ شحن سريع ومباشر إلى بابك': '✓ Fast, direct delivery to your door'"));
  assert.ok(catalog.includes("'خيارات الشحن والتكلفة ومدة التوصيل تظهر عند اختيار دولة التوصيل.': 'Shipping options, cost, and delivery estimates are shown after selecting your delivery country.'"));
});
