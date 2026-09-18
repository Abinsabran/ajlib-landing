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
//     a CJ order. Creating it is api/_lib/fulfillment-auto.js's job (after a
//     verified payment, behind CJ_AUTO_CREATE_ENABLED) via the submitter.

import { prepareFulfillment, FulfillmentBlockedError } from './cj-fulfillment.js';

// AJLIB's own pre-CJ pipeline state, written to orders.fulfillment_status.
// Once a real CJ order exists this column carries CJ's raw status instead
// (see api/_lib/fulfillment-status.js PROVIDER_STATUS_MAP) — these values only
// describe the window between "customer paid" and "sent to CJ".
export const FULFILLMENT_STATE = Object.freeze({
  READY_FOR_CJ: 'READY_FOR_CJ',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  // Claimed (atomically, from READY_FOR_CJ) by the automatic path or the
  // admin recovery action while createOrderV2 is in flight. A row left here
  // after an unexpected failure stays blocked for manual reconciliation,
  // never retried.
  SUBMITTING: 'SUBMITTING',
  // CJ order exists, created UNPAID (payType 1); the owner must pay it in CJ.
  // The tracking sync moves it on once CJ reports the payment.
  WAITING_FOR_CJ_PAYMENT: 'WAITING_FOR_CJ_PAYMENT'
});

// Reasons that mean "a human should look at this", as opposed to a genuine
// system fault. All of them still preserve the paid order untouched.
export const REVIEW_REASONS = Object.freeze([
  'INSUFFICIENT_CJ_BALANCE',
  'CJ_BALANCE_UNAVAILABLE',
  'FULFILLMENT_REVIEW_REQUIRED',
  'MARGIN_BELOW_FLOOR',
  'MISSING_SHIPPING_CITY',
  'MISSING_SHIPPING_STREET',
  'INCOMPLETE_SHIPPING_ADDRESS',
  'MARGIN_NOT_GREEN',
  'CJ_ORDER_ALREADY_EXISTS',
  'CJ_ORDER_OUTCOME_UNKNOWN',
  'UNRESOLVED_VARIANT',
  'NO_LOGISTICS_AVAILABLE',
  'DELIVERY_PROMISE_NOT_CONFIGURED',
  'MISSING_CJ_PRODUCT_COST',
  'CJ_FREIGHT_API_ERROR',
  'CJ_COST_API_ERROR'
]);

export const patchOrder = async (orderId, patch) => {
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

// Conditional write: applies the patch only if the row still matches
// `filter` (PostgREST query conditions). Returns true when a row was updated.
// This is what makes preparation safe under concurrency: two deliveries of
// the same payment cannot both record a preparation, and a late preparation
// can never overwrite a SUBMITTING claim or an existing CJ order.
export const patchOrderIf = async (orderId, filter, patch) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return false;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&${filter}&select=id`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(patch)
  });
  if (!response.ok) return false;
  let rows = null;
  try { rows = JSON.parse(await response.text()); } catch { rows = null; }
  // PostgREST returns the updated rows; an empty array means the condition
  // no longer held (someone else changed the order first).
  return !Array.isArray(rows) || rows.length > 0;
};

// Row conditions for each kind of preparation write.
const FIRST_PREPARATION = 'fulfillment_status=is.null&fulfillment_external_order_id=is.null';
const REPREPARATION = `fulfillment_external_order_id=is.null&or=(fulfillment_status.is.null,fulfillment_status.in.(${'REVIEW_REQUIRED'},${'READY_FOR_CJ'}))`;

// A paid order only ever gets prepared once. Re-delivered Stripe events and
// repeated Tabby verifications both land here, so the guard is on the order
// row itself: any recorded fulfillment state (or an existing CJ reference)
// means preparation already happened.
export const alreadyPrepared = (orderRow) =>
  Boolean(orderRow?.fulfillment_status) || Boolean(orderRow?.fulfillment_external_order_id);

export const runFulfillmentPreparation = async (orderRow, { maxDeliveryDays, paymentMode } = {}) => {
  if (!orderRow?.id) return { ran: false, outcome: 'NO_ORDER_ROW' };
  if (alreadyPrepared(orderRow)) {
    return { ran: false, outcome: 'ALREADY_PREPARED', state: orderRow.fulfillment_status };
  }
  return prepareAndRecord(orderRow, { maxDeliveryDays, paymentMode, guard: FIRST_PREPARATION });
};

// States from which an admin may re-run preparation: never prepared, held
// for review (e.g. INSUFFICIENT_CJ_BALANCE before the wallet was funded), or
// already READY_FOR_CJ (refresh live cost/freight right before submitting).
// Never once a CJ order exists, and never while a submission is in flight.
export const REPREPARABLE_STATES = Object.freeze([null, FULFILLMENT_STATE.REVIEW_REQUIRED, FULFILLMENT_STATE.READY_FOR_CJ]);

// Admin-triggered re-preparation. Same pipeline and same recording as the
// payment-time run; the only difference is that it is allowed to run again
// for an order that was already prepared once.
export const reprepareFulfillment = async (orderRow, { maxDeliveryDays, paymentMode } = {}) => {
  if (!orderRow?.id) return { ran: false, outcome: 'NO_ORDER_ROW' };
  if (orderRow.fulfillment_external_order_id) {
    return { ran: false, outcome: 'ALREADY_SUBMITTED', cjOrderId: orderRow.fulfillment_external_order_id };
  }
  if (!REPREPARABLE_STATES.includes(orderRow.fulfillment_status ?? null)) {
    return { ran: false, outcome: 'NOT_REPREPARABLE', state: orderRow.fulfillment_status };
  }
  return prepareAndRecord(orderRow, { maxDeliveryDays, paymentMode, guard: REPREPARATION });
};

const prepareAndRecord = async (orderRow, { maxDeliveryDays, paymentMode, guard } = {}) => {
  try {
    const prepared = await prepareFulfillment(orderRow, { maxDeliveryDays, ...(paymentMode ? { paymentMode } : {}) });

    // Everything passed: variants resolved, real CJ cost and freight read,
    // a route inside the delivery promise chosen, margin in the GREEN band,
    // and the CJ wallet confirmed to cover it. The order is ready to send —
    // and deliberately is NOT sent.
    const recorded = await patchOrderIf(orderRow.id, guard, {
      fulfillment_provider: 'cj',
      fulfillment_status: FULFILLMENT_STATE.READY_FOR_CJ,
      fulfillment_external_order_number: prepared.payload.orderNumber,
      fulfillment_logistics_method: prepared.logistics.method,
      fulfillment_cost: Number(prepared.requiredUSD.toFixed(2)),
      fulfillment_currency: 'USD',
      fulfillment_last_sync_at: new Date().toISOString(),
      fulfillment_error: null
    });
    // Another delivery/attempt got there first: it owns this order now.
    if (!recorded) return { ran: false, outcome: 'ALREADY_PREPARED' };

    return { ran: true, outcome: FULFILLMENT_STATE.READY_FOR_CJ, prepared };
  } catch (error) {
    const reason = error instanceof FulfillmentBlockedError ? error.reason : 'FULFILLMENT_PREPARATION_FAILED';

    // If the block happened AFTER a route and cost were worked out (margin
    // review, or an empty wallet), keep them. An operator reviewing an
    // INSUFFICIENT_CJ_BALANCE order needs to know which route was chosen and
    // exactly how much the wallet must cover — that was already calculated
    // and must not be thrown away. Earlier blocks (e.g. missing city) have no
    // route yet, so those fields are simply left unset.
    const context = error?.details ?? {};
    const reviewFields = context.logistics?.method && Number.isFinite(context.requiredUSD)
      ? {
          fulfillment_logistics_method: context.logistics.method,
          fulfillment_cost: Number(context.requiredUSD.toFixed(2)),
          fulfillment_currency: 'USD'
        }
      : {};

    // Nothing about the customer's order changes: status stays paid, amounts
    // and items are untouched. Only the internal fulfillment fields record
    // why this one needs a human — an empty CJ wallet must never look like a
    // failed purchase.
    const recorded = await patchOrderIf(orderRow.id, guard, {
      fulfillment_provider: 'cj',
      fulfillment_status: FULFILLMENT_STATE.REVIEW_REQUIRED,
      fulfillment_error: reason,
      fulfillment_last_sync_at: new Date().toISOString(),
      ...reviewFields
    }).catch(() => null); // null = the write itself failed (e.g. database unreachable)
    // false = another attempt already owns this order; a failed write is still
    // reported as REVIEW_REQUIRED (nothing proceeds to CJ from here).
    if (recorded === false) return { ran: false, outcome: 'ALREADY_PREPARED' };

    return { ran: true, outcome: FULFILLMENT_STATE.REVIEW_REQUIRED, reason, reviewFields };
  }
};
