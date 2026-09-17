// Single source of truth for AJLIB product pricing, extracted verbatim from the
// formula previously inlined in api/checkout-session.js so api/order-quote.js
// can reuse it without duplicating (or drifting from) the real business logic.
// APPROVED: AJLIB's launch minimum order quantity is 5 units. Enforced here
// once and consumed everywhere — lib/order-validation.js (used by BOTH the
// Stripe and Tabby checkout paths) and api/commerce.js's order-quote all
// read these constants rather than repeating a literal, so the storefront,
// the quote API and checkout cannot disagree about the minimum.
export const MIN_QUANTITY = 5;
export const MAX_QUANTITY = 100;

// APPROVED UAE launch pricing. Every tier was validated against real current
// CJ costs (cjPrice $2.21/unit plus live freight for the route that actually
// satisfies the 7-14 day promise), the $0.02/unit sticker, and both payment
// providers' real fees — all five clear 25% TRUE net margin on Stripe AND
// Tabby. tests/pricing-economics.test.mjs fails if any tier stops clearing it.
//
// The old 25 AED/unit sub-5 rate is GONE: it sat below the 5-pack's 27.00,
// which inverted the discount and produced negative savings badges, and it
// was never margin-checked against single-unit freight. With a 5-unit
// minimum there is no sub-5 tier to price, so the 5-piece rate is the floor.
export const computeUnitPrice = (quantity) => (
  quantity >= 50 ? 1249 / 50
    : quantity >= 20 ? 519 / 20
    : quantity >= 15 ? 399 / 15
    : quantity >= 10 ? 269 / 10
    : 135 / 5
);

// The 5-piece per-unit rate — the internal baseline that optional savings
// percentages are measured against. Derived from the ladder above, never a
// separate hardcoded anchor, so it cannot drift from the real entry price.
export const BASELINE_UNIT_PRICE = computeUnitPrice(MIN_QUANTITY);

// Savings vs the 5-piece baseline, as a whole percent. Returns 0 unless the
// REAL saving is at least 1% — the threshold is applied to the exact value
// before rounding, so a 0.6% saving reports 0 rather than rounding up into
// a "1%" claim. Callers can therefore never render a negative, zero, or
// overstated badge.
export const MIN_DISPLAYABLE_SAVINGS_PERCENT = 1;

export const computeSavingsPercent = (quantity) => {
  const saving = (1 - computeUnitPrice(quantity) / BASELINE_UNIT_PRICE) * 100;
  return saving >= MIN_DISPLAYABLE_SAVINGS_PERCENT ? Math.round(saving) : 0;
};

export const computeProductPricing = (quantity) => {
  const unitPrice = computeUnitPrice(quantity);
  const productAmount = Math.round(quantity * unitPrice * 100);
  return { unitPrice, productAmount };
};
