// Runs the fulfillment preparation pipeline for one already-persisted paid
// order, and records the outcome on the order row.
//
// This is the ONLY place that connects payment to fulfillment, and both
// providers reach it through the same call in persistPaidOrder — Stripe and
// Tabby do not each carry their own copy.
//
// TWO RULES GOVERN EVERYTHING HERE:
//
//  1. It must NEVER throw. The customer has already paid and the order is
//     already saved; a fulfillment problem is an internal condition to be
//     recorded for an operator, never something that fails the payment
//     response or rolls anything back.
//
//  2. It stops BEFORE createOrderV2. Success here means "this order is ready
//     to be sent to CJ", not "sent". Nothing in this file can create or pay
//     a CJ order — see lib/cj-client.js createFulfillmentOrder, still disabled.

import { prepareFulfillment, FulfillmentBlockedError } from './cj-fulfillment.js';

// AJLIB's own pre-CJ pipeline state, written to orders.fulfillment_status.
// Once a real CJ order exists this column carries CJ's raw status instead
// (see lib/fulfillment-status.js PROVIDER_STATUS_MAP) — these values only
// describe the window between "customer paid" and "sent to CJ".
export const FULFILLMENT_STATE = Object.freeze({
  READY_FOR_CJ: 'READY_FOR_CJ',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
});

// Reasons that mean "a human should look at this", as opposed to a genuine
// system fault. All of them still preserve the paid order untouched.
export const REVIEW_REASONS = Object.freeze([
  'INSUFFICIENT_CJ_BALANCE',
  'CJ_BALANCE_UNAVAILABLE',
  'FULFILLMENT_REVIEW_REQUIRED',
  'MARGIN_BELOW_FLOOR',
  'MISSING_SHIPPING_CITY',
  'UNRESOLVED_VARIANT',
  'NO_LOGISTICS_AVAILABLE',
  'DELIVERY_PROMISE_NOT_CONFIGURED',
  'MISSING_CJ_PRODUCT_COST',
  'CJ_FREIGHT_API_ERROR',
  'CJ_COST_API_ERROR'
]);

const patchOrder = async (orderId, patch) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return false;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
  return response.ok;
};

// A paid order only ever gets prepared once. Re-delivered Stripe events and
// repeated Tabby verifications both land here, so the guard is on the order
// row itself: any recorded fulfillment state (or an existing CJ reference)
// means preparation already happened.
export const alreadyPrepared = (orderRow) =>
  Boolean(orderRow?.fulfillment_status) || Boolean(orderRow?.fulfillment_external_order_id);

export const runFulfillmentPreparation = async (orderRow, { maxDeliveryDays } = {}) => {
  if (!orderRow?.id) return { ran: false, outcome: 'NO_ORDER_ROW' };
  if (alreadyPrepared(orderRow)) {
    return { ran: false, outcome: 'ALREADY_PREPARED', state: orderRow.fulfillment_status };
  }

  try {
    const prepared = await prepareFulfillment(orderRow, { maxDeliveryDays });

    // Everything passed: variants resolved, real CJ cost and freight read,
    // a route inside the delivery promise chosen, margin in the GREEN band,
    // and the CJ wallet confirmed to cover it. The order is ready to send —
    // and deliberately is NOT sent.
    await patchOrder(orderRow.id, {
      fulfillment_provider: 'cj',
      fulfillment_status: FULFILLMENT_STATE.READY_FOR_CJ,
      fulfillment_external_order_number: prepared.payload.orderNumber,
      fulfillment_logistics_method: prepared.logistics.method,
      fulfillment_cost: Number(prepared.requiredUSD.toFixed(2)),
      fulfillment_currency: 'USD',
      fulfillment_last_sync_at: new Date().toISOString(),
      fulfillment_error: null
    });

    return { ran: true, outcome: FULFILLMENT_STATE.READY_FOR_CJ, prepared };
  } catch (error) {
    const reason = error instanceof FulfillmentBlockedError ? error.reason : 'FULFILLMENT_PREPARATION_FAILED';

    // Nothing about the customer's order changes: status stays paid, amounts
    // and items are untouched. Only the internal fulfillment fields record
    // why this one needs a human — an empty CJ wallet must never look like a
    // failed purchase.
    await patchOrder(orderRow.id, {
      fulfillment_provider: 'cj',
      fulfillment_status: FULFILLMENT_STATE.REVIEW_REQUIRED,
      fulfillment_error: reason,
      fulfillment_last_sync_at: new Date().toISOString()
    }).catch(() => false);

    return { ran: true, outcome: FULFILLMENT_STATE.REVIEW_REQUIRED, reason };
  }
};
