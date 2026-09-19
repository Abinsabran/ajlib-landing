import { test } from 'node:test';
import assert from 'node:assert/strict';
import commerce from '../api/commerce.js';
import { quoteShipping } from '../api/shipping-quote.js';
import { shippingFeeFils, shippingAnchorFor } from '../api/_lib/shipping-policy.js';
import { computeProductPricing } from '../api/_lib/pricing.js';
import { evaluateFulfillmentMargin, paymentFeeUSD } from '../api/_lib/cj-fulfillment.js';
import { PROFIT_GUARD_MIN_MARGIN_PERCENT, PROFIT_GUARD_MIN_NET_PROFIT_AED } from '../api/_lib/logistics-policy.js';

// APPROVED 2026-09-18: same product prices everywhere, customer shipping by
// destination group and quantity bracket, and a two-part profit guard before
// any automatic CJ order.

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
};
const withEnv = async (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
};
const noDb = (fn) => withEnv({ SUPABASE_URL: '', SUPABASE_SECRET_KEY: '' }, fn);

const ANCHORS = [5, 10, 15, 20, 50];
const PRODUCT_AED = { 5: 135, 10: 269, 15: 399, 20: 519, 50: 1249 };
const SHIPPING_AED = {
  AE: { 5: 0, 10: 0, 15: 0, 20: 0, 50: 0 },
  GCC: { 5: 50, 10: 40, 15: 30, 20: 20, 50: 10 },
  INTL: { 5: 25, 10: 20, 15: 15, 20: 10, 50: 5 }
};
const TOTAL_AED = {
  AE: { 5: 135, 10: 269, 15: 399, 20: 519, 50: 1249 },
  GCC: { 5: 185, 10: 309, 15: 429, 20: 539, 50: 1259 },
  INTL: { 5: 160, 10: 289, 15: 414, 20: 529, 50: 1254 }
};
const GROUPS = { AE: ['AE'], GCC: ['SA', 'KW', 'QA', 'BH'], INTL: ['US', 'AU'] };

// ---- product prices and shipping -----------------------------------------------------

test('product prices are the same approved ladder in every market', () => {
  for (const q of ANCHORS) assert.equal(computeProductPricing(q).productAmount, PRODUCT_AED[q] * 100, `qty ${q}`);
});

test('shipping ladder: UAE free, GCC 50/40/30/20/10, US/AU 25/20/15/10/5 AED', () => {
  for (const [group, countries] of Object.entries(GROUPS)) {
    for (const country of countries) {
      for (const q of ANCHORS) assert.equal(shippingFeeFils(country, q), SHIPPING_AED[group][q] * 100, `${country}/${q}`);
    }
  }
});

test('custom quantities use the same brackets as the product price ladder', () => {
  const cases = { 5: 5, 7: 5, 9: 5, 10: 10, 12: 10, 14: 10, 15: 15, 19: 15, 20: 20, 35: 20, 49: 20, 50: 50, 75: 50, 100: 50 };
  for (const [q, anchor] of Object.entries(cases)) {
    assert.equal(shippingAnchorFor(Number(q)), anchor, `qty ${q}`);
    // The shipping bracket and the unit-price bracket are the same one.
    assert.equal(computeProductPricing(Number(q)).unitPrice, PRODUCT_AED[anchor] / anchor, `unit price ${q}`);
    assert.equal(shippingFeeFils('SA', Number(q)), SHIPPING_AED.GCC[anchor] * 100);
    assert.equal(shippingFeeFils('US', Number(q)), SHIPPING_AED.INTL[anchor] * 100);
  }
  for (const bad of [0, 4, 4.5, NaN, -5]) assert.equal(shippingFeeFils('AE', bad), null, String(bad));
});

test('every expected AED total, as the order-quote API returns it', () => noDb(async () => {
  for (const [group, countries] of Object.entries(GROUPS)) {
    for (const country of countries) {
      for (const q of ANCHORS) {
        const res = await commerce({ method: 'GET', query: { resource: 'order-quote', quantity: String(q), country } }, makeRes());
        assert.equal(res.statusCode, 200, `${country}/${q}`);
        assert.equal(res.body.productSubtotal, PRODUCT_AED[q] * 100, `${country}/${q} product`);
        assert.equal(res.body.shipping, SHIPPING_AED[group][q] * 100, `${country}/${q} shipping`);
        assert.equal(res.body.total, TOTAL_AED[group][q] * 100, `${country}/${q} total`);
        assert.equal(res.body.isFreeShipping, group === 'AE');
      }
    }
  }
}));

test('the shipping fee is server-side only: quotes without a quantity carry no amount', () => noDb(async () => {
  const quote = await quoteShipping('US');
  assert.equal(quote.amount, null);
  assert.ok(Number.isFinite(quote.max_days), 'the delivery window is still available to fulfillment');
  await assert.rejects(quoteShipping('US', 3), /كمية/);
}));

test('Oman stays unsupported', () => noDb(async () => {
  assert.equal(shippingFeeFils('OM', 10), null);
  await assert.rejects(quoteShipping('OM', 10), /غير متاح/);
  const res = await commerce({ method: 'GET', query: { resource: 'order-quote', quantity: '10', country: 'OM' } }, makeRes());
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'UNSUPPORTED_SHIPPING_COUNTRY');
}));

// ---- profit guard -------------------------------------------------------------------------

test('profit guard thresholds are fixed at 25% and 30 AED', () => {
  assert.equal(PROFIT_GUARD_MIN_MARGIN_PERCENT, 25);
  assert.equal(PROFIT_GUARD_MIN_NET_PROFIT_AED, 30);
});

// Live-shaped CJ costs: $2.21 per unit, $0.02 sticker per unit.
const guard = (collectedAed, freightUSD, units, extra = {}) => evaluateFulfillmentMargin({
  productAmountCollectedFils: collectedAed * 100, shippingAmountCollectedFils: 0,
  cjProductCostUSD: 2.21 * units, cjShippingCostUSD: freightUSD, unitCount: units, ...extra
});

test('both pass (>= 25% and >= 30 AED): eligible for CJ auto-create', () => {
  // US 10 pieces at the new AED 289 total, YunExpress $27.48 live freight.
  const r = guard(289, 27.48, 10, { international: true });
  assert.equal(r.approved, true);
  assert.equal(r.reason, 'MARGIN_OK');
  assert.ok(r.details.marginPercent >= 25 && r.details.netProfitAed >= 30, JSON.stringify(r.details));
});

test('margin below 25% -> MARGIN_BELOW_25_PERCENT, not eligible', () => {
  const r = guard(160, 30, 5, { international: true });
  assert.equal(r.approved, false);
  assert.equal(r.reason, 'MARGIN_BELOW_25_PERCENT');
  assert.ok(r.details.marginPercent < 25);
});

test('margin >= 25% but net profit below 30 AED -> NET_PROFIT_BELOW_30_AED, not eligible', () => {
  // A small order can clear 25% and still earn under 30 AED.
  const r = evaluateFulfillmentMargin({ productAmountCollectedFils: 10000, shippingAmountCollectedFils: 0, cjProductCostUSD: 11.05, cjShippingCostUSD: 7.05, unitCount: 5 });
  assert.ok(r.details.marginPercent >= 25, `margin ${r.details.marginPercent}`);
  assert.ok(r.details.netProfitAed < 30, `profit ${r.details.netProfitAed}`);
  assert.equal(r.approved, false);
  assert.equal(r.reason, 'NET_PROFIT_BELOW_30_AED');
});

test('both fail -> the margin reason is reported first', () => {
  const r = guard(100, 40, 5);
  assert.equal(r.approved, false);
  assert.equal(r.reason, 'MARGIN_BELOW_25_PERCENT');
  assert.ok(r.details.netProfitAed < 30);
});

test('the guard uses canonical AED economics and the real payment fee (USD adds conversion)', () => {
  const aed = paymentFeeUSD({ amountCollectedFils: 28900 });
  const usd = paymentFeeUSD({ amountCollectedFils: 28900, currencyConversion: true });
  const intl = paymentFeeUSD({ amountCollectedFils: 28900, international: true, currencyConversion: true });
  assert.ok(usd > aed && intl > usd);
  // 289 AED: 2.9% + 1 AED; +1% conversion; +1% international.
  assert.equal(Number(aed.toFixed(4)), Number(((289 * 0.029 + 1) * 0.2723).toFixed(4)));
  assert.equal(Number(intl.toFixed(4)), Number(((289 * 0.049 + 1) * 0.2723).toFixed(4)));
  const paidInUsd = guard(289, 27.48, 10, { international: true, currencyConversion: true });
  const paidInAed = guard(289, 27.48, 10, { international: true });
  assert.equal(paidInUsd.details.collectedAed, 289, 'collected is canonical AED, whatever the paid currency');
  assert.ok(paidInUsd.details.netProfitAed < paidInAed.details.netProfitAed);
});
