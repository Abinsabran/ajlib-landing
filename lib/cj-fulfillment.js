// Provider-neutral fulfillment pipeline — shared by BOTH Stripe and Tabby.
//
// This is the ONE place that turns a verified-paid AJLIB order into
// everything needed for a CJ fulfillment order, up to (never including)
// the actual live create-order call. Neither payment provider re-implements
// any of this — api/stripe-webhook.js and api/commerce.js's tabby-verify
// both call the same functions here.
//
// Nothing in this file sends a CJ order. createFulfillmentOrder in
// lib/cj-client.js remains disabled; buildCjOrderPayload here only
// constructs the request body for review.

import { cjVariantFor, AJLIB_VARIANT_KEYS } from './cj-variant-map.js';
import { calculateFreight, queryProductConnections, getAccountBalance } from './cj-client.js';
import { selectLogisticsMethod, MIN_ACCEPTABLE_MARGIN_PERCENT, CJ_BALANCE_LOW_WARNING_AED } from './logistics-policy.js';
import { AJLIB_DEFAULT_SHOP_ID, AJLIB_PLATFORM_PRODUCT_ID } from './cj-store-connection.js';
import { AED_EXCHANGE_RATES } from './currency.js';

// CJ settles in USD; AJLIB holds its balance targets in AED. Single
// conversion source — the existing rate table, not a new invented rate.
export const AED_TO_USD = AED_EXCHANGE_RATES.USD;
export const usdToAed = (usd) => Number(usd) / AED_TO_USD;
export const aedToUsd = (aed) => Number(aed) * AED_TO_USD;

// CJ's documented payType enum (official docs, shopping.html "Create Order"):
//   1 (or omitted) = page payment, 2 = balance payment, 3 = create only.
// AJLIB's approved model is CJ Balance, so automatic fulfillment uses 2.
// 3 is explicitly NOT used for automatic fulfillment: it would leave a
// customer-paid AJLIB order sitting unpaid inside CJ, which is exactly the
// silent-failure mode the operating model forbids.
export const CJ_PAY_TYPE_BALANCE = 2;
export const CJ_PAY_TYPE_CREATE_ONLY = 3;

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
// Parses CJ's real getBalance response defensively: the docs do not publish
// the `data` field names, so every plausible documented spelling is checked
// and an unrecognized shape yields null (treated as "cannot verify" ->
// blocked), never as zero or as unlimited.
export const parseCjBalanceUSD = (body) => {
  const data = body?.data ?? {};
  const candidate = data.balance ?? data.amount ?? data.availableBalance ?? data.balanceAmount ?? data.usableBalance;
  const value = Number(candidate);
  return Number.isFinite(value) ? value : null;
};

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
  return evaluateBalanceSufficiency({ balanceUSD: parseCjBalanceUSD(response.body), requiredUSD });
};

// ---- 5. Cost / margin safety guard ------------------------------------------
// Refuses to approve automatic fulfillment unless a real margin threshold
// has been configured (lib/logistics-policy.js MIN_ACCEPTABLE_MARGIN_PERCENT)
// — an unconfigured threshold is treated as "cannot be safely evaluated",
// not as "no limit". Never invents a number.
export const evaluateFulfillmentMargin = ({
  productAmountCollectedFils, shippingAmountCollectedFils, // what AJLIB actually collected, AED fils (server-authoritative, from the order row)
  cjProductCostUSD, cjShippingCostUSD, // from getCurrentCjProductCosts / resolveFreightAndLogistics
  aedToUsdRate = AED_TO_USD,
  // Approved: 20%, configurable server-side via CJ_MIN_MARGIN_PERCENT.
  minAcceptableMarginPercent = MIN_ACCEPTABLE_MARGIN_PERCENT,
  // Any known additional per-order fulfillment/customization cost (e.g. CJ
  // packaging/sticker service). Included in the margin math when supplied;
  // AJLIB's packaging configuration itself is never read or modified here.
  additionalFulfillmentCostUSD = 0
}) => {
  if (minAcceptableMarginPercent == null || !Number.isFinite(Number(minAcceptableMarginPercent))) {
    return { approved: false, reason: 'MARGIN_THRESHOLD_NOT_CONFIGURED', details: {} };
  }
  const collectedUSD = ((productAmountCollectedFils + shippingAmountCollectedFils) / 100) * aedToUsdRate;
  const fulfillmentCostUSD = cjProductCostUSD + cjShippingCostUSD + Number(additionalFulfillmentCostUSD || 0);
  const marginUSD = collectedUSD - fulfillmentCostUSD;
  const marginPercent = collectedUSD > 0 ? (marginUSD / collectedUSD) * 100 : -100;
  const approved = marginPercent >= minAcceptableMarginPercent;
  return {
    approved,
    reason: approved ? 'MARGIN_OK' : 'MARGIN_BELOW_THRESHOLD',
    details: { collectedUSD, fulfillmentCostUSD, marginUSD, marginPercent, minAcceptableMarginPercent, additionalFulfillmentCostUSD: Number(additionalFulfillmentCostUSD || 0) }
  };
};

// ---- 6. Idempotency check ---------------------------------------------------
// A paid AJLIB order must never get a second CJ order. The caller (the
// order row from Supabase) already carries fulfillment_external_order_id
// once one exists — this is a pure guard, no network call.
export const alreadyHasFulfillmentOrder = (orderRow) => Boolean(orderRow?.fulfillment_external_order_id);

// CJ's own idempotency key for createOrderV2 (documented: duplicate
// submissions with the same orderNumber do not create a second order).
// Stable and deterministic from our own order_number — never random.
export const cjOrderNumberFor = (ajlibOrderNumber) => `AJLIB-${ajlibOrderNumber}`;

// ---- 7. CJ order payload builder (never sent) ------------------------------
// Builds the exact createOrderV2 request body for review. payType defaults
// to 2 (CJ Balance) per the approved operating model — the order is paid at
// creation from the wallet that checkCjBalance has already verified covers
// it, so a customer-paid AJLIB order is never left unpaid inside CJ.
export const buildCjOrderPayload = ({
  ajlibOrderNumber, resolvedItems, logisticName,
  shippingCountryCode, shippingCountry, shippingProvince, shippingCity,
  shippingCustomerName, shippingAddress, shippingAddress2, shippingZip, shippingPhone,
  email, payType = CJ_PAY_TYPE_BALANCE
}) => ({
  orderNumber: cjOrderNumberFor(ajlibOrderNumber),
  shippingCountryCode,
  shippingCountry,
  shippingProvince,
  shippingCity,
  shippingCustomerName,
  shippingAddress,
  shippingAddress2,
  shippingZip,
  shippingPhone,
  email,
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
  checkBalance = true
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
  if (!orderRow.shipping_city) {
    throw new FulfillmentBlockedError('MISSING_SHIPPING_CITY', {
      note: 'Legacy order placed before structured shipping_city was persisted — requires manual review; city must never be inferred from the flattened address'
    });
  }

  const costed = await getCurrentCjProductCosts(resolved);
  if (costed.some(item => item.unitCostUSD == null)) {
    throw new FulfillmentBlockedError('MISSING_CJ_PRODUCT_COST', { costed });
  }
  const cjProductCostUSD = costed.reduce((sum, item) => sum + item.lineCostUSD, 0);

  const destinationCountryCode = orderRow.shipping_country_code;
  const { availableMethods, selection } = await resolveFreightAndLogistics({ resolvedItems: resolved, destinationCountryCode, maxDeliveryDays });
  if (!selection.method) {
    throw new FulfillmentBlockedError('NO_LOGISTICS_AVAILABLE', { destinationCountryCode, availableMethods, selection });
  }

  const margin = evaluateFulfillmentMargin({
    productAmountCollectedFils: orderRow.product_amount || 0,
    shippingAmountCollectedFils: orderRow.shipping_amount || 0,
    cjProductCostUSD,
    cjShippingCostUSD: selection.cost,
    aedToUsdRate,
    minAcceptableMarginPercent,
    additionalFulfillmentCostUSD
  });
  if (!margin.approved) {
    throw new FulfillmentBlockedError('FULFILLMENT_REVIEW_REQUIRED', { margin });
  }

  // Balance preflight LAST among the guards, so the wallet is only queried
  // for an order that is otherwise fully approved — but still strictly
  // BEFORE any order creation, because payType=2 spends the wallet at
  // creation time. No automatic top-up: an insufficient balance blocks and
  // flags for review, leaving the paid AJLIB order intact.
  const requiredUSD = cjProductCostUSD + selection.cost + Number(additionalFulfillmentCostUSD || 0);
  const balance = checkBalance ? await checkCjBalance(requiredUSD) : null;
  if (balance && !balance.sufficient) {
    throw new FulfillmentBlockedError('INSUFFICIENT_CJ_BALANCE', { balance });
  }

  const payload = buildCjOrderPayload({
    ajlibOrderNumber: orderRow.order_number,
    resolvedItems: resolved,
    logisticName: selection.method,
    shippingCountryCode: destinationCountryCode,
    shippingCountry: orderRow.shipping_country_name,
    shippingProvince: orderRow.shipping_region,
    shippingCity: orderRow.shipping_city,
    shippingCustomerName: orderRow.customer_name,
    shippingAddress: orderRow.shipping_address,
    shippingZip: orderRow.shipping_postal_code,
    shippingPhone: orderRow.customer_phone,
    email: orderRow.customer_email,
    payType: CJ_PAY_TYPE_BALANCE
  });

  return { ready: true, resolved, cjProductCostUSD, requiredUSD, logistics: selection, margin, balance, payload };
};
