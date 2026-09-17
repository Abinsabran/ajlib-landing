import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFulfillmentVariants, getCurrentCjProductCosts, resolveFreightAndLogistics,
  evaluateFulfillmentMargin, alreadyHasFulfillmentOrder, cjOrderNumberFor, buildCjOrderPayload,
  prepareFulfillment, FulfillmentBlockedError
} from '../lib/cj-fulfillment.js';
import { selectLogisticsMethod, PREFERRED_LOGISTICS_ORDER } from '../lib/logistics-policy.js';
import { PROVIDER_STATUS_MAP, nextInternalStatusFromCjStatus, serializeOrderForCustomer } from '../lib/fulfillment-status.js';
import { AJLIB_VARIANT_KEYS } from '../lib/cj-variant-map.js';

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

test('logistics selection reports ONLY_METHOD_AVAILABLE when the sole option is not even in the preference list', () => {
  const result = selectLogisticsMethod([{ logisticName: 'Qfulfillment A line', logisticPrice: 24, totalPostageFee: 24 }], { countryCode: 'US' });
  assert.equal(result.method, 'Qfulfillment A line');
  assert.equal(result.reason, 'ONLY_METHOD_AVAILABLE');
});

test('logistics selection prefers a cheaper method when both a preferred and non-preferred option are available', () => {
  const availability = [
    { logisticName: 'DHL Official', logisticPrice: 118, totalPostageFee: 118 },
    { logisticName: 'CJPacket Postal', logisticPrice: 17, totalPostageFee: 17 }
  ];
  const result = selectLogisticsMethod(availability, { countryCode: 'AE' });
  assert.equal(result.method, 'CJPacket Postal');
  assert.equal(result.reason, 'PREFERRED_MATCH');
});

test('PREFERRED_LOGISTICS_ORDER never hardcodes a single "the" method — it is a preference list, not a fixed choice', () => {
  assert.ok(PREFERRED_LOGISTICS_ORDER.length > 1);
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
  assert.equal(result.reason, 'MARGIN_BELOW_THRESHOLD');
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
  assert.equal(payload.payType, 3); // "order only" — never triggers a CJ-side charge from this pipeline
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
  shipping_city: 'دبي', shipping_country_code: 'AE', shipping_country_name: 'الإمارات', shipping_region: 'دبي',
  shipping_address: 'x', shipping_postal_code: null, customer_name: 'x', customer_phone: 'x', customer_email: 'x@x.com',
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
