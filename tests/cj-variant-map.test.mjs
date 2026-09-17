import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AJLIB_VARIANT_KEYS, CJ_VARIANT_MAP, isFullyMapped, missingVariants, cjVariantFor } from '../lib/cj-variant-map.js';
import { serializeOrderForCustomer } from '../lib/fulfillment-status.js';

// Phase 2 requires: all 16 AJLIB variants mapped, no duplicates, no guessed
// mappings, and no CJ metadata ever reaching a customer-facing response.
// As of this commit, CJ_VARIANT_MAP is intentionally EMPTY — the read-only
// discovery diagnostic (api/commerce.js, resource=cj-diagnostic) has not yet
// returned confirmed CJ variant data (see the Phase 2 report for why). This
// test suite locks in the STRUCTURAL guarantees (no duplicates, no unknown
// keys, no leakage) that must hold both now and once real data lands, and
// documents exactly what's missing rather than asserting a false "done".

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

test('missingVariants() accurately reflects what has not been confirmed yet', () => {
  const missing = missingVariants();
  assert.equal(missing.length, AJLIB_VARIANT_KEYS.length - CJ_VARIANT_MAP.length);
  for (const key of missing) assert.ok(AJLIB_VARIANT_KEYS.includes(key));
});

test('cjVariantFor returns null instead of a guess for an unmapped variant', () => {
  if (isFullyMapped()) return; // nothing left to check once fully populated
  const [unmapped] = missingVariants();
  assert.equal(cjVariantFor(unmapped), null);
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
