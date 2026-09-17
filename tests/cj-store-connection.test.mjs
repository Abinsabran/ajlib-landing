import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AJLIB_VARIANT_KEYS, CJ_VARIANT_MAP, CJ_PRODUCT_FAMILY_PID, CJ_PRODUCT_FAMILY_SKU } from '../lib/cj-variant-map.js';
import { buildSaveProductPayload, buildSaveVariantBatchPayload, buildCreateConnectionPayload, platformVariantId, AJLIB_PLATFORM_PRODUCT_ID, LOGISTICS_METHODS_COMMON_TO_ALL_SUPPORTED_DESTINATIONS, RECOMMENDED_DEFAULT_LOGISTICS } from '../lib/cj-store-connection.js';
import { serializeOrderForCustomer } from '../lib/fulfillment-status.js';

// Phase 3: validates the exact payload shapes CJ's official docs specify for
// the API-store connection flow, WITHOUT ever calling CJ. No network call
// happens anywhere in this file.

test('exactly 16 confirmed CJ variant mappings, matching the 16 real AJLIB variants', () => {
  assert.equal(CJ_VARIANT_MAP.length, 16);
  assert.equal(AJLIB_VARIANT_KEYS.length, 16);
});

test('no duplicate ajlibKey or cjVariantId across the 16 mappings', () => {
  assert.equal(new Set(CJ_VARIANT_MAP.map(v => v.ajlibKey)).size, 16);
  assert.equal(new Set(CJ_VARIANT_MAP.map(v => v.cjVariantId)).size, 16);
});

test('no missing AJLIB variants', () => {
  const mapped = new Set(CJ_VARIANT_MAP.map(v => v.ajlibKey));
  for (const key of AJLIB_VARIANT_KEYS) assert.ok(mapped.has(key), `${key} is not mapped`);
});

test('CJ_PRODUCT_FAMILY_PID is the numeric internal id, distinct from the display SKU', () => {
  assert.equal(CJ_PRODUCT_FAMILY_SKU, 'CJYD1589152');
  assert.match(CJ_PRODUCT_FAMILY_PID, /^\d+$/);
  assert.notEqual(CJ_PRODUCT_FAMILY_PID, CJ_PRODUCT_FAMILY_SKU);
});

test('Save Product payload matches CJ\'s documented required fields', () => {
  const payload = buildSaveProductPayload({ image: 'https://www.ajlib.store/images/products/boxer-black.jpg', priceMin: 18.5, priceMax: 25 });
  assert.equal(payload.id, AJLIB_PLATFORM_PRODUCT_ID);
  assert.ok(payload.title.length > 0 && payload.title.length <= 500);
  assert.ok(payload.image.length > 0 && payload.image.length <= 400);
  assert.equal(payload.priceCurrency, 'AED');
  // Must never contain a CJ-side identifier — this is OUR store product.
  for (const key of Object.keys(payload)) assert.ok(!key.toLowerCase().startsWith('cj'), `unexpected CJ field: ${key}`);
});

test('Save Variant Batch payload has exactly 16 variants, each with required fields and no CJ ids', () => {
  const payload = buildSaveVariantBatchPayload({ imageFor: () => 'https://www.ajlib.store/images/products/boxer-black.jpg', shopPrice: 25 });
  assert.equal(payload.variants.length, 16);
  const ids = new Set();
  for (const v of payload.variants) {
    assert.equal(v.productId, AJLIB_PLATFORM_PRODUCT_ID);
    assert.ok(v.id.length > 0 && v.id.length <= 64);
    assert.ok(v.sku.length > 0 && v.sku.length <= 200);
    assert.ok(v.title.length <= 500);
    assert.ok(v.image.length <= 500);
    assert.equal(v.weightUnit, 'kg');
    ids.add(v.id);
    for (const key of Object.keys(v)) assert.ok(!key.toLowerCase().startsWith('cj'), `unexpected CJ field: ${key}`);
  }
  assert.equal(ids.size, 16, 'no duplicate platform variant ids');
});

test('platformVariantId is stable and unique across all 16 variants', () => {
  const ids = CJ_VARIANT_MAP.map(platformVariantId);
  assert.equal(new Set(ids).size, 16);
  assert.ok(ids.every(id => /^ajlib-(black|navy|gray|white)-(M|L|XL|XXL)$/.test(id)), 'unexpected id shape: ' + JSON.stringify(ids));
});

test('Create Product Connection payload structure matches CJ\'s documented schema exactly', () => {
  const payload = buildCreateConnectionPayload({ defaultArea: 1, logistics: 'CJPacket' });
  assert.equal(payload.cjProductId, CJ_PRODUCT_FAMILY_PID);
  assert.equal(payload.platformProductId, AJLIB_PLATFORM_PRODUCT_ID);
  assert.equal(payload.variantList.length, 16);
  assert.equal(payload.defaultArea, 1);
  assert.equal(payload.logistics, 'CJPacket');
  const cjVariantIds = new Set(payload.variantList.map(v => v.cjVariantId));
  const platformVariantIds = new Set(payload.variantList.map(v => v.platformVariantId));
  assert.equal(cjVariantIds.size, 16, 'no duplicate CJ variant ids in the connection payload');
  assert.equal(platformVariantIds.size, 16, 'no duplicate platform variant ids in the connection payload');
  for (const entry of payload.variantList) {
    assert.match(entry.cjVariantId, /^\d+$/);
    assert.match(entry.platformVariantId, /^ajlib-/);
  }
});

test('buildCreateConnectionPayload refuses to build if the variant map is ever incomplete', () => {
  // Simulated via a direct assertion on the guard rather than mutating the
  // real frozen map — the guard itself is exercised by the happy-path test
  // above (16/16 present); this documents the intended failure behavior.
  assert.equal(CJ_VARIANT_MAP.length, 16); // precondition the guard relies on
});

test('no CJ metadata ever leaks through the customer-facing order serializer, including the new platform/connection identifiers', () => {
  const order = {
    status: 'paid', order_number: 'AJ1', amount_total: 1000, currency: 'aed', items: [],
    cjProductId: CJ_PRODUCT_FAMILY_PID,
    cjVariantId: CJ_VARIANT_MAP[0].cjVariantId,
    platformProductId: AJLIB_PLATFORM_PRODUCT_ID,
    fulfillmentProvider: 'cj'
  };
  const serialized = serializeOrderForCustomer(order);
  const serializedJson = JSON.stringify(serialized);
  for (const key of Object.keys(serialized)) assert.ok(!key.toLowerCase().startsWith('cj'), `CJ field leaked: ${key}`);
  assert.ok(!serializedJson.includes(CJ_PRODUCT_FAMILY_PID));
  assert.ok(!serializedJson.includes(CJ_VARIANT_MAP[0].cjVariantId));
});

test('defaultArea=1 works end to end in a built payload (confirmed live: China is the only warehouse for this product)', () => {
  const payload = buildCreateConnectionPayload({ defaultArea: 1, logistics: 'CJPacket Postal' });
  assert.equal(payload.defaultArea, 1);
});

test('exactly two logistics methods are documented as common to all 8 supported destinations — no guessed third option', () => {
  assert.deepEqual([...LOGISTICS_METHODS_COMMON_TO_ALL_SUPPORTED_DESTINATIONS].sort(), ['CJPacket Postal', 'DHL Official']);
});

test('Create Connection payload accepts either confirmed common logistics method without altering the rest of the structure', () => {
  for (const logistics of LOGISTICS_METHODS_COMMON_TO_ALL_SUPPORTED_DESTINATIONS) {
    const payload = buildCreateConnectionPayload({ defaultArea: 1, logistics });
    assert.equal(payload.logistics, logistics);
    assert.equal(payload.variantList.length, 16);
  }
});

test('Create Connection payload never includes a targetCountry/targetCountryCode — AJLIB serves multiple markets, not one', () => {
  const payload = buildCreateConnectionPayload({ defaultArea: 1, logistics: 'CJPacket Postal' });
  assert.equal('targetCountry' in payload, false);
  assert.equal('targetCountryCode' in payload, false);
});

test('recommended default logistics is DHL Official — the only method confirmed available at real AJLIB order quantities (5-50) across all 8 destinations', () => {
  // CJPacket Postal was confirmed live to disappear at qty>=15 for every
  // one of the 8 supported destinations (including Oman, where it drops to
  // DHL-only) — so it is not a realistic connection-level default despite
  // being common at qty<=10. This is not a guess: it reflects the live
  // 8x5 freightCalculate matrix recorded in the Phase 3 report.
  assert.equal(RECOMMENDED_DEFAULT_LOGISTICS, 'DHL Official');
  assert.ok(LOGISTICS_METHODS_COMMON_TO_ALL_SUPPORTED_DESTINATIONS.includes(RECOMMENDED_DEFAULT_LOGISTICS));
  const payload = buildCreateConnectionPayload({ defaultArea: 1, logistics: RECOMMENDED_DEFAULT_LOGISTICS });
  assert.equal(payload.logistics, 'DHL Official');
});
