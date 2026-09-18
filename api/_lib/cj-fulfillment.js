// Provider-neutral fulfillment pipeline — shared by BOTH Stripe and Tabby.
//
// This is the ONE place that turns a verified-paid AJLIB order into
// everything needed for a CJ fulfillment order, up to (never including)
// the actual live create-order call. Neither payment provider re-implements
// any of this — api/stripe-webhook.js and api/commerce.js's tabby-verify
// both call the same functions here.
//
// Nothing in this file sends a CJ order. createFulfillmentOrder in
// api/_lib/cj-client.js remains disabled; buildCjOrderPayload here only
// constructs the request body for review.

import { cjVariantFor, AJLIB_VARIANT_KEYS } from './cj-variant-map.js';
import { calculateFreight, queryProductConnections, getAccountBalance, findOrderByOrderNumber, isCjErrorBody, CJ_RATE_LIMITED_CODE } from './cj-client.js';
import {
  selectLogisticsMethod, MIN_ACCEPTABLE_MARGIN_PERCENT, CJ_BALANCE_LOW_WARNING_AED,
  classifyMargin, MARGIN_BANDS, CJ_MARGIN_AUTO_PERCENT, CJ_ALLOW_REVIEW_BAND_AUTOFULFILL,
  STRIPE_FEE_PERCENT, STRIPE_FEE_FIXED_AED, STRIPE_INTERNATIONAL_SURCHARGE_PERCENT, TABBY_FEE_PERCENT, TABBY_FEE_FIXED_AED,
  CJ_CUSTOMIZATION_COST_USD_PER_UNIT, OTHER_VARIABLE_COST_USD_PER_ORDER
} from './logistics-policy.js';
import { AJLIB_DEFAULT_SHOP_ID, AJLIB_PLATFORM_PRODUCT_ID } from './cj-store-connection.js';
import { AED_EXCHANGE_RATES } from './currency.js';

// CJ settles in USD; AJLIB holds its balance targets in AED. Single
// conversion source — the existing rate table, not a new invented rate.
export const AED_TO_USD = AED_EXCHANGE_RATES.USD;
export const usdToAed = (usd) => Number(usd) / AED_TO_USD;
export const aedToUsd = (aed) => Number(aed) * AED_TO_USD;

// CJ's documented payType enum (official docs, shopping.html "Create Order V2",
// re-read 2026-09-18):
//   1 (or omitted) = "page payment (default), and cjPayUrl will be returned"
//   2 = "balance payment ... add-to-cart, order confirmation, and balance deduction"
//   3 = "create the order only without initiating payment, add-to-cart, or order confirmation"
// Launch model: 1 — a real, confirmed CJ order the owner pays manually; the
// unpaid state is tracked (WAITING_FOR_CJ_PAYMENT) and alerted, never silent.
export const CJ_PAY_TYPE_BALANCE = 2;
export const CJ_PAY_TYPE_CREATE_ONLY = 3;
// payType 1 (CJ's default): "page payment, and cjPayUrl will be returned".
// The order is created and confirmed but NOT paid by the API — nothing is
// deducted; the owner pays that specific order in CJ (or via cjPayUrl).
export const CJ_PAY_TYPE_PAGE = 1;

// LAUNCH MODEL (approved 2026-09-18): 'manual' — AJLIB creates the CJ order
// unpaid (payType 1) and the owner pays it in CJ; the wallet is neither
// required nor checked. 'balance' (payType 2, wallet-paid) is kept only as an
// optional future mode and must be chosen explicitly.
export const CJ_PAYMENT_MODE = process.env.CJ_PAYMENT_MODE === 'balance' ? 'balance' : 'manual';
export const payTypeForMode = (mode = CJ_PAYMENT_MODE) => (mode === 'balance' ? CJ_PAY_TYPE_BALANCE : CJ_PAY_TYPE_PAGE);

// Destinations whose CJ order needs a state/province and a postal code.
// Only markets confirmed so far; others are not assumed to need them
// (e.g. UAE addresses have no postal code).
export const STATE_AND_ZIP_REQUIRED = Object.freeze(['US']);
const ZIP_FORMAT = Object.freeze({ US: /^\d{5}(-\d{4})?$/ });
// Same character set and length as the checkout's phone field.
const PHONE_FORMAT = /^\+?[0-9 ()-]{7,24}$/;

// Everything CJ needs to print a label, checked before any CJ call.
// Returns the list of missing/invalid fields (empty = complete).
export const shippingProblems = (orderRow) => {
  const t = (value) => String(value ?? '').trim();
  const code = t(orderRow.shipping_country_code).toUpperCase();
  const problems = [];
  if (!t(orderRow.customer_name)) problems.push('name');
  if (!PHONE_FORMAT.test(t(orderRow.customer_phone))) problems.push('phone');
  if (!/^[A-Z]{2}$/.test(code)) problems.push('country');
  if (STATE_AND_ZIP_REQUIRED.includes(code)) {
    if (!t(orderRow.shipping_region)) problems.push('state');
    const zip = t(orderRow.shipping_postal_code);
    if (!zip || (ZIP_FORMAT[code] && !ZIP_FORMAT[code].test(zip))) problems.push('zip');
  }
  return problems;
};

export class FulfillmentBlockedError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.reason = reason; // machine-readable, safe to log internally — never shown to the customer
    this.details = details;
  }
}

// ---- 1. Variant resolution -------------------------------------------------
// items: the SAME shape already stored on orders.items — [{variant, quantity}]
// where `variant` is "<colorAr>-<size>" (e.g. "أسود-L"), exactly matching
// AJLIB_VARIANT_KEYS. Never guesses: an item that doesn't match one of the
// 16 confirmed keys is reported as unresolved, not silently dropped.
export const resolveFulfillmentVariants = (items) => {
  const resolved = [];
  const unresolved = [];
  for (const item of items || []) {
    const cj = cjVariantFor(item.variant);
    if (cj && AJLIB_VARIANT_KEYS.includes(item.variant)) {
      resolved.push({ variant: item.variant, quantity: Number(item.quantity) || 0, cjVariantId: cj.cjVariantId, cjVariantSku: cj.cjVariantSku });
    } else {
      unresolved.push(item);
    }
  }
  return { resolved, unresolved, fullyResolved: unresolved.length === 0 && resolved.length > 0 };
};

// ---- 2. Current CJ product cost (NEVER platformPrice) ----------------------
// platformPrice on the Product Connection is AJLIB's own reference/display
// price we sent during Save Variant Batch — it is not a supplier cost.
// cjPrice on the same connection record is CJ's actual reported per-unit
// supplier cost (confirmed live: "cjPrice": "2.21" per variant during Phase
// 3 verification). Re-queried fresh here rather than trusting a cached
// value, since supplier cost can change.
export const getCurrentCjProductCosts = async (resolvedItems) => {
  const connections = await queryProductConnections({ shopId: AJLIB_DEFAULT_SHOP_ID, platformProductId: AJLIB_PLATFORM_PRODUCT_ID, pageSize: 100 });
  // Same failure mode as freight: a rate-limited/errored call returns no
  // list, which would look like "this variant has no cost on record" and
  // could otherwise let an order through with a wrong cost basis.
  if (isCjErrorBody(connections.body)) {
    throw new FulfillmentBlockedError('CJ_COST_API_ERROR', {
      code: connections.body?.code, message: connections.body?.message,
      rateLimited: Number(connections.body?.code) === CJ_RATE_LIMITED_CODE
    });
  }
  const list = Array.isArray(connections.body?.data?.list) ? connections.body.data.list : [];
  const byVariantId = new Map(list.map(row => [row.cjVariantId, row]));
  return resolvedItems.map(item => {
    const row = byVariantId.get(item.cjVariantId);
    const unitCostUSD = row ? Number(row.cjPrice) : null;
    return { ...item, unitCostUSD, lineCostUSD: unitCostUSD != null ? unitCostUSD * item.quantity : null };
  });
};

// ---- 3 & 4. Freight validation + logistics selection -----------------------
// Queries CJ's real, current freight availability for THIS order's exact
// variants/quantities/destination, then applies the configurable policy —
// never a hardcoded method. Returns null method + reason if nothing is safe
// to select (e.g. no methods available for this combination at all).
export const resolveFreightAndLogistics = async ({ resolvedItems, destinationCountryCode, maxDeliveryDays }) => {
  const products = resolvedItems.map(item => ({ vid: item.cjVariantId, quantity: item.quantity }));
  const freight = await calculateFreight({ startCountryCode: 'CN', endCountryCode: destinationCountryCode, products });
  // CJ reports failures in the BODY with HTTP 200 (e.g. rate limiting:
  // {"code":1600200,"message":"Too Many Requests, QPS limit is 1 time/1second"}),
  // so a rate-limited or errored freight call yields no `data` and would
  // otherwise be indistinguishable from "this destination genuinely has no
  // routes" — which would wrongly block a fulfillable order, or worse, look
  // like a business condition rather than an API failure. Confirmed live.
  if (isCjErrorBody(freight.body)) {
    throw new FulfillmentBlockedError('CJ_FREIGHT_API_ERROR', {
      code: freight.body?.code, message: freight.body?.message, destinationCountryCode,
      rateLimited: Number(freight.body?.code) === CJ_RATE_LIMITED_CODE
    });
  }
  const availableMethods = Array.isArray(freight.body?.data) ? freight.body.data : [];
  const selection = selectLogisticsMethod(availableMethods, { countryCode: destinationCountryCode, maxDeliveryDays });
  return { availableMethods, selection, raw: freight };
};

// ---- CJ Balance preflight ---------------------------------------------------
// Approved operating model: CJ Balance funds fulfillment, with NO automatic
// top-up. So before any order is submitted with payType=2, the wallet must
// be checked and confirmed to cover this order's payable amount. An
// insufficient balance stops automatic fulfillment and flags the order for
// review — it never silently creates an unpaid CJ order, and never leaves
// the customer's paid AJLIB order without a recorded reason.
//
// STRICT parsing of CJ's real getBalance response. Field names confirmed
// against a live read-only call to GET /shopping/pay/getBalance:
//   { "amount": 0, "noWithdrawalAmount": 0, "freezeAmount": 0 }
//     amount             -> AVAILABLE balance (what can actually pay an order)
//     freezeAmount       -> frozen / held
//     noWithdrawalAmount -> present but non-withdrawable
//
// Strict on purpose: a response that is not a success envelope, or whose
// `amount` is not a finite number, yields null — "cannot verify", which
// blocks fulfillment. It is never coerced to 0, because a real 0 balance
// and an unreadable balance must stay distinguishable (both block, but
// only one of them means "top up the wallet").
export const parseCjBalance = (body) => {
  if (!body || body.result !== true || Number(body.code) !== 200) return null;
  const data = body.data;
  if (!data || typeof data !== 'object') return null;
  const available = Number(data.amount);
  if (!Number.isFinite(available)) return null;
  const frozen = Number(data.freezeAmount);
  const nonWithdrawable = Number(data.noWithdrawalAmount);
  return {
    availableUSD: available,
    frozenUSD: Number.isFinite(frozen) ? frozen : null,
    nonWithdrawableUSD: Number.isFinite(nonWithdrawable) ? nonWithdrawable : null
  };
};

// Only the AVAILABLE balance can pay an order — frozen and non-withdrawable
// funds must never be counted toward affordability.
export const parseCjBalanceUSD = (body) => parseCjBalance(body)?.availableUSD ?? null;

export const evaluateBalanceSufficiency = ({ balanceUSD, requiredUSD, lowWarningAed = CJ_BALANCE_LOW_WARNING_AED }) => {
  if (balanceUSD == null) {
    return { sufficient: false, reason: 'CJ_BALANCE_UNAVAILABLE', balanceUSD: null, requiredUSD, lowBalanceWarning: true };
  }
  const sufficient = balanceUSD >= requiredUSD;
  const remainingAfterUSD = balanceUSD - requiredUSD;
  return {
    sufficient,
    reason: sufficient ? 'BALANCE_OK' : 'INSUFFICIENT_CJ_BALANCE',
    balanceUSD,
    balanceAed: usdToAed(balanceUSD),
    requiredUSD,
    remainingAfterUSD,
    // Warns on the balance that would REMAIN after this order, so the
    // warning fires before the wallet actually runs dry rather than after.
    lowBalanceWarning: usdToAed(Math.max(remainingAfterUSD, 0)) < lowWarningAed,
    lowWarningAed
  };
};

export const checkCjBalance = async (requiredUSD) => {
  const response = await getAccountBalance();
  const parsed = parseCjBalance(response.body);
  const verdict = evaluateBalanceSufficiency({ balanceUSD: parsed?.availableUSD ?? null, requiredUSD });
  return { ...verdict, frozenUSD: parsed?.frozenUSD ?? null, nonWithdrawableUSD: parsed?.nonWithdrawableUSD ?? null };
};

// ---- Payment processing fee (a real per-order variable cost) ----------------
// Returns the processing fee in USD for an order collected in AED fils.
// provider: 'stripe' | 'tabby'. A null fee (Tabby's unpublished negotiated
// rate, when not configured) yields null — "cannot evaluate", which blocks
// margin approval rather than silently understating cost.
export const paymentFeeUSD = ({ amountCollectedFils, provider = 'stripe', international = false }) => {
  const amountAed = Number(amountCollectedFils || 0) / 100;
  if (provider === 'tabby') {
    if (TABBY_FEE_PERCENT == null) return null;
    // Confirmed UAE rate: 6.99% + AED 1.50 per transaction.
    return aedToUsd(amountAed * (TABBY_FEE_PERCENT / 100) + TABBY_FEE_FIXED_AED);
  }
  const percent = STRIPE_FEE_PERCENT + (international ? STRIPE_INTERNATIONAL_SURCHARGE_PERCENT : 0);
  return aedToUsd(amountAed * (percent / 100) + STRIPE_FEE_FIXED_AED);
};

// Full TRUE variable cost for one order, in USD. Everything that varies
// per order goes in here — CJ product (cjPrice, never platformPrice), CJ
// freight, per-unit customization, payment processing, and any other known
// per-order variable cost.
export const computeTrueVariableCost = ({
  cjProductCostUSD, cjShippingCostUSD, unitCount = 0,
  amountCollectedFils, provider = 'stripe', international = false,
  customizationCostPerUnitUSD = CJ_CUSTOMIZATION_COST_USD_PER_UNIT,
  otherVariableCostUSD = OTHER_VARIABLE_COST_USD_PER_ORDER
}) => {
  const customizationUSD = Number(customizationCostPerUnitUSD || 0) * Number(unitCount || 0);
  const feeUSD = paymentFeeUSD({ amountCollectedFils, provider, international });
  if (feeUSD == null) {
    return { total: null, reason: 'PAYMENT_FEE_NOT_CONFIGURED', breakdown: { provider } };
  }
  const total = Number(cjProductCostUSD) + Number(cjShippingCostUSD) + customizationUSD + feeUSD + Number(otherVariableCostUSD || 0);
  return {
    total,
    reason: 'OK',
    breakdown: {
      cjProductCostUSD: Number(cjProductCostUSD),
      cjShippingCostUSD: Number(cjShippingCostUSD),
      customizationUSD,
      paymentFeeUSD: feeUSD,
      otherVariableCostUSD: Number(otherVariableCostUSD || 0),
      provider
    }
  };
};

// ---- 5. TRUE net margin band guard ------------------------------------------
// Margin is computed on TRUE variable cost (CJ product + CJ freight +
// customization + payment fee + other known per-order variable cost), never
// on CJ product+freight alone, and never using platformPrice.
//
//   >= 25% -> GREEN  : approved for automatic fulfillment
//   20-25% -> REVIEW : held for a human (unless explicitly enabled)
//   <  20% -> BLOCK  : never auto-fulfilled
//
// An unconfigured threshold or an unknown payment fee is treated as
// "cannot be safely evaluated" and blocks — never as "no limit".
export const evaluateFulfillmentMargin = ({
  productAmountCollectedFils, shippingAmountCollectedFils, // what AJLIB actually collected, AED fils (server-authoritative, from the order row)
  cjProductCostUSD, cjShippingCostUSD, // from getCurrentCjProductCosts / resolveFreightAndLogistics
  aedToUsdRate = AED_TO_USD,
  minAcceptableMarginPercent = MIN_ACCEPTABLE_MARGIN_PERCENT,
  unitCount = 0, provider = 'stripe', international = false,
  customizationCostPerUnitUSD, otherVariableCostUSD,
  allowReviewBandAutofulfill = CJ_ALLOW_REVIEW_BAND_AUTOFULFILL
}) => {
  if (minAcceptableMarginPercent == null || !Number.isFinite(Number(minAcceptableMarginPercent))) {
    return { approved: false, reason: 'MARGIN_THRESHOLD_NOT_CONFIGURED', band: MARGIN_BANDS.BLOCK, details: {} };
  }

  const amountCollectedFils = Number(productAmountCollectedFils || 0) + Number(shippingAmountCollectedFils || 0);
  const variable = computeTrueVariableCost({
    cjProductCostUSD, cjShippingCostUSD, unitCount, amountCollectedFils,
    provider, international, customizationCostPerUnitUSD, otherVariableCostUSD
  });
  if (variable.total == null) {
    // e.g. a Tabby order with no negotiated rate configured: the true cost
    // is genuinely unknown, so no margin claim can be made.
    return { approved: false, reason: variable.reason, band: MARGIN_BANDS.BLOCK, details: { breakdown: variable.breakdown } };
  }

  const collectedUSD = (amountCollectedFils / 100) * aedToUsdRate;
  const marginUSD = collectedUSD - variable.total;
  const marginPercent = collectedUSD > 0 ? (marginUSD / collectedUSD) * 100 : -100;
  const band = classifyMargin(marginPercent);
  const approved = band === MARGIN_BANDS.GREEN || (band === MARGIN_BANDS.REVIEW && allowReviewBandAutofulfill);

  const reason = band === MARGIN_BANDS.GREEN ? 'MARGIN_OK'
    : band === MARGIN_BANDS.REVIEW ? 'MARGIN_REVIEW_REQUIRED'
    : 'MARGIN_BELOW_THRESHOLD';

  return {
    approved, band, reason,
    details: {
      collectedUSD,
      fulfillmentCostUSD: variable.total, // true variable cost
      marginUSD, marginPercent,
      minAcceptableMarginPercent,
      autoThresholdPercent: CJ_MARGIN_AUTO_PERCENT,
      breakdown: variable.breakdown
    }
  };
};

// Minimum revenue (AED) required to hit a target TRUE net margin, given the
// non-payment variable costs (CJ product + freight + customization + other).
// The payment fee scales with revenue, so this solves rather than adds:
//   revenue - otherCosts - (revenue*f + fixedFee) = revenue * m
//   => revenue * (1 - f - m) = otherCosts + fixedFee
//   => revenue = (otherCosts + fixedFee) / (1 - f - m)
// Returns null when the target is unreachable at any price — i.e. the
// target margin plus the fee rate leaves nothing to cover cost (m + f >= 1)
// — instead of a nonsensical or negative figure.
export const minimumRevenueAedForMargin = ({
  targetMarginPercent, nonPaymentVariableCostUSD,
  provider = 'stripe', international = false
}) => {
  const m = Number(targetMarginPercent) / 100;
  const isTabby = provider === 'tabby';
  if (isTabby && TABBY_FEE_PERCENT == null) return null;
  const f = isTabby
    ? TABBY_FEE_PERCENT / 100
    : (STRIPE_FEE_PERCENT + (international ? STRIPE_INTERNATIONAL_SURCHARGE_PERCENT : 0)) / 100;
  const denominator = 1 - f - m;
  if (denominator <= 0) return null;
  const fixedAed = isTabby ? TABBY_FEE_FIXED_AED : STRIPE_FEE_FIXED_AED;
  return (usdToAed(nonPaymentVariableCostUSD) + fixedAed) / denominator;
};

// ---- 6. Idempotency check ---------------------------------------------------
// A paid AJLIB order must never get a second CJ order. The caller (the
// order row from Supabase) already carries fulfillment_external_order_id
// once one exists — this is a pure guard, no network call.
export const alreadyHasFulfillmentOrder = (orderRow) => Boolean(orderRow?.fulfillment_external_order_id);

// ---- payType=2 timeout reconciliation ---------------------------------------
// CJ support confirmed that createOrderV2 with payType=2 performs order
// creation, confirmation AND balance deduction in ONE request, and that the
// deduction is immediate and CANNOT be rolled back.
//
// The consequence: a timed-out request is NOT a failed request. The money
// may already be gone and the order may already exist. Retrying blindly
// risks a second paid order. So a timeout must always be resolved by
// READ-ONLY reconciliation, never by re-sending.

// CJ statuses that mean the order has NOT been paid yet. Everything else in
// the documented enum (PENDING/PROCESSING/UNSHIPPED/SHIPPED/DELIVERED)
// means payment already happened.
export const CJ_UNPAID_STATUSES = Object.freeze(['UNPAID', 'CREATED', 'IN_CART']);

// An order counts as paid only when BOTH signals agree: the status is not an
// unpaid status, AND CJ records a paymentDate. Requiring both keeps an
// ambiguous row (e.g. a status we don't recognize, or a paid-looking status
// with no payment timestamp) from being read as a completed payment.
export const isCjOrderPaid = (cjOrderRow) => {
  if (!cjOrderRow) return false;
  const status = String(cjOrderRow.orderStatus ?? '').toUpperCase();
  if (!status || CJ_UNPAID_STATUSES.includes(status)) return false;
  const paymentDate = cjOrderRow.paymentDate;
  return Boolean(paymentDate && String(paymentDate).trim());
};

// Resolves what actually happened after a createOrderV2 timeout (or after a
// repeated-payment business error). Read-only: it lists orders and matches
// our deterministic orderNumber. Returns one of:
//   { outcome: 'ALREADY_PAID',  cjOrderId, paymentDate, status }
//   { outcome: 'EXISTS_UNPAID', cjOrderId, status }   -> order created, payment did not land
//   { outcome: 'NOT_FOUND',     safeToRetry: true }   -> nothing was created
//   { outcome: 'UNKNOWN',       safeToRetry: false }  -> could not determine; never retry
export const reconcileAfterTimeout = async (ajlibOrderNumber) => {
  const orderNumber = cjOrderNumberFor(ajlibOrderNumber);
  let row;
  try {
    row = await findOrderByOrderNumber(orderNumber);
  } catch (error) {
    // Could not read CJ's side at all. The original request's fate is
    // genuinely unknown, and an unknown state must never authorize a retry
    // that could double-charge the wallet.
    return { outcome: 'UNKNOWN', safeToRetry: false, orderNumber, error: error.message };
  }

  if (!row) {
    // CJ has no order under our deterministic number, so the create never
    // took effect and no balance was deducted. This is the ONLY case where
    // re-sending is safe.
    return { outcome: 'NOT_FOUND', safeToRetry: true, orderNumber };
  }

  if (isCjOrderPaid(row)) {
    return {
      outcome: 'ALREADY_PAID', safeToRetry: false, orderNumber,
      cjOrderId: row.orderId ?? null, status: row.orderStatus ?? null, paymentDate: row.paymentDate ?? null
    };
  }

  // The order exists but is not paid. Re-sending createOrderV2 is still not
  // safe (the same orderNumber already exists on CJ's side); this needs a
  // human, or a separate explicit payment step.
  return {
    outcome: 'EXISTS_UNPAID', safeToRetry: false, orderNumber,
    cjOrderId: row.orderId ?? null, status: row.orderStatus ?? null
  };
};

// A repeated-payment business error from CJ means "this order was already
// dealt with", NOT "the payment failed". Treating it as a failure is how a
// successfully-paid order gets paid twice or wrongly marked failed — so any
// such error is always resolved by read-only reconciliation instead.
export const resolveRepeatedPaymentError = async (ajlibOrderNumber) => reconcileAfterTimeout(ajlibOrderNumber);

// CJ's own idempotency key for createOrderV2 (documented: duplicate
// submissions with the same orderNumber do not create a second order).
// Stable and deterministic from our own order_number — never random.
export const cjOrderNumberFor = (ajlibOrderNumber) => `AJLIB-${ajlibOrderNumber}`;

// ---- 7. CJ order payload builder (never sent) ------------------------------
// Builds the exact createOrderV2 request body for review. payType defaults
// to 2 (CJ Balance) per the approved operating model — the order is paid at
// creation from the wallet that checkCjBalance has already verified covers
// it, so a customer-paid AJLIB order is never left unpaid inside CJ.
// English country name for CJ's shippingCountry, derived from the ISO code.
export const cjCountryName = (countryCode) => {
  const code = String(countryCode ?? '').trim().toUpperCase();
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch { return code; }
};

// Every text field is trimmed: these are printed on the shipping label.
const clean = (value) => (value == null ? value : String(value).trim());

export const buildCjOrderPayload = ({
  ajlibOrderNumber, resolvedItems, logisticName,
  shippingCountryCode, shippingCountry, shippingProvince, shippingCity,
  shippingCustomerName, shippingAddress, shippingAddress2, shippingZip, shippingPhone,
  email, payType = CJ_PAY_TYPE_BALANCE
}) => ({
  orderNumber: cjOrderNumberFor(clean(ajlibOrderNumber)),
  shippingCountryCode: clean(shippingCountryCode)?.toUpperCase(),
  shippingCountry: clean(shippingCountry),
  shippingProvince: clean(shippingProvince),
  shippingCity: clean(shippingCity),
  shippingCustomerName: clean(shippingCustomerName),
  shippingAddress: clean(shippingAddress),
  shippingAddress2: clean(shippingAddress2),
  shippingZip: clean(shippingZip),
  shippingPhone: clean(shippingPhone),
  email: clean(email),
  logisticName,
  fromCountryCode: 'CN',
  payType, // 2 = CJ Balance (approved automatic-fulfillment model)
  products: resolvedItems.map(item => ({ vid: item.cjVariantId, quantity: item.quantity }))
});

// ---- Orchestration (stops BEFORE the live create-order call) --------------
// Runs the full pipeline for one paid order and returns a decision object.
// Throws FulfillmentBlockedError for any condition that must not proceed to
// order creation (unresolved variant, no logistics available, margin guard
// failed, or an order that already has a CJ reference).
export const prepareFulfillment = async (orderRow, {
  minAcceptableMarginPercent, aedToUsdRate, additionalFulfillmentCostUSD,
  maxDeliveryDays, // AJLIB's existing promise for this destination (zone max_days)
  paymentMode = CJ_PAYMENT_MODE,
  // The wallet only matters when CJ is paid from it. In the launch 'manual'
  // mode it is never read and can never block.
  checkBalance = paymentMode === 'balance'
} = {}) => {
  if (alreadyHasFulfillmentOrder(orderRow)) {
    throw new FulfillmentBlockedError('ALREADY_FULFILLED', { fulfillment_external_order_id: orderRow.fulfillment_external_order_id });
  }

  const { resolved, unresolved, fullyResolved } = resolveFulfillmentVariants(orderRow.items);
  if (!fullyResolved) {
    throw new FulfillmentBlockedError('UNRESOLVED_VARIANT', { unresolved });
  }

  // Orders placed BEFORE the structured-city migration have no
  // shipping_city (it was only ever flattened into shipping_address). CJ's
  // createOrderV2 requires it as a distinct field, and a city must never be
  // parsed back out of a free-text address — so legacy orders are blocked
  // for manual handling instead of guessed. Checked before any cost/freight
  // network call, since there's no point pricing an order whose payload
  // cannot be completed.
  if (!String(orderRow.shipping_city ?? '').trim()) {
    throw new FulfillmentBlockedError('MISSING_SHIPPING_CITY', {
      note: 'Legacy order placed before structured shipping_city was persisted — requires manual review; city must never be inferred from the flattened address'
    });
  }

  // Same rule for the street line: CJ's shippingAddress must be the street
  // only. Orders placed before shipping_street was captured have none, and
  // it is never parsed back out of the flattened shipping_address.
  if (!String(orderRow.shipping_street ?? '').trim()) {
    throw new FulfillmentBlockedError('MISSING_SHIPPING_STREET', {
      note: 'No structured street line on this order — requires manual review; the street must never be inferred from the flattened address'
    });
  }

  const problems = shippingProblems(orderRow);
  if (problems.length) {
    throw new FulfillmentBlockedError('INCOMPLETE_SHIPPING_ADDRESS', { missing: problems });
  }

  // The approved policy is "cheapest appropriate route that satisfies
  // AJLIB's existing delivery promise", so the promise is REQUIRED input,
  // not an optional refinement. Live CJ data makes this load-bearing: the
  // cheapest AE route (CJPacket Eub, $10.52) has 12-50 day aging, so an
  // unconstrained "cheapest" would auto-select a potentially 50-day
  // shipment. An absent promise is "cannot evaluate", never "any speed".
  // Checked before any CJ call — both to fail fast and to avoid spending
  // requests against CJ's 1/second QPS budget on an order that cannot ship.
  if (maxDeliveryDays == null) {
    throw new FulfillmentBlockedError('DELIVERY_PROMISE_NOT_CONFIGURED', {
      note: 'Caller must supply the destination shipping zone\'s max_days; without it no route can be judged appropriate'
    });
  }

  const costed = await getCurrentCjProductCosts(resolved);
  if (costed.some(item => item.unitCostUSD == null)) {
    throw new FulfillmentBlockedError('MISSING_CJ_PRODUCT_COST', { costed });
  }
  const cjProductCostUSD = costed.reduce((sum, item) => sum + item.lineCostUSD, 0);

  const destinationCountryCode = orderRow.shipping_country_code;
  const { availableMethods, selection: offeredSelection } = await resolveFreightAndLogistics({ resolvedItems: resolved, destinationCountryCode, maxDeliveryDays });
  if (!offeredSelection.method) {
    throw new FulfillmentBlockedError('NO_LOGISTICS_AVAILABLE', { destinationCountryCode, availableMethods, selection: offeredSelection });
  }

  const unitCount = resolved.reduce((sum, item) => sum + item.quantity, 0);
  const customizationPerUnitUSD = additionalFulfillmentCostUSD ?? CJ_CUSTOMIZATION_COST_USD_PER_UNIT;
  // What CJ will actually deduct from the wallet for this order: product +
  // freight + per-unit customization (the sticker is a CJ service, so CJ
  // bills it). The payment processor's fee is deliberately NOT included —
  // that is paid to Stripe/Tabby, never to CJ. This single figure is used for
  // the balance preflight and is what an operator sees as "amount required".
  const assess = (candidate) => ({
    selection: candidate,
    requiredUSD: cjProductCostUSD + candidate.cost + (customizationPerUnitUSD * unitCount),
    margin: evaluateFulfillmentMargin({
      productAmountCollectedFils: orderRow.product_amount || 0,
      shippingAmountCollectedFils: orderRow.shipping_amount || 0,
      cjProductCostUSD,
      cjShippingCostUSD: candidate.cost,
      aedToUsdRate,
      minAcceptableMarginPercent,
      unitCount,
      // Which provider actually collected the money determines the real fee.
      provider: String(orderRow.stripe_session_id || '').startsWith('tabby_') ? 'tabby' : 'stripe',
      customizationCostPerUnitUSD: customizationPerUnitUSD
    })
  });

  // A market's preferred route (e.g. YunExpress Ordinary for the US) is used
  // only while it keeps the order in the approved margin band; otherwise the
  // cheapest route inside the delivery promise is re-assessed instead.
  let chosen = assess(offeredSelection);
  if (!chosen.margin.approved && offeredSelection.fallback) {
    const fallback = assess({ ...offeredSelection.fallback, reason: 'PREFERRED_MISSED_MARGIN_FALLBACK', preferredMissed: offeredSelection.method });
    if (fallback.margin.approved) chosen = fallback;
  }
  const { selection, requiredUSD, margin } = chosen;

  // Everything already calculated by this point. Attached to any block that
  // happens from here on, so a REVIEW_REQUIRED order still tells an operator
  // which route was chosen and what it would cost — instead of discarding it.
  const reviewContext = { logistics: selection, requiredUSD, unitCount };

  if (!margin.approved) {
    // REVIEW and BLOCK are distinguished so an operator can tell a
    // thin-but-viable order from a genuinely loss-making one.
    throw new FulfillmentBlockedError(
      margin.band === MARGIN_BANDS.REVIEW ? 'FULFILLMENT_REVIEW_REQUIRED' : 'MARGIN_BELOW_FLOOR',
      { margin, ...reviewContext }
    );
  }

  // Balance preflight LAST among the guards, so the wallet is only queried
  // for an order that is otherwise fully approved — but still strictly
  // BEFORE any order creation, because payType=2 spends the wallet at
  // creation time. No automatic top-up: an insufficient balance blocks and
  // flags for review, leaving the paid AJLIB order intact.
  const balance = checkBalance ? await checkCjBalance(requiredUSD) : null;
  if (balance && !balance.sufficient) {
    throw new FulfillmentBlockedError('INSUFFICIENT_CJ_BALANCE', { balance, ...reviewContext });
  }

  const payload = buildCjOrderPayload({
    ajlibOrderNumber: orderRow.order_number,
    resolvedItems: resolved,
    logisticName: selection.method,
    shippingCountryCode: destinationCountryCode,
    // English, from the ISO code — never the storefront's localized name.
    shippingCountry: cjCountryName(destinationCountryCode),
    shippingProvince: orderRow.shipping_region,
    shippingCity: orderRow.shipping_city,
    shippingCustomerName: orderRow.customer_name,
    shippingAddress: orderRow.shipping_street,
    shippingAddress2: orderRow.shipping_street2 || '',
    shippingZip: orderRow.shipping_postal_code,
    shippingPhone: orderRow.customer_phone,
    email: orderRow.customer_email,
    payType: payTypeForMode(paymentMode)
  });

  return { ready: true, resolved, cjProductCostUSD, requiredUSD, logistics: selection, margin, balance, payload, paymentMode };
};
