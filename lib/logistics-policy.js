// Deterministic, maintainable server-side logistics-selection policy.
//
// Confirmed via live CJ freightCalculate testing (Phase 3): the set of
// available logistics methods varies per destination AND per quantity for
// the SAME product — CJPacket Postal disappears at qty>=15 everywhere, and
// Oman drops to DHL-only at higher quantities. This means logistics
// selection must ALWAYS be computed per-order from CJ's real, current
// availability — never hardcoded to one method.
//
// This module only picks among methods CJ itself reports as currently
// available for THIS order's exact vids/quantities/destination — it never
// invents a method name.

// Preference order when multiple methods are available: cheaper/slower
// first (CJPacket family), premium express last (DHL). Tune freely — this
// is intentionally just a preference list, not a hard requirement, since
// exact match availability is what ultimately decides the outcome.
export const PREFERRED_LOGISTICS_ORDER = Object.freeze([
  'CJPacket Postal',
  'CJPacket Sensitive',
  'CJPacket Eub',
  'CJPacket Ordinary',
  'CJPacket Liquid Line',
  'PostNL',
  'DHL Official'
]);

// Per-market overrides, e.g. to force a specific method or a different
// preference order for a given destination. Left empty — no market-specific
// business rule has been given; add entries here as AJLIB confirms them.
export const MARKET_OVERRIDES = Object.freeze({});

// Maximum acceptable shipping cost in USD (matches CJ's freightCalculate
// currency) before a method is considered unsafe to auto-select, and the
// minimum acceptable gross margin percentage before fulfillment must pause
// for review. NEITHER is invented here — both are left unconfigured
// (null) on purpose. An unconfigured guard is NOT "no limit"; see
// lib/cj-fulfillment.js's cost/margin guard, which treats a null threshold
// as "cannot be safely evaluated" and blocks auto-fulfillment rather than
// assuming an unlimited budget. Set real values here once approved.
export const MAX_SHIPPING_COST_USD = null; // e.g. 40 — NEEDS APPROVAL
export const MIN_ACCEPTABLE_MARGIN_PERCENT = null; // e.g. 15 — NEEDS APPROVAL

// availableMethods: the real `data` array from a live freightCalculate
// response — [{logisticName, logisticPrice, logisticAging, totalPostageFee}, ...].
// Returns { method, cost, reason } or { method: null, reason } if nothing
// can be safely selected.
export const selectLogisticsMethod = (availableMethods, { countryCode } = {}) => {
  if (!Array.isArray(availableMethods) || availableMethods.length === 0) {
    return { method: null, cost: null, reason: 'NO_METHODS_AVAILABLE' };
  }

  const maxCost = MARKET_OVERRIDES[countryCode]?.maxShippingCostUSD ?? MAX_SHIPPING_COST_USD;
  const withinBudget = maxCost == null
    ? availableMethods
    : availableMethods.filter(m => Number(m.totalPostageFee ?? m.logisticPrice) <= maxCost);

  if (withinBudget.length === 0) {
    return { method: null, cost: null, reason: 'ALL_METHODS_EXCEED_MAX_COST' };
  }

  const preferenceOrder = MARKET_OVERRIDES[countryCode]?.preferredOrder ?? PREFERRED_LOGISTICS_ORDER;
  for (const name of preferenceOrder) {
    const match = withinBudget.find(m => m.logisticName === name);
    if (match) {
      return { method: match.logisticName, cost: Number(match.totalPostageFee ?? match.logisticPrice), reason: 'PREFERRED_MATCH' };
    }
  }

  // None of the preferred methods are available/within budget for this
  // exact order — fall back to the cheapest option CJ actually offers,
  // satisfying "if only one method is available, use that method" and
  // "avoid unnecessarily expensive routes when a valid lower-cost route
  // exists" without ever hardcoding a single method for every order.
  const cheapest = [...withinBudget].sort((a, b) => Number(a.totalPostageFee ?? a.logisticPrice) - Number(b.totalPostageFee ?? b.logisticPrice))[0];
  return {
    method: cheapest.logisticName,
    cost: Number(cheapest.totalPostageFee ?? cheapest.logisticPrice),
    reason: withinBudget.length === 1 ? 'ONLY_METHOD_AVAILABLE' : 'CHEAPEST_AVAILABLE_FALLBACK'
  };
};
