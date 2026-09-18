// Confirmed commercial inputs and the true-net-margin economics built on
// them. Figures here are the real ones: CJ cjPrice $2.21/unit, live AE
// freight, AJLIB sticker $0.02/unit, Stripe UAE 2.9% + AED 1.00, Tabby UAE
// 6.99% + AED 1.50.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateFulfillmentMargin, paymentFeeUSD, computeTrueVariableCost,
  minimumRevenueAedForMargin, aedToUsd
} from '../api/_lib/cj-fulfillment.js';
import {
  TABBY_FEE_PERCENT, TABBY_FEE_FIXED_AED, CJ_CUSTOMIZATION_COST_USD_PER_UNIT,
  STRIPE_FEE_PERCENT, STRIPE_FEE_FIXED_AED, selectLogisticsMethod, DELIVERY_PROMISE_MAX_DAYS
} from '../api/_lib/logistics-policy.js';

const CJ_UNIT_COST = 2.21;

test('the confirmed Tabby UAE rate is 6.99% + AED 1.50 and is no longer treated as unknown', () => {
  assert.equal(TABBY_FEE_PERCENT, 6.99);
  assert.equal(TABBY_FEE_FIXED_AED, 1.5);
  // 119 AED -> 6.99% + 1.50 = 9.8181 AED
  const fee = paymentFeeUSD({ amountCollectedFils: 11900, provider: 'tabby' });
  assert.ok(Math.abs(fee - aedToUsd(119 * 0.0699 + 1.5)) < 1e-9);
  assert.notEqual(fee, null, 'Tabby fee must no longer be null/unknown');
});

test('a Tabby order can now be margin-scored instead of blocking as unconfigured', () => {
  const verdict = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0,
    cjProductCostUSD: 11.05, cjShippingCostUSD: 13.25, unitCount: 5, provider: 'tabby'
  });
  assert.notEqual(verdict.reason, 'PAYMENT_FEE_NOT_CONFIGURED');
  assert.ok(Number.isFinite(verdict.details.marginPercent));
});

test('Tabby always costs more than Stripe on the same order, so it is scored separately', () => {
  const args = { cjProductCostUSD: 11.05, cjShippingCostUSD: 13.25, unitCount: 5, productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0 };
  const stripe = evaluateFulfillmentMargin({ ...args, provider: 'stripe' });
  const tabby = evaluateFulfillmentMargin({ ...args, provider: 'tabby' });
  assert.ok(tabby.details.breakdown.paymentFeeUSD > stripe.details.breakdown.paymentFeeUSD);
  assert.ok(tabby.details.marginPercent < stripe.details.marginPercent);
});

test('the confirmed sticker cost is $0.02 per unit and scales with quantity, not per order', () => {
  assert.equal(CJ_CUSTOMIZATION_COST_USD_PER_UNIT, 0.02);
  for (const [qty, expected] of [[5, 0.10], [10, 0.20], [15, 0.30], [20, 0.40], [50, 1.00]]) {
    const cost = computeTrueVariableCost({
      cjProductCostUSD: 0, cjShippingCostUSD: 0, unitCount: qty,
      amountCollectedFils: 10000, provider: 'stripe'
    });
    assert.ok(Math.abs(cost.breakdown.customizationUSD - expected) < 1e-9, `qty ${qty}: expected $${expected}, got $${cost.breakdown.customizationUSD}`);
  }
});

test('true variable cost includes every confirmed component', () => {
  const cost = computeTrueVariableCost({
    cjProductCostUSD: 11.05, cjShippingCostUSD: 13.25, unitCount: 5,
    amountCollectedFils: 11900, provider: 'stripe'
  });
  const b = cost.breakdown;
  assert.equal(b.cjProductCostUSD, 11.05);
  assert.equal(b.cjShippingCostUSD, 13.25);
  assert.ok(Math.abs(b.customizationUSD - 0.10) < 1e-9);
  assert.ok(b.paymentFeeUSD > 0);
  assert.ok(Math.abs(cost.total - (11.05 + 13.25 + 0.10 + b.paymentFeeUSD)) < 1e-9);
});

// ---- DELIVERY WINDOW (approved ~7-14 days) ----------------------------------

test('route selection honours the approved 7-14 day window using real AE aging data', () => {
  assert.equal(DELIVERY_PROMISE_MAX_DAYS, 14);
  // Real live AE qty-5 method set.
  const methods = [
    { logisticName: 'CJPacket Eub', totalPostageFee: 10.52, logisticAging: '12-50' },
    { logisticName: 'CJPacket Eub Special Line', totalPostageFee: 12.46, logisticAging: '8-15' },
    { logisticName: 'CJPacket Liquid Line', totalPostageFee: 13.25, logisticAging: '7-10' },
    { logisticName: 'CJPacket Ordinary', totalPostageFee: 16.19, logisticAging: '7-11' },
    { logisticName: 'DHL Official', totalPostageFee: 118.44, logisticAging: '3-5' }
  ];
  const sel = selectLogisticsMethod(methods, { countryCode: 'AE', maxDeliveryDays: 14 });
  // Eub ($10.52) is cheapest overall but 12-50 days — outside the promise,
  // so it must NOT be chosen merely for being cheaper.
  assert.notEqual(sel.method, 'CJPacket Eub');
  // Eub Special Line's 15-day upper bound also breaks a 14-day promise.
  assert.notEqual(sel.method, 'CJPacket Eub Special Line');
  // DHL fits the window but is ruinous; it must not win on speed either.
  assert.notEqual(sel.method, 'DHL Official');
  // CJPacket Liquid Line ($13.25) is a liquids channel, excluded for apparel.
  assert.notEqual(sel.method, 'CJPacket Liquid Line');
  assert.equal(sel.method, 'CJPacket Ordinary');
  assert.equal(sel.cost, 16.19);
  assert.equal(sel.reason, 'CHEAPEST_MEETING_PROMISE');
});

// ---- CURRENT PRICING IS UNSAFE ----------------------------------------------

test('the PREVIOUS prices failed the 25% band on both providers — regression guard against reverting', () => {
  // Kept as a record of why the ladder was repriced: at the old prices not
  // one tier cleared the band, and Tabby was below the 20% floor everywhere.
  const tiers = [
    { qty: 5, priceAed: 119, freight: 13.25 },
    { qty: 10, priceAed: 219, freight: 23.15 },
    { qty: 15, priceAed: 309, freight: 38.89 },
    { qty: 20, priceAed: 389, freight: 48.98 },
    { qty: 50, priceAed: 925, freight: 118.24 }
  ];
  for (const { qty, priceAed, freight } of tiers) {
    for (const provider of ['stripe', 'tabby']) {
      const verdict = evaluateFulfillmentMargin({
        productAmountCollectedFils: priceAed * 100, shippingAmountCollectedFils: 0,
        cjProductCostUSD: CJ_UNIT_COST * qty, cjShippingCostUSD: freight,
        unitCount: qty, provider
      });
      assert.notEqual(verdict.band, 'GREEN', `qty ${qty} ${provider} unexpectedly GREEN at current price`);
      assert.equal(verdict.approved, false, `qty ${qty} ${provider} must not auto-fulfill at current price`);
    }
  }
});

test('the APPROVED launch prices reach GREEN on BOTH providers at every tier', () => {
  const approved = [
    { qty: 5, priceAed: 135, freight: 13.25 },
    { qty: 10, priceAed: 269, freight: 23.15 },
    { qty: 15, priceAed: 399, freight: 38.89 },
    { qty: 20, priceAed: 519, freight: 48.98 },
    { qty: 50, priceAed: 1249, freight: 118.24 }
  ];
  for (const { qty, priceAed, freight } of approved) {
    for (const provider of ['stripe', 'tabby']) {
      const verdict = evaluateFulfillmentMargin({
        productAmountCollectedFils: priceAed * 100, shippingAmountCollectedFils: 0,
        cjProductCostUSD: CJ_UNIT_COST * qty, cjShippingCostUSD: freight,
        unitCount: qty, provider
      });
      assert.equal(verdict.band, 'GREEN', `qty ${qty} ${provider} only reached ${verdict.details.marginPercent}%`);
    }
  }
});

test('the approved ladder never inverts — price per unit never rises with quantity', () => {
  const ladder = [[5, 135], [10, 269], [15, 399], [20, 519], [50, 1249]];
  for (let i = 1; i < ladder.length; i += 1) {
    const prev = ladder[i - 1][1] / ladder[i - 1][0];
    const current = ladder[i][1] / ladder[i][0];
    assert.ok(current <= prev + 1e-9, `qty ${ladder[i][0]} costs ${current}/unit vs ${prev}/unit at qty ${ladder[i - 1][0]}`);
  }
});

test('the reverse solver agrees with the evaluator for both providers', () => {
  for (const provider of ['stripe', 'tabby']) {
    const nonPayment = (CJ_UNIT_COST * 5) + 13.25 + 0.10;
    for (const target of [20, 25, 30]) {
      const priceAed = minimumRevenueAedForMargin({ targetMarginPercent: target, nonPaymentVariableCostUSD: nonPayment, provider });
      const check = evaluateFulfillmentMargin({
        productAmountCollectedFils: Math.round(priceAed * 100), shippingAmountCollectedFils: 0,
        cjProductCostUSD: CJ_UNIT_COST * 5, cjShippingCostUSD: 13.25, unitCount: 5, provider
      });
      assert.ok(Math.abs(check.details.marginPercent - target) < 0.01, `${provider} ${target}% -> ${check.details.marginPercent}%`);
    }
  }
});

test('Stripe fee constants still match the published UAE card rate', () => {
  assert.equal(STRIPE_FEE_PERCENT, 2.9);
  assert.equal(STRIPE_FEE_FIXED_AED, 1.0);
});
