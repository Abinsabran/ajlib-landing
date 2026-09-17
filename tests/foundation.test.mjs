import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProductPricing, MIN_QUANTITY, MAX_QUANTITY } from '../lib/pricing.js';
import { allVariants, PRODUCTS, COLORS, SIZES } from '../lib/catalog.js';
import { COUNTRY_CURRENCY, currencyForCountry, convertAedFilsForDisplay } from '../lib/currency.js';
import { customerStatusFor, serializeOrderForCustomer, CUSTOMER_STATUS } from '../lib/fulfillment-status.js';

// PRICING — must keep matching the live checkout-session.js formula exactly
// (119/219/309/389 AED at 5/10/15/20, converging to 18.50/unit at 50+).
test('pricing: matches the current live tiers exactly', () => {
  assert.equal(computeProductPricing(5).productAmount, 11900);
  assert.equal(computeProductPricing(10).productAmount, 21900);
  assert.equal(computeProductPricing(15).productAmount, 30900);
  assert.equal(computeProductPricing(20).productAmount, 38900);
  assert.equal(computeProductPricing(50).productAmount, 92500);
  assert.equal(computeProductPricing(1).productAmount, 2500);
});

test('pricing: unit price converges to 18.50 at and above 50', () => {
  assert.equal(computeProductPricing(50).unitPrice, 18.5);
  assert.equal(computeProductPricing(MAX_QUANTITY).unitPrice, 18.5);
});

test('pricing: quantity bounds match the server-enforced range (1-100)', () => {
  assert.equal(MIN_QUANTITY, 1);
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
