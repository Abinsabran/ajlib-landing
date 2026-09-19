// AJLIB's customer-facing shipping fees — APPROVED 2026-09-18.
//
// These are commercial fees the customer pays, in AED fils, by destination
// group and quantity bracket. They are NOT CJ's freight: fulfillment still
// prices every order against CJ's live freight and route, and the profit
// guard (api/_lib/cj-fulfillment.js) protects the order if CJ costs move.
//
// Custom quantities use the same brackets as the product price ladder
// (api/_lib/pricing.js): the fee of the largest anchor at or below the
// quantity, so 12 pieces ship at the 10-piece fee, 60 at the 50-piece fee.
// Enforced server-side only; clients display what the quote API returns.
import { isShippingCountry } from './markets.js';

export const SHIPPING_ANCHORS = Object.freeze([5, 10, 15, 20, 50]);

// Fee in AED fils per anchor, in SHIPPING_ANCHORS order.
export const SHIPPING_LADDERS = Object.freeze({
  UAE: Object.freeze([0, 0, 0, 0, 0]),
  GCC: Object.freeze([5000, 4000, 3000, 2000, 1000]),
  INTL: Object.freeze([2500, 2000, 1500, 1000, 500])
});

export const SHIPPING_GROUP_BY_COUNTRY = Object.freeze({
  AE: 'UAE',
  SA: 'GCC', KW: 'GCC', QA: 'GCC', BH: 'GCC',
  US: 'INTL', AU: 'INTL'
});

// The bracket a quantity falls in: the largest anchor <= quantity.
export const shippingAnchorFor = (quantity) => {
  const q = Number(quantity);
  if (!Number.isInteger(q) || q < SHIPPING_ANCHORS[0]) return null;
  return [...SHIPPING_ANCHORS].reverse().find(anchor => q >= anchor);
};

// Customer shipping fee in AED fils, or null when the country is not an
// approved market or the quantity is not a valid whole number >= 5.
export const shippingFeeFils = (countryCode, quantity) => {
  const code = String(countryCode ?? '').trim().toUpperCase();
  if (!isShippingCountry(code)) return null;
  const anchor = shippingAnchorFor(quantity);
  if (anchor == null) return null;
  return SHIPPING_LADDERS[SHIPPING_GROUP_BY_COUNTRY[code]][SHIPPING_ANCHORS.indexOf(anchor)];
};
