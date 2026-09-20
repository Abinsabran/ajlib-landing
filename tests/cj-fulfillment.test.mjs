import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFulfillmentVariants, getCurrentCjProductCosts, resolveFreightAndLogistics,
  evaluateFulfillmentMargin, alreadyHasFulfillmentOrder, cjOrderNumberFor, buildCjOrderPayload,
  prepareFulfillment, FulfillmentBlockedError,
  parseCjBalanceUSD, evaluateBalanceSufficiency, aedToUsd,
  CJ_PAY_TYPE_BALANCE, CJ_PAY_TYPE_CREATE_ONLY,
  paymentFeeUSD, computeTrueVariableCost, minimumRevenueAedForMargin
} from '../api/_lib/cj-fulfillment.js';
import { readFile } from 'node:fs/promises';
import { isCjErrorBody, throttleCj, CJ_MIN_REQUEST_GAP_MS } from '../api/_lib/cj-client.js';
import {
  selectLogisticsMethod, maxAgingDays, MIN_ACCEPTABLE_MARGIN_PERCENT, CJ_BALANCE_LOW_WARNING_AED,
  classifyMargin, CJ_MARGIN_AUTO_PERCENT, CJ_MARGIN_REVIEW_FLOOR_PERCENT, CJ_MARGIN_TARGET_PERCENT
} from '../api/_lib/logistics-policy.js';
import { PROVIDER_STATUS_MAP, nextInternalStatusFromCjStatus, serializeOrderForCustomer } from '../api/_lib/fulfillment-status.js';
import { AJLIB_VARIANT_KEYS } from '../api/_lib/cj-variant-map.js';

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
};

// ---- VARIANT RESOLUTION -----------------------------------------------------

test('resolves all 16 confirmed AJLIB variants to their CJ variant id/sku', () => {
  for (const key of AJLIB_VARIANT_KEYS) {
    const { resolved, unresolved, fullyResolved } = resolveFulfillmentVariants([{ variant: key, quantity: 5 }]);
    assert.equal(fullyResolved, true);
    assert.equal(unresolved.length, 0);
    assert.equal(resolved[0].variant, key);
    assert.match(resolved[0].cjVariantId, /^\d+$/);
  }
});

test('an unrecognized/invalid variant blocks fulfillment instead of being silently dropped', () => {
  const { resolved, unresolved, fullyResolved } = resolveFulfillmentVariants([
    { variant: 'أسود-L', quantity: 5 },
    { variant: 'أحمر-XXXL', quantity: 3 } // not a real AJLIB variant
  ]);
  assert.equal(fullyResolved, false);
  assert.equal(unresolved.length, 1);
  assert.equal(resolved.length, 1);
});

// ---- FREIGHT / LOGISTICS SELECTION ------------------------------------------

test('freight uses the actual destination country and quantities passed in, not a hardcoded default', async () => {
  let capturedBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: [{ logisticName: 'DHL Official', logisticPrice: 100, totalPostageFee: 100 }] }) };
  };
  try {
    await withEnv({ CJ_API_KEY: 'test' }, async () => {
      // getAccessToken will fail without a real token cache; stub around it
      // by mocking the auth call too.
      let authCalled = false;
      globalThis.fetch = async (url, options) => {
        if (String(url).includes('getAccessToken')) { authCalled = true; return { ok: true, json: async () => ({ data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) }; }
        capturedBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ data: [{ logisticName: 'DHL Official', logisticPrice: 100, totalPostageFee: 100 }] }) };
      };
      await resolveFreightAndLogistics({ resolvedItems: [{ cjVariantId: '123', quantity: 20 }], destinationCountryCode: 'OM' });
      assert.ok(authCalled);
      assert.equal(capturedBody.endCountryCode, 'OM');
      assert.equal(capturedBody.products[0].quantity, 20);
      assert.equal(capturedBody.startCountryCode, 'CN');
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('logistics selection falls back safely when no methods are available', () => {
  const result = selectLogisticsMethod([], { countryCode: 'AE' });
  assert.equal(result.method, null);
  assert.equal(result.reason, 'NO_METHODS_AVAILABLE');
});

test('logistics selection never hardcodes CJPacket for a large order — respects real availability', () => {
  // Real Phase 3 finding: CJPacket Postal disappears at qty>=15 everywhere,
  // and Oman drops to DHL-only. Simulate that exact case.
  const largeOrderAvailability = [{ logisticName: 'DHL Official', logisticPrice: 130, totalPostageFee: 130 }];
  const result = selectLogisticsMethod(largeOrderAvailability, { countryCode: 'OM' });
  assert.equal(result.method, 'DHL Official'); // correctly picks the only real option, never CJPacket Postal
});

test('logistics selection reports ONLY_METHOD_AVAILABLE when there is a single valid route', () => {
  const result = selectLogisticsMethod([{ logisticName: 'Qfulfillment A line', logisticPrice: 24, totalPostageFee: 24 }], { countryCode: 'US' });
  assert.equal(result.method, 'Qfulfillment A line');
  assert.equal(result.reason, 'ONLY_METHOD_AVAILABLE');
});

test('logistics selection picks the CHEAPEST available method, not a hardcoded CJPacket Postal preference', () => {
  // Real live AE qty-5 data: Eub is cheapest, Postal is mid-priced. The old
  // preference-list policy picked Postal and silently cost ~21pp of margin.
  const availability = [
    { logisticName: 'CJPacket Postal', logisticPrice: 17.96, totalPostageFee: 17.96, logisticAging: '7-12' },
    { logisticName: 'CJPacket Eub', logisticPrice: 10.52, totalPostageFee: 10.52, logisticAging: '7-12' },
    { logisticName: 'DHL Official', logisticPrice: 118.44, totalPostageFee: 118.44, logisticAging: '3-6' }
  ];
  const result = selectLogisticsMethod(availability, { countryCode: 'AE' });
  assert.equal(result.method, 'CJPacket Eub');
  assert.equal(result.cost, 10.52);
  assert.equal(result.reason, 'CHEAPEST_AVAILABLE');
});

test('DHL is selected automatically when it is the cheapest valid route (e.g. a large Oman order)', () => {
  const result = selectLogisticsMethod([{ logisticName: 'DHL Official', logisticPrice: 130, totalPostageFee: 130, logisticAging: '3-6' }], { countryCode: 'OM' });
  assert.equal(result.method, 'DHL Official');
});

test('a delivery promise filters out routes that are too slow, and picks the cheapest that still meets it', () => {
  const availability = [
    { logisticName: 'CJPacket Eub', logisticPrice: 10.52, totalPostageFee: 10.52, logisticAging: '7-12' },
    { logisticName: 'DHL Official', logisticPrice: 118.44, totalPostageFee: 118.44, logisticAging: '3-6' }
  ];
  const result = selectLogisticsMethod(availability, { countryCode: 'AE', maxDeliveryDays: 6 });
  assert.equal(result.method, 'DHL Official'); // Eub's 12-day upper bound breaks a 6-day promise
  assert.equal(result.reason, 'ONLY_METHOD_MEETS_PROMISE');
});

test('when NO available route can meet the delivery promise, selection blocks instead of silently over-promising', () => {
  const availability = [
    { logisticName: 'CJPacket Eub', logisticPrice: 10.52, totalPostageFee: 10.52, logisticAging: '7-12' },
    { logisticName: 'DHL Official', logisticPrice: 118.44, totalPostageFee: 118.44, logisticAging: '3-6' }
  ];
  const result = selectLogisticsMethod(availability, { countryCode: 'AE', maxDeliveryDays: 3 });
  assert.equal(result.method, null);
  assert.equal(result.reason, 'NO_METHOD_MEETS_DELIVERY_PROMISE');
  // The fastest real option is reported as context for a human decision,
  // but must NOT be presented as a selection.
  assert.equal(result.fastestAvailable.method, 'DHL Official');
});

test('a method with unparseable aging is never assumed fast enough to meet a promise', () => {
  const result = selectLogisticsMethod(
    [{ logisticName: 'Mystery Line', logisticPrice: 5, totalPostageFee: 5, logisticAging: '' }],
    { countryCode: 'AE', maxDeliveryDays: 10 }
  );
  assert.equal(result.method, null);
  assert.equal(result.reason, 'NO_METHOD_MEETS_DELIVERY_PROMISE');
});

test('maxAgingDays reads the UPPER bound of CJ\'s real aging strings', () => {
  assert.equal(maxAgingDays({ logisticAging: '7-12' }), 12);
  assert.equal(maxAgingDays({ logisticAging: '10' }), 10);
  assert.equal(maxAgingDays({ logisticAging: null }), null);
});

// ---- COST SAFETY -------------------------------------------------------------

test('platformPrice is never treated as CJ supplier cost — cost comes from cjPrice via a live connection query', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('getAccessToken')) return { ok: true, json: async () => ({ data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) };
    if (String(url).includes('/product/conn/connection')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            list: [
              { cjVariantId: 'v1', cjPrice: '2.21', platformPrice: '6.81' } // platformPrice must never be read as cost
            ]
          }
        })
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const costed = await getCurrentCjProductCosts([{ cjVariantId: 'v1', quantity: 10 }]);
    assert.equal(costed[0].unitCostUSD, 2.21);
    assert.equal(costed[0].lineCostUSD, 22.1);
    assert.notEqual(costed[0].unitCostUSD, 6.81);
  } finally { globalThis.fetch = originalFetch; }
  });
});

test('margin guard blocks fulfillment when no threshold is configured (unconfigured is NOT "no limit")', () => {
  const result = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0,
    cjProductCostUSD: 10, cjShippingCostUSD: 5, aedToUsdRate: 0.2723,
    minAcceptableMarginPercent: null
  });
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'MARGIN_THRESHOLD_NOT_CONFIGURED');
});

test('margin guard blocks fulfillment when the real margin is below a configured threshold', () => {
  const result = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0, // 119 AED collected
    cjProductCostUSD: 30, cjShippingCostUSD: 10, aedToUsdRate: 0.2723, // ~32.4 USD collected, 40 USD cost -> negative margin
    minAcceptableMarginPercent: 15
  });
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'MARGIN_BELOW_25_PERCENT');
  assert.ok(result.details.marginPercent < 15);
});

test('margin guard approves when the real margin meets a configured threshold', () => {
  const result = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0,
    cjProductCostUSD: 5, cjShippingCostUSD: 2, aedToUsdRate: 0.2723,
    minAcceptableMarginPercent: 15
  });
  assert.equal(result.approved, true);
  assert.equal(result.reason, 'MARGIN_OK');
});

// ---- APPROVED 20% MARGIN THRESHOLD ------------------------------------------

test('the approved default margin threshold is 20% and is applied when no explicit threshold is passed', () => {
  assert.equal(MIN_ACCEPTABLE_MARGIN_PERCENT, 20);
  // Real AE qty-5 numbers with the OLD CJPacket Postal pick: 10.5% margin.
  const withPostal = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0,
    cjProductCostUSD: 11.05, cjShippingCostUSD: 17.96
  });
  assert.equal(withPostal.approved, false, 'a 10.5% margin must be blocked by the 20% threshold');
  assert.equal(withPostal.reason, 'MARGIN_BELOW_25_PERCENT');

  // Same order with the cheapest-available pick (CJPacket Eub): ~33%.
  const withEub = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0,
    cjProductCostUSD: 11.05, cjShippingCostUSD: 10.52
  });
  assert.equal(withEub.approved, true);
  assert.ok(withEub.details.marginPercent > 20);
});

test('a known per-unit customization/sticker cost is included in the true variable cost', () => {
  const base = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0,
    cjProductCostUSD: 11.05, cjShippingCostUSD: 10.52, unitCount: 5
  });
  const withExtra = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0,
    cjProductCostUSD: 11.05, cjShippingCostUSD: 10.52, unitCount: 5,
    customizationCostPerUnitUSD: 1 // $1/unit x 5 units, vs the $0.02/unit default
  });
  const expectedDelta = (1 - 0.02) * 5;
  assert.ok(Math.abs((withExtra.details.fulfillmentCostUSD - base.details.fulfillmentCostUSD) - expectedDelta) < 1e-9);
  assert.ok(withExtra.details.marginPercent < base.details.marginPercent);
});

// ---- CJ BALANCE PREFLIGHT ----------------------------------------------------

test('an unrecognized CJ balance response shape yields null and blocks — never treated as zero or unlimited', () => {
  assert.equal(parseCjBalanceUSD({ data: { somethingUnexpected: 5 } }), null);
  assert.equal(parseCjBalanceUSD({}), null);
  const result = evaluateBalanceSufficiency({ balanceUSD: null, requiredUSD: 29.01 });
  assert.equal(result.sufficient, false);
  assert.equal(result.reason, 'CJ_BALANCE_UNAVAILABLE');
});

test('sufficient CJ balance approves the order and reports what would remain', () => {
  const result = evaluateBalanceSufficiency({ balanceUSD: 300, requiredUSD: 29.01 });
  assert.equal(result.sufficient, true);
  assert.equal(result.reason, 'BALANCE_OK');
  assert.ok(Math.abs(result.remainingAfterUSD - 270.99) < 0.001);
});

test('insufficient CJ balance blocks automatic fulfillment (no auto top-up, order preserved for review)', () => {
  const result = evaluateBalanceSufficiency({ balanceUSD: 10, requiredUSD: 29.01 });
  assert.equal(result.sufficient, false);
  assert.equal(result.reason, 'INSUFFICIENT_CJ_BALANCE');
});

test('the low-balance warning fires on what REMAINS after the order, at the approved 150 AED threshold — and never blocks', () => {
  assert.equal(CJ_BALANCE_LOW_WARNING_AED, 150);
  // Leaves ~100 AED equivalent -> warn, but the order is still affordable.
  const low = evaluateBalanceSufficiency({ balanceUSD: aedToUsd(100) + 50.84, requiredUSD: 50.84 });
  assert.equal(low.sufficient, true);
  assert.equal(low.reason, 'BALANCE_OK');
  assert.equal(low.lowBalanceWarning, true);
  // Leaves ~400 AED equivalent (inside the approved 300-500 funding) -> no warning.
  const healthy = evaluateBalanceSufficiency({ balanceUSD: aedToUsd(400) + 50.84, requiredUSD: 50.84 });
  assert.equal(healthy.lowBalanceWarning, false);
  // One cent short blocks, whatever the warning says.
  const short = evaluateBalanceSufficiency({ balanceUSD: 50.83, requiredUSD: 50.84 });
  assert.equal(short.sufficient, false);
  assert.equal(short.reason, 'INSUFFICIENT_CJ_BALANCE');
});

test('prepareFulfillment blocks with INSUFFICIENT_CJ_BALANCE before building any payload', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('getAccessToken')) return { ok: true, json: async () => ({ data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) };
      if (u.includes('/product/conn/connection')) return { ok: true, json: async () => ({ data: { list: [{ cjVariantId: '1581871544320667650', cjPrice: '2.21' }] } }) };
      if (u.includes('/logistic/freightCalculate')) return { ok: true, json: async () => ({ data: [{ logisticName: 'CJPacket Eub', logisticPrice: 10.52, totalPostageFee: 10.52, logisticAging: '7-12' }] }) };
      // Real CJ shape: available balance is `amount`, in a success envelope.
      if (u.includes('/shopping/pay/getBalance')) return { ok: true, json: async () => ({ code: 200, result: true, data: { amount: 1.00, freezeAmount: 0, noWithdrawalAmount: 0 } }) };
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      await assert.rejects(
        () => prepareFulfillment({
          order_number: 'AJ-BAL-1', items: [{ variant: 'أسود-L', quantity: 5 }],
          customer_name: 'Test Buyer', customer_phone: '+971500000000', shipping_street: '1 Test St', shipping_city: 'دبي', shipping_country_code: 'AE', product_amount: 11900, shipping_amount: 0
        }, { maxDeliveryDays: 50, paymentMode: 'balance' }),
        (err) => err instanceof FulfillmentBlockedError && err.reason === 'INSUFFICIENT_CJ_BALANCE'
      );
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('the CJ wallet is never spent directly — no payBalance endpoint exists anywhere in the client', async () => {
  const clientSource = await readFile(new URL('../api/_lib/cj-client.js', import.meta.url), 'utf8');
  // Comments may *name* the write endpoints to explain why they're absent;
  // what must not exist is an actual request built against one.
  const code = clientSource.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/payBalance/.test(code), 'payBalance/payBalanceV2 must never be called from this codebase');
  // Path corrected per CJ support — see tests/cj-balance-timeout.test.mjs.
  assert.ok(code.includes('pay/getBalance'), 'read-only balance query should be present');
});

// ---- IDEMPOTENCY ---------------------------------------------------------------

test('an order that already has a fulfillment reference is never fulfilled twice', async () => {
  const orderRow = { fulfillment_external_order_id: 'cj-order-123', items: [] };
  assert.equal(alreadyHasFulfillmentOrder(orderRow), true);
  await assert.rejects(() => prepareFulfillment(orderRow), (err) => {
    assert.ok(err instanceof FulfillmentBlockedError);
    assert.equal(err.reason, 'ALREADY_FULFILLED');
    return true;
  });
});

test('cjOrderNumberFor is stable and deterministic — the same AJLIB order always produces the same CJ idempotency key', () => {
  assert.equal(cjOrderNumberFor('AJ-000123'), cjOrderNumberFor('AJ-000123'));
  assert.notEqual(cjOrderNumberFor('AJ-000123'), cjOrderNumberFor('AJ-000124'));
});

test('buildCjOrderPayload uses orderNumber as CJ\'s documented idempotency key', () => {
  const payload = buildCjOrderPayload({
    ajlibOrderNumber: 'AJ-000123', resolvedItems: [{ cjVariantId: '123', quantity: 5 }],
    logisticName: 'DHL Official', shippingCountryCode: 'AE', shippingCountry: 'الإمارات العربية المتحدة',
    shippingCity: 'دبي', shippingCustomerName: 'Test', shippingAddress: 'x'
  });
  assert.equal(payload.orderNumber, 'AJLIB-AJ-000123');
});

// ---- payType (CJ Balance operating model) -----------------------------------

test('automatic fulfillment uses payType=2 (CJ Balance), never payType=3', () => {
  assert.equal(CJ_PAY_TYPE_BALANCE, 2);
  assert.equal(CJ_PAY_TYPE_CREATE_ONLY, 3);
  const payload = buildCjOrderPayload({
    ajlibOrderNumber: 'AJ-000123', resolvedItems: [{ cjVariantId: '123', quantity: 5 }],
    logisticName: 'CJPacket Eub', shippingCountryCode: 'AE', shippingCity: 'دبي',
    shippingCustomerName: 'Test', shippingAddress: 'x'
  });
  assert.equal(payload.payType, 2);
  // payType=3 would create an order inside CJ that is never paid — exactly
  // the silent-failure mode the approved operating model forbids.
  assert.notEqual(payload.payType, CJ_PAY_TYPE_CREATE_ONLY);
});

test('an unresolved variant blocks fulfillment before any freight/cost call is made', async () => {
  const orderRow = { items: [{ variant: 'not-a-real-variant', quantity: 1 }] };
  await assert.rejects(() => prepareFulfillment(orderRow), (err) => {
    assert.ok(err instanceof FulfillmentBlockedError);
    assert.equal(err.reason, 'UNRESOLVED_VARIANT');
    return true;
  });
});

test('missing shipping_city (a real, confirmed schema gap) blocks fulfillment rather than sending an incomplete CJ order', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('getAccessToken')) return { ok: true, json: async () => ({ data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) };
      if (String(url).includes('/product/conn/connection')) return { ok: true, json: async () => ({ data: { list: [{ cjVariantId: '1581871544320667650', cjPrice: '2.21' }] } }) };
      if (String(url).includes('/logistic/freightCalculate')) return { ok: true, json: async () => ({ data: [{ logisticName: 'DHL Official', logisticPrice: 100, totalPostageFee: 100 }] }) };
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      const orderRow = {
        order_number: 'AJ-TEST-CITY', items: [{ variant: 'أسود-L', quantity: 5 }],
        shipping_country_code: 'AE', product_amount: 11900, shipping_amount: 0
        // shipping_city intentionally absent — matches the real orders schema
      };
      await assert.rejects(() => prepareFulfillment(orderRow, { minAcceptableMarginPercent: 15, aedToUsdRate: 0.2723 }), (err) => {
        assert.ok(err instanceof FulfillmentBlockedError);
        assert.equal(err.reason, 'MISSING_SHIPPING_CITY');
        return true;
      });
    } finally { globalThis.fetch = originalFetch; }
  });
});

// ---- STATUS ---------------------------------------------------------------

test('CJ statuses map only into AJLIB\'s existing internal admin statuses, which in turn map onto exactly the 5 customer statuses', () => {
  for (const cjStatus of Object.keys(PROVIDER_STATUS_MAP)) {
    const mapped = PROVIDER_STATUS_MAP[cjStatus];
    assert.ok(['paid', 'processing', 'packed', 'shipped', 'delivered', 'cancelled'].includes(mapped), `${cjStatus} -> ${mapped} is not a recognized internal status`);
  }
});

test('an unrecognized CJ status is never guessed at — returns null instead of forcing a mapping', () => {
  assert.equal(nextInternalStatusFromCjStatus('paid', 'SOME_NEW_CJ_STATUS_NOT_YET_SEEN'), null);
});

test('delivered cannot regress backward from a later CJ status update', () => {
  assert.equal(nextInternalStatusFromCjStatus('delivered', 'SHIPPED'), null);
  assert.equal(nextInternalStatusFromCjStatus('delivered', 'PROCESSING'), null);
  assert.equal(nextInternalStatusFromCjStatus('shipped', 'PENDING'), null);
});

test('forward progress is allowed', () => {
  assert.equal(nextInternalStatusFromCjStatus('paid', 'PROCESSING'), 'packed');
  assert.equal(nextInternalStatusFromCjStatus('packed', 'SHIPPED'), 'shipped');
  assert.equal(nextInternalStatusFromCjStatus('shipped', 'DELIVERED'), 'delivered');
});

test('CJ-side cancellation always surfaces regardless of rank', () => {
  assert.equal(nextInternalStatusFromCjStatus('shipped', 'CANCELLED'), 'cancelled');
});

test('tracking hidden before shipped, visible from shipped onward, unaffected by CJ integration', () => {
  const preShip = serializeOrderForCustomer({ status: 'packed', tracking_number: 'TRACK1', order_number: 'AJ1', amount_total: 1000, currency: 'aed', items: [] });
  const postShip = serializeOrderForCustomer({ status: 'shipped', tracking_number: 'TRACK1', order_number: 'AJ1', amount_total: 1000, currency: 'aed', items: [] });
  assert.equal(preShip.tracking_number, null);
  assert.equal(postShip.tracking_number, 'TRACK1');
});

// ---- SECURITY ---------------------------------------------------------------

test('no CJ fields leak into the customer-facing serialization even when the order row carries fulfillment metadata', () => {
  const order = {
    status: 'shipped', order_number: 'AJ1', amount_total: 1000, currency: 'aed', items: [], tracking_number: 'TRACK1',
    fulfillment_provider: 'cj', fulfillment_external_order_id: 'cj-999', fulfillment_external_order_number: 'AJLIB-AJ1',
    fulfillment_status: 'SHIPPED', fulfillment_logistics_method: 'DHL Official', fulfillment_cost: 42.5,
    fulfillment_currency: 'USD', fulfillment_last_sync_at: '2026-01-01', fulfillment_error: null, fulfillment_retry_count: 0
  };
  const serialized = serializeOrderForCustomer(order);
  const json = JSON.stringify(serialized);
  for (const key of Object.keys(serialized)) assert.ok(!key.toLowerCase().startsWith('fulfillment'), `leaked: ${key}`);
  assert.ok(!json.includes('DHL Official'));
  assert.ok(!json.includes('cj-999'));
});

test('buildCjOrderPayload never includes a CJ secret or access token', () => {
  const payload = buildCjOrderPayload({
    ajlibOrderNumber: 'AJ-1', resolvedItems: [{ cjVariantId: '1', quantity: 1 }],
    logisticName: 'DHL Official', shippingCountryCode: 'AE', shippingCity: 'دبي', shippingCustomerName: 'x', shippingAddress: 'x'
  });
  const json = JSON.stringify(payload).toLowerCase();
  assert.ok(!json.includes('token'));
  assert.ok(!json.includes('apikey'));
});

// ---- EXISTING SYSTEM UNCHANGED ------------------------------------------------

test('the pipeline never recomputes AJLIB product/shipping pricing — it only reads what was already collected', () => {
  // evaluateFulfillmentMargin takes productAmountCollectedFils/shippingAmountCollectedFils
  // as opaque inputs; it performs no pricing calculation of its own.
  const src = evaluateFulfillmentMargin.toString();
  assert.ok(!src.includes('computeUnitPrice') && !src.includes('computeProductPricing'));
});

// ---- ORCHESTRATION-LEVEL IDEMPOTENCY (duplicate Stripe/Tabby deliveries) ----
// These simulate the real failure mode the brief calls out: a duplicate
// Stripe webhook delivery, or a duplicate Tabby verify call, invoking the
// fulfillment pipeline a second time for an order that already has (or is
// concurrently getting) a CJ order. The guard must trigger from the DB row
// alone, with no CJ network call in between.

const READY_ORDER_ROW = Object.freeze({
  order_number: 'AJ-DUP-1', items: [{ variant: AJLIB_VARIANT_KEYS[0], quantity: 2 }],
  shipping_street: '1 Test St', shipping_city: 'دبي', shipping_country_code: 'AE', shipping_country_name: 'الإمارات', shipping_region: 'دبي',
  shipping_address: 'x', shipping_postal_code: null, customer_name: 'x', customer_phone: '+971500000000', customer_email: 'x@x.com',
  product_amount: 10000, shipping_amount: 1000
});

test('a second prepareFulfillment call is blocked purely by the DB flag once the first attempt records fulfillment_external_order_id — no second network call is made', async () => {
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error('should not be called once already fulfilled'); };
  try {
    const alreadyFulfilledRow = { ...READY_ORDER_ROW, fulfillment_external_order_id: 'cj-order-123' };
    await assert.rejects(
      () => prepareFulfillment(alreadyFulfilledRow, { minAcceptableMarginPercent: 10, aedToUsdRate: 0.27 }),
      (err) => err instanceof FulfillmentBlockedError && err.reason === 'ALREADY_FULFILLED'
    );
    assert.equal(networkCalls, 0, 'ALREADY_FULFILLED must short-circuit before any CJ/cost/freight call');
  } finally { globalThis.fetch = originalFetch; }
});

test('two concurrent prepareFulfillment calls for the same not-yet-fulfilled order (the real duplicate-webhook race) still resolve to one identical CJ orderNumber, so even if both reached order creation CJ\'s own idempotency key would collapse them into one order', () => {
  // Both calls would see the SAME not-yet-fulfilled row (as two duplicate
  // webhook deliveries could, if they both read the DB before either write
  // lands) — the resulting payload orderNumber must be identical and
  // derived only from our own order_number, never from anything provider-
  // or timing-dependent (a random id, a timestamp, etc).
  const a = cjOrderNumberFor(READY_ORDER_ROW.order_number);
  const b = cjOrderNumberFor(READY_ORDER_ROW.order_number);
  assert.equal(a, b);
  assert.equal(a, 'AJLIB-AJ-DUP-1');
});

// ---- STRUCTURED shipping_city (both providers) -------------------------------
// The checkout form has always collected `city` as a required field; the gap
// was that neither payment path PERSISTED it as its own column — it was only
// interpolated into the flattened shipping_address string.

test('the Stripe checkout path sends city as its own metadata field, not only inside the flattened address', async () => {
  const source = await readFile(new URL('../api/checkout-session.js', import.meta.url), 'utf8');
  assert.ok(source.includes("'metadata[city]'"), 'Stripe metadata must carry a structured city');
});

test('the Tabby verify path normalizes city into the same metadata shape as Stripe', async () => {
  const source = await readFile(new URL('../api/commerce.js', import.meta.url), 'utf8');
  const start = source.indexOf('const normalized = {');
  const normalizedBlock = source.slice(start, source.indexOf('customer_details', start));
  assert.ok(/\bcity:\s*String\(validated\.customer\.city/.test(normalizedBlock), 'Tabby metadata must carry a structured city');
});

test('the single shared persistence path writes shipping_city for BOTH providers', async () => {
  const source = await readFile(new URL('../api/stripe-webhook.js', import.meta.url), 'utf8');
  assert.ok(/shipping_city:\s*trimmed\(metadata\.city\)/.test(source), 'saveOrder must persist the structured city');
  assert.ok(/shipping_street:\s*trimmed\(metadata\.street\)/.test(source), 'saveOrder must persist the structured street line');
  // saveOrder is the one function both providers go through (persistPaidOrder),
  // so neither path can drift from the other.
  assert.ok(source.includes('export const persistPaidOrder'));
});

test('a legacy order with no shipping_city is blocked from automatic fulfillment, never guessed from the address', async () => {
  const legacyOrder = {
    order_number: 'AJ-LEGACY-1',
    items: [{ variant: 'أسود-L', quantity: 5 }],
    shipping_address: '1 Test St, دبي, دبي, الإمارات, 00000', // city IS in here — must still not be used
    shipping_city: null,
    shipping_country_code: 'AE', product_amount: 11900, shipping_amount: 0
  };
  let cjCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { cjCalls += 1; throw new Error('no CJ call should happen for a legacy order'); };
  try {
    await assert.rejects(
      () => prepareFulfillment(legacyOrder),
      (err) => err instanceof FulfillmentBlockedError && err.reason === 'MISSING_SHIPPING_CITY'
    );
    assert.equal(cjCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('the CJ payload uses the STORED structured city, not anything parsed out of the address string', () => {
  const payload = buildCjOrderPayload({
    ajlibOrderNumber: 'AJ-1', resolvedItems: [{ cjVariantId: '1', quantity: 1 }],
    logisticName: 'CJPacket Eub', shippingCountryCode: 'AE',
    shippingCity: 'أبوظبي', shippingAddress: '1 Test St, دبي, الإمارات',
    shippingCustomerName: 'Test'
  });
  // The address string mentions دبي; the structured city is أبوظبي. The
  // payload must reflect the stored field, with no inference from the address.
  assert.equal(payload.shippingCity, 'أبوظبي');
});

// ---- CJ API FAILURES MUST NOT LOOK LIKE BUSINESS CONDITIONS ------------------
// Found live: CJ enforces "QPS limit is 1 time/1second" and reports it in the
// BODY with HTTP 200. Before this guard, a rate-limited freight call returned
// zero methods and was indistinguishable from a destination with no routes.

test('a rate-limited freight response raises a CJ API error, NOT "no logistics available"', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('getAccessToken')) return { ok: true, json: async () => ({ data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) };
      // Exactly what CJ really returns when the QPS limit is hit.
      return { ok: true, json: async () => ({ code: 1600200, message: 'Too Many Requests, QPS limit is 1 time/1second', result: false, data: null }) };
    };
    try {
      await assert.rejects(
        () => resolveFreightAndLogistics({ resolvedItems: [{ cjVariantId: '1', quantity: 5 }], destinationCountryCode: 'AE' }),
        (err) => {
          assert.equal(err.reason, 'CJ_FREIGHT_API_ERROR');
          assert.equal(err.details.rateLimited, true);
          return true;
        }
      );
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('a rate-limited cost lookup raises a CJ API error rather than reporting a missing cost', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('getAccessToken')) return { ok: true, json: async () => ({ data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) };
      return { ok: true, json: async () => ({ code: 1600200, message: 'Too Many Requests, QPS limit is 1 time/1second', result: false }) };
    };
    try {
      await assert.rejects(
        () => getCurrentCjProductCosts([{ cjVariantId: '1', quantity: 5 }]),
        (err) => err.reason === 'CJ_COST_API_ERROR'
      );
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('isCjErrorBody treats a CJ success envelope as success and any error code as failure', () => {
  assert.equal(isCjErrorBody({ code: 200, result: true, data: [] }), false);
  assert.equal(isCjErrorBody({ code: 1600200, result: false }), true);
  assert.equal(isCjErrorBody({ code: 1600101, message: 'Interface not found', result: false }), true);
});

test('consecutive CJ calls are spaced to respect the live 1 request/second QPS limit', async () => {
  assert.ok(CJ_MIN_REQUEST_GAP_MS >= 1000, 'gap must be at least CJ\'s documented 1s window');
  const started = [];
  const run = (n) => throttleCj(async () => { started.push({ n, at: Date.now() }); return n; });
  const results = await Promise.all([run(1), run(2)]);
  assert.deepEqual(results, [1, 2]);
  assert.ok(started[1].at - started[0].at >= CJ_MIN_REQUEST_GAP_MS - 50, 'second CJ call must not fire inside the QPS window');
});

// ---- BALANCE ENDPOINT CURRENTLY UNAVAILABLE ---------------------------------

test('CJ\'s real "Interface not found" balance response blocks fulfillment instead of assuming funds', () => {
  // Exactly what the live account returns today for GET /shopping/balance/getBalance.
  const realResponse = { code: 1600101, message: 'Interface not found', result: false, data: null };
  assert.equal(parseCjBalanceUSD(realResponse), null);
  const verdict = evaluateBalanceSufficiency({ balanceUSD: parseCjBalanceUSD(realResponse), requiredUSD: 21.57 });
  assert.equal(verdict.sufficient, false);
  assert.equal(verdict.reason, 'CJ_BALANCE_UNAVAILABLE');
});

test('prepareFulfillment refuses to run without an explicit delivery promise (an absent promise is not "any speed")', async () => {
  // Live AE data: the cheapest route is CJPacket Eub with 12-50 day aging,
  // so an unconstrained "cheapest" would auto-select a possibly 50-day
  // shipment against an intentionally strict 1-3 day test promise.
  await assert.rejects(
    () => prepareFulfillment({
      order_number: 'AJ-NOPROMISE', items: [{ variant: 'أسود-L', quantity: 5 }],
      customer_name: 'Test Buyer', customer_phone: '+971500000000', shipping_street: '1 Test St', shipping_city: 'دبي', shipping_country_code: 'AE', product_amount: 11900, shipping_amount: 0
    }),
    (err) => err instanceof FulfillmentBlockedError && err.reason === 'DELIVERY_PROMISE_NOT_CONFIGURED'
  );
});

test('with an explicit strict promise (max 3 days) no live CJ route qualifies — fulfillment blocks rather than over-promising', () => {
  // Exactly the live AE qty-5 method set, including real aging strings.
  const liveAeMethods = [
    { logisticName: 'CJPacket Eub', totalPostageFee: 10.52, logisticAging: '12-50' },
    { logisticName: 'CJPacket Eub Special Line', totalPostageFee: 12.46, logisticAging: '8-15' },
    { logisticName: 'CJPacket Liquid Line', totalPostageFee: 13.25, logisticAging: '7-10' },
    { logisticName: 'CJPacket Ordinary', totalPostageFee: 16.19, logisticAging: '7-11' },
    { logisticName: 'CJPacket Sensitive', totalPostageFee: 16.85, logisticAging: '7-11' },
    { logisticName: 'CJPacket Postal', totalPostageFee: 17.96, logisticAging: '12-50' },
    { logisticName: 'PostNL', totalPostageFee: 32.61, logisticAging: '15-45' },
    { logisticName: 'DHL Official', totalPostageFee: 118.44, logisticAging: '3-5' }
  ];
  const strict = selectLogisticsMethod(liveAeMethods, { countryCode: 'AE', maxDeliveryDays: 3 });
  assert.equal(strict.method, null);
  assert.equal(strict.reason, 'NO_METHOD_MEETS_DELIVERY_PROMISE');

  // If the promise were extended to 10 days, CJPacket Liquid Line becomes
  // the cheapest qualifying route — recorded here so the effect of that
  // (unapproved) commercial change is explicit rather than assumed.
  const relaxed = selectLogisticsMethod(liveAeMethods, { countryCode: 'AE', maxDeliveryDays: 10 });
  assert.equal(relaxed.method, 'CJPacket Liquid Line');
  assert.equal(relaxed.cost, 13.25);
});

// ---- MARGIN BAND (25% auto / 20-25% review / <20% block) --------------------

test('the configurable margin band thresholds match the approved commercial policy', () => {
  assert.equal(CJ_MARGIN_AUTO_PERCENT, 25);
  assert.equal(CJ_MARGIN_REVIEW_FLOOR_PERCENT, 20);
  assert.equal(CJ_MARGIN_TARGET_PERCENT, 30);
});

test('classifyMargin maps each band correctly, including the exact boundaries', () => {
  assert.equal(classifyMargin(30), 'GREEN');
  assert.equal(classifyMargin(25), 'GREEN');   // boundary is inclusive
  assert.equal(classifyMargin(24.99), 'REVIEW');
  assert.equal(classifyMargin(20), 'REVIEW');  // boundary is inclusive
  assert.equal(classifyMargin(19.99), 'BLOCK');
  assert.equal(classifyMargin(-5), 'BLOCK');
  assert.equal(classifyMargin(NaN), 'BLOCK');
});

test('a REVIEW-band order is never auto-fulfilled, and no escape hatch can approve it', () => {
  // ~22% true net margin.
  const review = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0,
    cjProductCostUSD: 11.05, cjShippingCostUSD: 13.25, unitCount: 5
  });
  assert.equal(review.band, 'REVIEW');
  assert.equal(review.approved, false, 'REVIEW must not auto-fulfill');
  assert.equal(review.reason, 'MARGIN_BELOW_25_PERCENT');

  // The former CJ_ALLOW_REVIEW_BAND_AUTOFULFILL escape hatch is gone: the
  // profit guard (>= 25% AND >= 30 AED) is the only way to approve.
  const allowed = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0,
    cjProductCostUSD: 11.05, cjShippingCostUSD: 13.25, unitCount: 5,
    allowReviewBandAutofulfill: true
  });
  assert.equal(allowed.band, 'REVIEW');
  assert.equal(allowed.approved, false);
});

// ---- TRUE VARIABLE COST (payment fee included) ------------------------------

test('the payment fee is a real variable cost and lowers reported margin vs product+freight alone', () => {
  const withFee = evaluateFulfillmentMargin({
    productAmountCollectedFils: 11900, shippingAmountCollectedFils: 0,
    cjProductCostUSD: 11.05, cjShippingCostUSD: 10.52, unitCount: 5
  });
  const productAndFreightOnly = 11.05 + 10.52;
  assert.ok(withFee.details.fulfillmentCostUSD > productAndFreightOnly, 'true cost must exceed product+freight');
  assert.ok(withFee.details.breakdown.paymentFeeUSD > 0);
});

test('Stripe fee follows the published UAE card rate (2.9% + AED 1.00), with the international surcharge applied only when relevant', () => {
  // 119 AED -> 2.9% + 1.00 = 4.451 AED
  const domestic = paymentFeeUSD({ amountCollectedFils: 11900, provider: 'stripe' });
  assert.ok(Math.abs(domestic - aedToUsd(4.451)) < 1e-9);
  const international = paymentFeeUSD({ amountCollectedFils: 11900, provider: 'stripe', international: true });
  assert.ok(international > domestic);
});

test('the unknown-payment-fee guard still exists, so an unconfigured rate could never be silently scored', async () => {
  // Tabby's UAE rate is now CONFIRMED (6.99% + AED 1.50), so this no longer
  // fires in practice — see tests/pricing-economics.test.mjs. The guard must
  // remain for any future provider whose rate is not yet known: an unknown
  // fee means the true cost is unknown, which must block rather than be
  // scored with a guessed number.
  const source = await readFile(new URL('../api/_lib/cj-fulfillment.js', import.meta.url), 'utf8');
  assert.ok(source.includes('PAYMENT_FEE_NOT_CONFIGURED'), 'the unknown-fee guard must not be deleted');
  assert.ok(/if \(feeUSD == null\)/.test(source), 'the null-fee branch must remain');
});

test('CJ platformPrice is still never part of the true variable cost', () => {
  const cost = computeTrueVariableCost({
    cjProductCostUSD: 11.05, cjShippingCostUSD: 10.52, unitCount: 5, amountCollectedFils: 11900
  });
  assert.equal(cost.breakdown.cjProductCostUSD, 11.05);
  assert.ok(!Object.keys(cost.breakdown).some(k => /platform/i.test(k)));
});

// ---- REVERSE PRICING SOLVER --------------------------------------------------

test('minimumRevenueAedForMargin solves for a price that actually yields the target margin', () => {
  const nonPayment = 11.05 + 13.25 + (0.02 * 5); // product + freight + sticker, USD
  for (const target of [20, 25, 30]) {
    const priceAed = minimumRevenueAedForMargin({ targetMarginPercent: target, nonPaymentVariableCostUSD: nonPayment });
    assert.ok(priceAed > 0);
    // Feed the solved price back through the real evaluator: it must land
    // on the target margin (within rounding).
    const check = evaluateFulfillmentMargin({
      productAmountCollectedFils: Math.round(priceAed * 100), shippingAmountCollectedFils: 0,
      cjProductCostUSD: 11.05, cjShippingCostUSD: 13.25, unitCount: 5
    });
    assert.ok(Math.abs(check.details.marginPercent - target) < 0.01, `target ${target}% -> got ${check.details.marginPercent}`);
  }
});

test('an unreachable margin target returns null rather than a nonsensical price', () => {
  // Once the target margin plus the fee rate reaches 100%, no price covers
  // the cost — the equation has no positive solution.
  assert.equal(minimumRevenueAedForMargin({ targetMarginPercent: 98, nonPaymentVariableCostUSD: 10 }), null);
  assert.equal(minimumRevenueAedForMargin({ targetMarginPercent: 120, nonPaymentVariableCostUSD: 10 }), null);
  // A normal target is reachable.
  assert.ok(minimumRevenueAedForMargin({ targetMarginPercent: 30, nonPaymentVariableCostUSD: 10 }) > 0);
});
