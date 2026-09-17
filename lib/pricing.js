// Single source of truth for AJLIB product pricing, extracted verbatim from the
// formula previously inlined in api/checkout-session.js so api/order-quote.js
// can reuse it without duplicating (or drifting from) the real business logic.
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 100;

// APPROVED UAE launch pricing. Every tier was validated against real current
// CJ costs (cjPrice $2.21/unit plus live freight for the route that actually
// satisfies the 7-14 day promise), the $0.02/unit sticker, and both payment
// providers' real fees — all five clear 25% TRUE net margin on Stripe AND
// Tabby. tests/pricing-economics.test.mjs fails if any tier stops clearing it.
//
// NOTE: the sub-5 price of 25 AED/unit is UNCHANGED and was not part of the
// approved tiers. It is now cheaper per unit than the 5-pack (27.00) — an
// inverted discount at that boundary — and has never been margin-checked
// against single-unit freight. Flagged for a separate decision rather than
// silently repriced here.
export const computeUnitPrice = (quantity) => (
  quantity >= 50 ? 1249 / 50
    : quantity >= 20 ? 519 / 20
    : quantity >= 15 ? 399 / 15
    : quantity >= 10 ? 269 / 10
    : quantity >= 5 ? 135 / 5
    : 25
);

export const computeProductPricing = (quantity) => {
  const unitPrice = computeUnitPrice(quantity);
  const productAmount = Math.round(quantity * unitPrice * 100);
  return { unitPrice, productAmount };
};
