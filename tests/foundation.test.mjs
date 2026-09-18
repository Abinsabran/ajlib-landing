import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProductPricing, computeUnitPrice, computeSavingsPercent, BASELINE_UNIT_PRICE, MIN_QUANTITY, MAX_QUANTITY } from '../api/_lib/pricing.js';
import { allVariants, PRODUCTS, COLORS, SIZES } from '../api/_lib/catalog.js';
import { COUNTRY_CURRENCY, currencyForCountry, convertAedFilsForDisplay } from '../api/_lib/currency.js';
import { customerStatusFor, serializeOrderForCustomer, CUSTOMER_STATUS } from '../api/_lib/fulfillment-status.js';
import { readFile } from 'node:fs/promises';

// PRICING — approved UAE launch ladder: 135/269/399/519 AED at 5/10/15/20,
// 1249 at 50+. Every tier clears 25% true net margin on BOTH Stripe and
// Tabby; tests/pricing-economics.test.mjs holds the margin proof. The
// storefront (index.html) duplicates this ladder and must stay in lockstep.
test('pricing: matches the approved launch tiers exactly', () => {
  assert.equal(computeProductPricing(5).productAmount, 13500);
  assert.equal(computeProductPricing(10).productAmount, 26900);
  assert.equal(computeProductPricing(15).productAmount, 39900);
  assert.equal(computeProductPricing(20).productAmount, 51900);
  assert.equal(computeProductPricing(50).productAmount, 124900);
});

test('pricing: the old 25 AED/unit sub-5 anchor is gone — 5 is the floor rate', () => {
  assert.equal(BASELINE_UNIT_PRICE, 27);
  // Anything below the minimum prices at the 5-piece rate, never at 25.
  for (const qty of [1, 2, 3, 4]) {
    assert.equal(computeUnitPrice(qty), 27, `qty ${qty} must not price below the 5-piece rate`);
  }
});

test('savings are computed from the ladder and never negative, zero, or overstated', () => {
  // 5 is the baseline, so it has no saving to advertise.
  assert.equal(computeSavingsPercent(5), 0);
  // 10 is only 0.37% cheaper per unit than the baseline (26.90 vs 27.00),
  // which is below the 1% display threshold — so it advertises nothing
  // rather than rounding a third of a percent up into a "1%" claim.
  assert.equal(computeSavingsPercent(10), 0);

  for (const qty of [15, 20, 50]) {
    const saving = computeSavingsPercent(qty);
    assert.ok(saving >= 1, `qty ${qty} should advertise a real saving, got ${saving}`);
    // Derived from the live ladder, never a hardcoded percentage.
    assert.equal(saving, Math.round((1 - computeUnitPrice(qty) / BASELINE_UNIT_PRICE) * 100));
  }

  // No quantity may ever produce a negative badge.
  for (let qty = 1; qty <= MAX_QUANTITY; qty += 1) {
    assert.ok(computeSavingsPercent(qty) >= 0, `qty ${qty} produced a negative saving`);
  }
});

test('pricing: unit price converges to 24.98 at and above 50', () => {
  assert.equal(computeProductPricing(50).unitPrice, 1249 / 50);
  assert.equal(computeProductPricing(MAX_QUANTITY).unitPrice, 1249 / 50);
});

test('pricing: the volume ladder never inverts across the approved tiers', () => {
  const tiers = [5, 10, 15, 20, 50];
  for (let i = 1; i < tiers.length; i += 1) {
    assert.ok(
      computeProductPricing(tiers[i]).unitPrice <= computeProductPricing(tiers[i - 1]).unitPrice,
      `qty ${tiers[i]} costs more per unit than qty ${tiers[i - 1]}`
    );
  }
});

test('pricing: quantity bounds match the server-enforced range (5-100)', () => {
  assert.equal(MIN_QUANTITY, 5);
  assert.equal(MAX_QUANTITY, 100);
});

// CATALOG — all 16 color x size combinations must exist for the one live product.
test('catalog: exposes exactly 4 colors and 4 sizes', () => {
  assert.equal(COLORS.length, 4);
  assert.equal(SIZES.length, 4);
});

test('catalog: the live product has all 16 variant combinations', () => {
  const variants = allVariants(PRODUCTS[0].sku);
  assert.equal(variants.length, 16);
  for (const color of ['black', 'navy', 'gray', 'white']) {
    for (const size of ['M', 'L', 'XL', 'XXL']) {
      assert.ok(variants.some(v => v.color === color && v.size === size), `${color}/${size} missing`);
    }
  }
});

// CURRENCY — display mapping only; must never claim to affect shipping eligibility.
test('currency: covers exactly the 8 supported shipping-country currencies', () => {
  assert.deepEqual(Object.keys(COUNTRY_CURRENCY).sort(), ['AE', 'AU', 'BH', 'KW', 'OM', 'QA', 'SA', 'US'].sort());
});

test('currency: unsupported country returns null instead of guessing', () => {
  assert.equal(currencyForCountry('GB'), null);
});

test('currency: AED passes through unconverted', () => {
  assert.equal(convertAedFilsForDisplay(10000, 'AED'), 100);
});

// FULFILLMENT STATUS — internal admin statuses must map to exactly the 5
// customer-facing statuses (plus cancelled/refunded), and tracking must stay
// hidden until the order has actually shipped.
test('fulfillment: every internal status maps to a known customer status', () => {
  for (const status of ['paid', 'processing', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded']) {
    const key = customerStatusFor(status);
    assert.ok(key, `${status} did not map`);
    assert.ok(CUSTOMER_STATUS[key], `${key} is not a known customer status`);
  }
});

test('fulfillment: tracking number is hidden before SHIPPED', () => {
  const order = { status: 'packed', tracking_number: 'TRACK123', order_number: 'AJ1', amount_total: 1000, currency: 'aed', items: [] };
  const serialized = serializeOrderForCustomer(order);
  assert.equal(serialized.tracking_number, null);
});

test('fulfillment: tracking number is visible from SHIPPED onward', () => {
  const shipped = serializeOrderForCustomer({ status: 'shipped', tracking_number: 'TRACK123', order_number: 'AJ1', amount_total: 1000, currency: 'aed', items: [] });
  const delivered = serializeOrderForCustomer({ status: 'delivered', tracking_number: 'TRACK123', order_number: 'AJ1', amount_total: 1000, currency: 'aed', items: [] });
  assert.equal(shipped.tracking_number, 'TRACK123');
  assert.equal(delivered.tracking_number, 'TRACK123');
});

test('fulfillment: no internal/provider fields leak into the customer serialization', () => {
  const order = {
    status: 'paid', order_number: 'AJ1', amount_total: 1000, currency: 'aed', items: [],
    fulfillmentProvider: 'cj', fulfillmentExternalOrderId: 'CJ123', fulfillmentError: 'boom', stripe_session_id: 'cs_secret'
  };
  const serialized = serializeOrderForCustomer(order);
  for (const leaked of ['fulfillmentProvider', 'fulfillmentExternalOrderId', 'fulfillmentError', 'stripe_session_id']) {
    assert.equal(serialized[leaked], undefined, `${leaked} leaked to the customer`);
  }
});

// The storefront duplicates the pricing ladder (index.html defines both a
// `packs` array and flexibleUnitPrice). If it drifts from api/_lib/pricing.js the
// customer sees one price and is charged another, so pin them together.
test('storefront pricing matches the server-authoritative ladder exactly', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  const packs = [...html.matchAll(/\{n:(\d+),p:(\d+),label:/g)].map(m => ({ n: Number(m[1]), p: Number(m[2]) }));
  assert.ok(packs.length >= 4, 'could not find the storefront pack definitions');
  for (const pack of packs) {
    assert.equal(pack.p * 100, computeProductPricing(pack.n).productAmount, `pack of ${pack.n} shows ${pack.p} AED but the server charges ${computeProductPricing(pack.n).productAmount / 100}`);
  }

  const fn = html.match(/function flexibleUnitPrice\(n\)\{([^}]*)\}/);
  assert.ok(fn, 'could not find flexibleUnitPrice in the storefront');
  const flexibleUnitPrice = new Function('n', fn[1]);
  for (const qty of [1, 4, 5, 9, 10, 14, 15, 19, 20, 49, 50, 100]) {
    assert.ok(
      Math.abs(flexibleUnitPrice(qty) - computeProductPricing(qty).unitPrice) < 1e-9,
      `qty ${qty}: storefront ${flexibleUnitPrice(qty)} vs server ${computeProductPricing(qty).unitPrice}`
    );
  }
});

test('the storefront no longer carries the hardcoded 25 AED compare-at anchor', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('pack-old-price'), 'the struck-through compare-at price must be gone');
  assert.ok(!/1-unit\/25/.test(html), 'the hardcoded /25 discount anchor must be gone');
  assert.ok(!html.includes('>25 درهم للقطعة<'), 'the 25 AED/unit copy must be gone');
});

test('the storefront enforces the same 5-unit minimum as the server', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const bounds = html.match(/const MIN_QTY=(\d+),MAX_QTY=(\d+);/);
  assert.ok(bounds, 'storefront quantity bounds not found');
  assert.equal(Number(bounds[1]), MIN_QUANTITY, 'storefront minimum must match the server');
  assert.equal(Number(bounds[2]), MAX_QUANTITY, 'storefront maximum must match the server');
  // The quantity input itself must not offer anything below the minimum.
  const input = html.match(/id="qty"[^>]*min="(\d+)"[^>]*value="(\d+)"/);
  assert.ok(input, 'quantity input not found');
  assert.equal(Number(input[1]), MIN_QUANTITY);
  assert.ok(Number(input[2]) >= MIN_QUANTITY);
});

test('every storefront route to a sub-minimum order is closed', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  // Reducing a group's quantity.
  assert.ok(/setCartGroupQuantity[\s\S]{0,200}?<MIN_QTY/.test(html), 'group quantity reduction must check the minimum');
  // Removing a whole group and stranding the remainder.
  assert.ok(/removeCartGroup[\s\S]{0,200}?<MIN_QTY/.test(html), 'group removal must not strand a sub-minimum cart');
  // Final gate: opening checkout at all.
  assert.ok(/beginCheckout[\s\S]{0,160}?cart\.items\.length<MIN_QTY/.test(html), 'checkout must be gated on the minimum');
});

test('storefront savings badges match the server calculation exactly, with no badge below 1%', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const expr = html.match(/savings=\(1-unit\/baseline\)\*100,discount=savings>=1\?Math\.round\(savings\):0/);
  assert.ok(expr, 'storefront savings expression does not match the agreed rule');

  // Re-run the storefront's own rule against every pack and compare to the server.
  const fn = html.match(/function flexibleUnitPrice\(n\)\{([^}]*)\}/);
  const flexibleUnitPrice = new Function('n', fn[1]);
  const baseline = flexibleUnitPrice(MIN_QUANTITY);
  for (const qty of [5, 10, 15, 20, 50]) {
    const savings = (1 - flexibleUnitPrice(qty) / baseline) * 100;
    const shown = savings >= 1 ? Math.round(savings) : 0;
    assert.equal(shown, computeSavingsPercent(qty), `qty ${qty}: storefront badge ${shown}% vs server ${computeSavingsPercent(qty)}%`);
    assert.ok(shown >= 0, 'a negative badge must be impossible');
  }
});
