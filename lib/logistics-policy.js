// Deterministic, maintainable server-side logistics-selection policy.
//
// Confirmed via live CJ freightCalculate testing: the set of available
// logistics methods varies per destination AND per quantity for the SAME
// product — CJPacket Postal disappears at qty>=15 everywhere, and Oman
// drops to DHL-only at higher quantities. Selection is therefore ALWAYS
// computed per-order from CJ's real, current availability; nothing is
// hardcoded, and this module only ever picks among methods CJ itself
// reports for THIS order's exact vids/quantities/destination.
//
// APPROVED POLICY: choose the cheapest appropriate standard method that is
// actually available and satisfies AJLIB's delivery promise. If only one
// valid route exists, use it. DHL may be selected automatically when it is
// the only/cheapest valid route (e.g. large Oman orders). Customer-facing
// shipping prices are NOT affected by anything here — see
// api/shipping-quote.js, unchanged.

// Approved commercial margin BAND, on TRUE net margin (see
// cj-fulfillment.js evaluateFulfillmentMargin — CJ product + CJ freight +
// customization + payment-processing fee + any other known per-order
// variable cost). All configurable server-side.
//
//   >= CJ_MARGIN_AUTO_PERCENT   (25) -> GREEN  : auto-fulfill
//   >= CJ_MARGIN_REVIEW_FLOOR   (20) -> REVIEW : hold for a human
//   <  CJ_MARGIN_REVIEW_FLOOR   (20) -> BLOCK  : never auto-fulfill
//
// CJ_MARGIN_TARGET_PERCENT (30) is the aspirational target used for pricing
// analysis; it does not gate fulfillment.
export const CJ_MARGIN_AUTO_PERCENT = Number(process.env.CJ_MARGIN_AUTO_PERCENT ?? 25);
export const CJ_MARGIN_REVIEW_FLOOR_PERCENT = Number(process.env.CJ_MARGIN_REVIEW_FLOOR_PERCENT ?? 20);
export const CJ_MARGIN_TARGET_PERCENT = Number(process.env.CJ_MARGIN_TARGET_PERCENT ?? 30);

// A REVIEW-band order is held, never auto-fulfilled, unless this is
// explicitly turned on later. Default off, per the approved policy
// ("do not auto-fulfill unless an explicit configurable policy later
// allows it").
export const CJ_ALLOW_REVIEW_BAND_AUTOFULFILL = process.env.CJ_ALLOW_REVIEW_BAND_AUTOFULFILL === 'true';

// Retained name for the hard floor below which fulfillment is blocked.
export const MIN_ACCEPTABLE_MARGIN_PERCENT = CJ_MARGIN_REVIEW_FLOOR_PERCENT;

// ---- Per-order variable costs beyond CJ product + freight -------------------
// Stripe's published UAE card pricing (stripe.com/ae/pricing): 2.9% +
// AED 1.00 per successful domestic transaction, +1% for international
// cards, +1% where currency conversion is required. AJLIB settles in AED,
// so the domestic rate is the default; STRIPE_INTERNATIONAL_SURCHARGE_PERCENT
// covers non-UAE cards.
export const STRIPE_FEE_PERCENT = Number(process.env.STRIPE_FEE_PERCENT ?? 2.9);
export const STRIPE_FEE_FIXED_AED = Number(process.env.STRIPE_FEE_FIXED_AED ?? 1.0);
export const STRIPE_INTERNATIONAL_SURCHARGE_PERCENT = Number(process.env.STRIPE_INTERNATIONAL_SURCHARGE_PERCENT ?? 1.0);

// Tabby's merchant discount rate is commercially negotiated and is NOT
// published — it is materially higher than card processing. Left null on
// purpose: an unset fee is "cannot evaluate", so a Tabby order cannot be
// margin-approved until the real rate is entered here. Never guessed.
export const TABBY_FEE_PERCENT = process.env.TABBY_FEE_PERCENT != null ? Number(process.env.TABBY_FEE_PERCENT) : null;

// Per-unit cost of CJ's packaging/sticker/customization service, if AJLIB's
// configured service carries one. The packaging configuration itself is
// never read or modified by this codebase. Default 0 = "no known additional
// cost"; set it if the service is billed per unit.
export const CJ_CUSTOMIZATION_COST_USD_PER_UNIT = Number(process.env.CJ_CUSTOMIZATION_COST_USD_PER_UNIT ?? 0);

// Any other known flat per-order variable fulfillment cost.
export const OTHER_VARIABLE_COST_USD_PER_ORDER = Number(process.env.OTHER_VARIABLE_COST_USD_PER_ORDER ?? 0);

// Approved customer-facing delivery window. Delivery speed is secondary to
// margin, but a route must still land inside the promise AJLIB publishes.
export const DELIVERY_PROMISE_MIN_DAYS = Number(process.env.DELIVERY_PROMISE_MIN_DAYS ?? 7);
export const DELIVERY_PROMISE_MAX_DAYS = Number(process.env.DELIVERY_PROMISE_MAX_DAYS ?? 14);

export const MARGIN_BANDS = Object.freeze({ GREEN: 'GREEN', REVIEW: 'REVIEW', BLOCK: 'BLOCK' });

export const classifyMargin = (marginPercent) => {
  if (!Number.isFinite(Number(marginPercent))) return MARGIN_BANDS.BLOCK;
  if (marginPercent >= CJ_MARGIN_AUTO_PERCENT) return MARGIN_BANDS.GREEN;
  if (marginPercent >= CJ_MARGIN_REVIEW_FLOOR_PERCENT) return MARGIN_BANDS.REVIEW;
  return MARGIN_BANDS.BLOCK;
};

// Approved CJ Balance operating model. Target operating balance is
// ~1000-1500 AED equivalent; warn below ~500 AED. Automatic top-up is
// deliberately NOT implemented. Thresholds are AED because that is how the
// business holds them; comparison against CJ's USD payable happens in
// cj-fulfillment.js using the existing AED_EXCHANGE_RATES table.
export const CJ_BALANCE_LOW_WARNING_AED = Number(process.env.CJ_BALANCE_LOW_WARNING_AED ?? 500);
export const CJ_BALANCE_TARGET_MIN_AED = 1000;
export const CJ_BALANCE_TARGET_MAX_AED = 1500;

// Methods that are not "standard" fulfillment routes for AJLIB's product
// and must never be auto-selected. Empty: every method CJ has actually
// returned for this product so far (CJPacket family, PostNL, DHL Official)
// is a legitimate standard route. Add here if CJ starts returning
// pickup-only or freight-forwarder options.
export const EXCLUDED_LOGISTICS_METHODS = Object.freeze([]);

// Per-market overrides (force a method, or cap delivery days differently).
// Empty — no market-specific rule has been approved.
export const MARKET_OVERRIDES = Object.freeze({});

const costOf = (method) => Number(method.totalPostageFee ?? method.logisticPrice);

// CJ returns delivery aging as a string like "7-12" or "10" (days). Parses
// the UPPER bound, since that is what a delivery promise must be judged
// against. Returns null when CJ gives nothing parseable — which is treated
// as "unknown", never as "fast enough".
export const maxAgingDays = (method) => {
  const raw = String(method.logisticAging ?? '').trim();
  const numbers = raw.match(/\d+/g);
  if (!numbers || numbers.length === 0) return null;
  return Math.max(...numbers.map(Number));
};

// availableMethods: the real `data` array from a live freightCalculate
// response — [{logisticName, logisticPrice, logisticAging, totalPostageFee}].
// maxDeliveryDays: AJLIB's existing promise for this destination (the
// shipping zone's max_days). When supplied, a method must meet it to be
// selectable; methods with unknown aging are not assumed to comply.
// Returns { method, cost, agingDays, reason } or { method: null, reason }.
export const selectLogisticsMethod = (availableMethods, { countryCode, maxDeliveryDays } = {}) => {
  if (!Array.isArray(availableMethods) || availableMethods.length === 0) {
    return { method: null, cost: null, agingDays: null, reason: 'NO_METHODS_AVAILABLE' };
  }

  const override = MARKET_OVERRIDES[countryCode];
  const excluded = override?.excludedMethods ?? EXCLUDED_LOGISTICS_METHODS;
  const standard = availableMethods.filter(m => !excluded.includes(m.logisticName));
  if (standard.length === 0) {
    return { method: null, cost: null, agingDays: null, reason: 'NO_STANDARD_METHOD_AVAILABLE' };
  }

  const cheapestFirst = [...standard].sort((a, b) => costOf(a) - costOf(b));
  const promiseDays = override?.maxDeliveryDays ?? maxDeliveryDays;

  // No promise supplied by the caller: cheapest available standard route.
  if (promiseDays == null) {
    const pick = cheapestFirst[0];
    return {
      method: pick.logisticName, cost: costOf(pick), agingDays: maxAgingDays(pick),
      reason: standard.length === 1 ? 'ONLY_METHOD_AVAILABLE' : 'CHEAPEST_AVAILABLE'
    };
  }

  const meetsPromise = cheapestFirst.filter(m => {
    const aging = maxAgingDays(m);
    return aging != null && aging <= promiseDays;
  });

  if (meetsPromise.length === 0) {
    // Deliberately blocks instead of silently shipping a route that breaks
    // the published delivery promise, and instead of silently "fixing" the
    // promise. The caller reports this for a human decision — the fastest
    // real option is returned purely as context, NOT as a selection.
    const fastest = [...standard].sort((a, b) => (maxAgingDays(a) ?? Infinity) - (maxAgingDays(b) ?? Infinity))[0];
    return {
      method: null, cost: null, agingDays: null,
      reason: 'NO_METHOD_MEETS_DELIVERY_PROMISE',
      promiseDays,
      fastestAvailable: { method: fastest.logisticName, cost: costOf(fastest), agingDays: maxAgingDays(fastest) }
    };
  }

  const pick = meetsPromise[0];
  return {
    method: pick.logisticName, cost: costOf(pick), agingDays: maxAgingDays(pick),
    reason: meetsPromise.length === 1 ? 'ONLY_METHOD_MEETS_PROMISE' : 'CHEAPEST_MEETING_PROMISE'
  };
};
