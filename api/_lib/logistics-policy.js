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

// PROFIT GUARD — APPROVED 2026-09-18. A CJ order is auto-created only when
// BOTH hold on the order's TRUE live economics (live CJ product cost + live
// CJ freight + sticker + actual payment fee + other known variable cost),
// in canonical AED:
//   true net margin >= 25%   else MARGIN_BELOW_25_PERCENT
//   true net profit >= 30 AED else NET_PROFIT_BELOW_30_AED
// Anything else goes to REVIEW_REQUIRED with that reason and alerts the
// owner. Fixed constants, not env-tunable, so the policy cannot drift; the
// REVIEW band above is informational only and never approves on its own.
export const PROFIT_GUARD_MIN_MARGIN_PERCENT = 25;
export const PROFIT_GUARD_MIN_NET_PROFIT_AED = 30;

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
// The "+1% where currency conversion is required" above: applies when the
// customer paid in USD, since AJLIB settles in AED.
export const STRIPE_CURRENCY_CONVERSION_PERCENT = Number(process.env.STRIPE_CURRENCY_CONVERSION_PERCENT ?? 1.0);

// Tabby's UAE merchant rate, CONFIRMED for AJLIB: 6.99% + AED 1.50 per
// transaction. Materially higher than card processing, which is why Tabby
// margin is scored separately rather than assumed equal to Stripe.
export const TABBY_FEE_PERCENT = Number(process.env.TABBY_FEE_PERCENT ?? 6.99);
export const TABBY_FEE_FIXED_AED = Number(process.env.TABBY_FEE_FIXED_AED ?? 1.5);

// AJLIB custom sticker, CONFIRMED: $0.02 USD per unit, exactly one sticker
// per boxer — so this scales with quantity, not per order. The CJ packaging
// configuration itself is never read or modified by this codebase.
export const CJ_CUSTOMIZATION_COST_USD_PER_UNIT = Number(process.env.CJ_CUSTOMIZATION_COST_USD_PER_UNIT ?? 0.02);

// Any other known flat per-order variable fulfillment cost.
export const OTHER_VARIABLE_COST_USD_PER_ORDER = Number(process.env.OTHER_VARIABLE_COST_USD_PER_ORDER ?? 0);

// Approved customer-facing delivery window. Delivery speed is secondary to
// margin, but a route must still land inside the promise AJLIB publishes.
// APPROVED customer-facing window: approximately 7-14 business days.
// NOTE: CJ's logisticAging is expressed in days without specifying
// business vs calendar. The filter below compares CJ aging against 14
// directly, which is the conservative reading (treating CJ's number as
// calendar days against a business-day promise leaves slack, not deficit).
export const DELIVERY_PROMISE_MIN_DAYS = Number(process.env.DELIVERY_PROMISE_MIN_DAYS ?? 7);
export const DELIVERY_PROMISE_MAX_DAYS = Number(process.env.DELIVERY_PROMISE_MAX_DAYS ?? 14);

export const MARGIN_BANDS = Object.freeze({ GREEN: 'GREEN', REVIEW: 'REVIEW', BLOCK: 'BLOCK' });

export const classifyMargin = (marginPercent) => {
  if (!Number.isFinite(Number(marginPercent))) return MARGIN_BANDS.BLOCK;
  if (marginPercent >= CJ_MARGIN_AUTO_PERCENT) return MARGIN_BANDS.GREEN;
  if (marginPercent >= CJ_MARGIN_REVIEW_FLOOR_PERCENT) return MARGIN_BANDS.REVIEW;
  return MARGIN_BANDS.BLOCK;
};

// Approved CJ Balance operating model (launch): controlled funding of
// ~300-500 AED equivalent, warn when the balance LEFT after an order would
// fall below 150 AED. The warning never blocks an affordable order; only an
// insufficient balance blocks. Automatic top-up is deliberately NOT
// implemented. Thresholds are AED because that is how the business holds
// them; comparison against CJ's USD payable happens in cj-fulfillment.js
// using the existing AED_EXCHANGE_RATES table.
export const CJ_BALANCE_LOW_WARNING_AED = Number(process.env.CJ_BALANCE_LOW_WARNING_AED ?? 150);
export const CJ_BALANCE_TARGET_MIN_AED = 300;
export const CJ_BALANCE_TARGET_MAX_AED = 500;

// Methods that must never be auto-selected, by EXACT name only. Empty: every
// route CJ's live freight API returns for AJLIB's exact product, quantity and
// destination is treated as valid for it. Routes are deliberately NOT
// rejected by words in their name (e.g. CJPacket Liquid Line is a real,
// cheapest-compliant UAE route for this product — approved 2026-09-18 to stay
// eligible). Add an exact name here only for a specific, approved reason.
export const EXCLUDED_LOGISTICS_METHODS = Object.freeze([]);
export const isExcludedLogisticsMethod = (name, exactList = EXCLUDED_LOGISTICS_METHODS) => exactList.includes(name);

// Per-market overrides: excludedMethods, maxDeliveryDays, and
// preferredMethods (tried first, in order, when available and inside the
// delivery promise; the cheapest route meeting the promise stays the
// fallback, and cj-fulfillment.js falls back to it if the preferred route
// would miss the margin band).
//
// US: YunExpress Ordinary, approved 2026-09-18 for the first controlled US
// order — live quote 4-7 days vs LuWei Ordinary US 5-11 days for ~$1.70
// more at 10 units, and still available at 15 units where LuWei is not.
// The customer-facing US promise is read from shipping_zones (currently 7-14
// business days); route preference itself remains unchanged.
export const MARKET_OVERRIDES = Object.freeze({
  US: Object.freeze({ preferredMethods: Object.freeze(['YunExpress Ordinary']) })
});

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
  const standard = availableMethods.filter(m => !isExcludedLogisticsMethod(m.logisticName, excluded));
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

  const cheapest = meetsPromise[0];
  const cheapestSelection = {
    method: cheapest.logisticName, cost: costOf(cheapest), agingDays: maxAgingDays(cheapest),
    reason: meetsPromise.length === 1 ? 'ONLY_METHOD_MEETS_PROMISE' : 'CHEAPEST_MEETING_PROMISE'
  };

  // A preferred route is used only if CJ offers it for THIS order and it is
  // inside the promise; the cheapest compliant route is kept as fallback.
  for (const name of override?.preferredMethods ?? []) {
    const preferred = meetsPromise.find(m => m.logisticName === name);
    if (preferred && preferred !== cheapest) {
      return {
        method: preferred.logisticName, cost: costOf(preferred), agingDays: maxAgingDays(preferred),
        reason: 'PREFERRED_METHOD', fallback: cheapestSelection
      };
    }
    if (preferred) return { ...cheapestSelection, reason: 'PREFERRED_METHOD' };
  }
  return cheapestSelection;
};
