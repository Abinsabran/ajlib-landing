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
import { calculateFreight, queryProductConnections } from './cj-client.js';
import { selectLogisticsMethod } from './logistics-policy.js';
import { AJLIB_DEFAULT_SHOP_ID, AJLIB_PLATFORM_PRODUCT_ID } from './cj-store-connection.js';

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
export const resolveFreightAndLogistics = async ({ resolvedItems, destinationCountryCode }) => {
  const products = resolvedItems.map(item => ({ vid: item.cjVariantId, quantity: item.quantity }));
  const freight = await calculateFreight({ startCountryCode: 'CN', endCountryCode: destinationCountryCode, products });
  const availableMethods = Array.isArray(freight.body?.data) ? freight.body.data : [];
  const selection = selectLogisticsMethod(availableMethods, { countryCode: destinationCountryCode });
  return { availableMethods, selection, raw: freight };
};

// ---- 5. Cost / margin safety guard ------------------------------------------
// Refuses to approve automatic fulfillment unless a real margin threshold
// has been configured (lib/logistics-policy.js MIN_ACCEPTABLE_MARGIN_PERCENT)
// — an unconfigured threshold is treated as "cannot be safely evaluated",
// not as "no limit". Never invents a number.
export const evaluateFulfillmentMargin = ({
  productAmountCollectedFils, shippingAmountCollectedFils, // what AJLIB actually collected, AED fils (server-authoritative, from the order row)
  cjProductCostUSD, cjShippingCostUSD, // from getCurrentCjProductCosts / resolveFreightAndLogistics
  aedToUsdRate, // display-only rate is not authoritative for money math — caller must supply a real conversion if amounts are compared cross-currency
  minAcceptableMarginPercent
}) => {
  if (minAcceptableMarginPercent == null) {
    return { approved: false, reason: 'MARGIN_THRESHOLD_NOT_CONFIGURED', details: {} };
  }
  const collectedUSD = ((productAmountCollectedFils + shippingAmountCollectedFils) / 100) * aedToUsdRate;
  const fulfillmentCostUSD = cjProductCostUSD + cjShippingCostUSD;
  const marginUSD = collectedUSD - fulfillmentCostUSD;
  const marginPercent = collectedUSD > 0 ? (marginUSD / collectedUSD) * 100 : -100;
  const approved = marginPercent >= minAcceptableMarginPercent;
  return {
    approved,
    reason: approved ? 'MARGIN_OK' : 'MARGIN_BELOW_THRESHOLD',
    details: { collectedUSD, fulfillmentCostUSD, marginUSD, marginPercent, minAcceptableMarginPercent }
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
// to 3 ("order only" — no CJ-side payment page/balance charge triggered by
// this call) since AJLIB's CJ account settlement arrangement outside this
// codebase is not something this pipeline should assume or trigger.
export const buildCjOrderPayload = ({
  ajlibOrderNumber, resolvedItems, logisticName,
  shippingCountryCode, shippingCountry, shippingProvince, shippingCity,
  shippingCustomerName, shippingAddress, shippingAddress2, shippingZip, shippingPhone,
  email
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
  payType: 3, // "order only" — does not trigger a CJ-side payment/balance charge
  products: resolvedItems.map(item => ({ vid: item.cjVariantId, quantity: item.quantity }))
});

// ---- Orchestration (stops BEFORE the live create-order call) --------------
// Runs the full pipeline for one paid order and returns a decision object.
// Throws FulfillmentBlockedError for any condition that must not proceed to
// order creation (unresolved variant, no logistics available, margin guard
// failed, or an order that already has a CJ reference).
export const prepareFulfillment = async (orderRow, { minAcceptableMarginPercent, aedToUsdRate } = {}) => {
  if (alreadyHasFulfillmentOrder(orderRow)) {
    throw new FulfillmentBlockedError('ALREADY_FULFILLED', { fulfillment_external_order_id: orderRow.fulfillment_external_order_id });
  }

  const { resolved, unresolved, fullyResolved } = resolveFulfillmentVariants(orderRow.items);
  if (!fullyResolved) {
    throw new FulfillmentBlockedError('UNRESOLVED_VARIANT', { unresolved });
  }

  // KNOWN GAP (confirmed, not glossed over): the orders table has no
  // dedicated `city` column — supabase-schema.sql / global-commerce-
  // migration.sql only store a flattened `shipping_address` string that
  // already has city/region/country baked in at checkout time, and neither
  // Stripe's nor Tabby's metadata preserve city as its own field either. CJ's
  // createOrderV2 requires `shippingCity` as a distinct field. Checked before
  // any cost/freight network calls, since there's no point pricing an order
  // whose payload can't be completed anyway.
  if (!orderRow.shipping_city) {
    throw new FulfillmentBlockedError('MISSING_SHIPPING_CITY', {
      note: 'orders table has no shipping_city column; not present in Stripe/Tabby metadata either — must be resolved before real order creation'
    });
  }

  const costed = await getCurrentCjProductCosts(resolved);
  if (costed.some(item => item.unitCostUSD == null)) {
    throw new FulfillmentBlockedError('MISSING_CJ_PRODUCT_COST', { costed });
  }
  const cjProductCostUSD = costed.reduce((sum, item) => sum + item.lineCostUSD, 0);

  const destinationCountryCode = orderRow.shipping_country_code;
  const { availableMethods, selection } = await resolveFreightAndLogistics({ resolvedItems: resolved, destinationCountryCode });
  if (!selection.method) {
    throw new FulfillmentBlockedError('NO_LOGISTICS_AVAILABLE', { destinationCountryCode, availableMethods, selectionReason: selection.reason });
  }

  const margin = evaluateFulfillmentMargin({
    productAmountCollectedFils: orderRow.product_amount || 0,
    shippingAmountCollectedFils: orderRow.shipping_amount || 0,
    cjProductCostUSD,
    cjShippingCostUSD: selection.cost,
    aedToUsdRate,
    minAcceptableMarginPercent
  });
  if (!margin.approved) {
    throw new FulfillmentBlockedError('FULFILLMENT_REVIEW_REQUIRED', { margin });
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
    email: orderRow.customer_email
  });

  return { ready: true, resolved, cjProductCostUSD, logistics: selection, margin, payload };
};
