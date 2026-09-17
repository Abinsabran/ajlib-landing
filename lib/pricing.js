// Single source of truth for AJLIB product pricing, extracted verbatim from the
// formula previously inlined in api/checkout-session.js so api/order-quote.js
// can reuse it without duplicating (or drifting from) the real business logic.
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 100;

export const computeUnitPrice = (quantity) => (
  quantity >= 50 ? 18.5
    : quantity >= 20 ? 389 / 20
    : quantity >= 15 ? 309 / 15
    : quantity >= 10 ? 219 / 10
    : quantity >= 5 ? 119 / 5
    : 25
);

export const computeProductPricing = (quantity) => {
  const unitPrice = computeUnitPrice(quantity);
  const productAmount = Math.round(quantity * unitPrice * 100);
  return { unitPrice, productAmount };
};
