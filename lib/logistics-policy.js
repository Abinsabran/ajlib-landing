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

// Approved minimum gross margin before automatic fulfillment is allowed.
// Configurable server-side via CJ_MIN_MARGIN_PERCENT; 20 is the approved
// default. Never silently bypassed: see cj-fulfillment.js, which treats an
// explicitly-unset threshold as "cannot evaluate" and blocks.
export const MIN_ACCEPTABLE_MARGIN_PERCENT = Number(process.env.CJ_MIN_MARGIN_PERCENT ?? 20);

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
