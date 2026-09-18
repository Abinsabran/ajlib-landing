import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AJLIB_VARIANT_KEYS, CJ_VARIANT_MAP, isFullyMapped, missingVariants, cjVariantFor } from '../api/_lib/cj-variant-map.js';
import { serializeOrderForCustomer } from '../api/_lib/fulfillment-status.js';

// Phase 2 requires: all 16 AJLIB variants mapped, no duplicates, no guessed
// mappings, and no CJ metadata ever reaching a customer-facing response.
// CJ_VARIANT_MAP is now populated from a confirmed, read-only
// GET /product/query?productSku=CJYD1589152 response (see the file header
// and the Phase 2 report for the Blue->Navy visual-confirmation note).

test('there are exactly 16 AJLIB sellable variant keys defined', () => {
  assert.equal(AJLIB_VARIANT_KEYS.length, 16);
  assert.equal(new Set(AJLIB_VARIANT_KEYS).size, 16, 'no duplicate AJLIB variant keys');
});

test('no duplicate ajlibKey entries in CJ_VARIANT_MAP', () => {
  const keys = CJ_VARIANT_MAP.map(v => v.ajlibKey);
  assert.equal(new Set(keys).size, keys.length);
});

test('no duplicate cjVariantId entries in CJ_VARIANT_MAP', () => {
  const ids = CJ_VARIANT_MAP.map(v => v.cjVariantId).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
});

test('every mapped entry uses one of the 16 known AJLIB variant keys (no stray/guessed keys)', () => {
  for (const entry of CJ_VARIANT_MAP) {
    assert.ok(AJLIB_VARIANT_KEYS.includes(entry.ajlibKey), `${entry.ajlibKey} is not a recognized AJLIB variant`);
  }
});

test('all 16 AJLIB variants are mapped — nothing missing', () => {
  assert.equal(isFullyMapped(), true);
  assert.deepEqual(missingVariants(), []);
});

test('every mapped entry has a non-empty CJ variant id and SKU (no placeholder/guessed values)', () => {
  for (const entry of CJ_VARIANT_MAP) {
    assert.ok(/^\d+$/.test(entry.cjVariantId), `${entry.ajlibKey} has a non-numeric/placeholder cjVariantId`);
    assert.ok(/^CJYD/.test(entry.cjVariantSku), `${entry.ajlibKey} has an unexpected cjVariantSku`);
  }
});

test('cjVariantFor resolves each of the 16 real AJLIB keys to its confirmed CJ variant', () => {
  for (const key of AJLIB_VARIANT_KEYS) {
    const entry = cjVariantFor(key);
    assert.ok(entry, `${key} did not resolve`);
    assert.equal(entry.ajlibKey, key);
  }
});

test('cjVariantFor returns null for an unrecognized key instead of guessing', () => {
  assert.equal(cjVariantFor('أحمر-M'), null); // "Red" isn't a real AJLIB color
});

test('CJ metadata never leaks through the customer-facing order serializer', () => {
  const order = {
    status: 'paid', order_number: 'AJ1', amount_total: 1000, currency: 'aed', items: [],
    cjVariantId: 'CJ-SHOULD-NOT-LEAK', cjVariantSku: 'CJ-SKU-SHOULD-NOT-LEAK', fulfillmentProvider: 'cj'
  };
  const serialized = serializeOrderForCustomer(order);
  for (const key of Object.keys(serialized)) {
    assert.ok(!key.toLowerCase().startsWith('cj'), `CJ field leaked: ${key}`);
  }
  assert.equal(JSON.stringify(serialized).includes('CJ-SHOULD-NOT-LEAK'), false);
});
