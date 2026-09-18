// Automatic CJ order creation after a VERIFIED AJLIB payment.
//
// Called from persistPaidOrder (api/stripe-webhook.js) — the single path both
// Stripe's signed webhook and Tabby's server-side verification go through;
// a redirect alone never reaches it. After preparation has marked the order
// READY_FOR_CJ, and only when CJ_AUTO_CREATE_ENABLED=true in 'manual' payment
// mode, it:
//   claims the order (READY_FOR_CJ -> SUBMITTING, atomic: a duplicate webhook
//   or a concurrent attempt cannot also claim it)
//   -> submitReadyOrder (GREEN margin, no existing CJ order, createOrderV2
//      payType 1 = unpaid, persist the CJ id, WAITING_FOR_CJ_PAYMENT)
//   -> alerts the owner to pay that order in CJ (or to review it).
// With the switch off, the order simply stays READY_FOR_CJ.
//
// Never throws: the customer's payment is already confirmed and saved.

import { isAutoCreateEnabled } from './cj-client.js';
import { CJ_PAYMENT_MODE } from './cj-fulfillment.js';
import { FULFILLMENT_STATE } from './fulfillment-runner.js';
import { submitReadyOrder, SUBMIT_OUTCOME } from './fulfillment-submitter.js';
import { sendOwnerAlert } from './owner-alerts.js';

const db = (path, options = {}) => fetch(`${process.env.SUPABASE_URL}${path}`, {
  ...options,
  headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
});

// Atomic claim: succeeds only if the row is STILL READY_FOR_CJ with no CJ id.
export const claimForSubmission = async (orderId) => {
  const response = await db(
    `/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&fulfillment_status=eq.${FULFILLMENT_STATE.READY_FOR_CJ}&fulfillment_external_order_id=is.null&select=id`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ fulfillment_status: FULFILLMENT_STATE.SUBMITTING, fulfillment_last_sync_at: new Date().toISOString() }) }
  );
  if (!response.ok) return false;
  const rows = await response.json();
  return Array.isArray(rows) && rows.length === 1;
};

// Only ever releases our OWN claim, and only while it is still SUBMITTING.
export const releaseClaim = (orderId) => db(
  `/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&fulfillment_status=eq.${FULFILLMENT_STATE.SUBMITTING}&fulfillment_external_order_id=is.null`,
  { method: 'PATCH', body: JSON.stringify({ fulfillment_status: FULFILLMENT_STATE.READY_FOR_CJ }) }
);

const REVIEW_OUTCOMES = [SUBMIT_OUTCOME.BLOCKED_ON_RECHECK, SUBMIT_OUTCOME.REVIEW_REQUIRED];

// Creates the CJ order for one claimed-or-claimable order and alerts the
// owner. Shared by the automatic path and the admin recovery action.
export const createAndAlert = async (orderRow, { maxDeliveryDays, prepared, alreadyClaimed = false } = {}) => {
  if (!alreadyClaimed && !(await claimForSubmission(orderRow.id))) return { created: false, outcome: 'NOT_CLAIMED' };
  let result;
  try {
    result = await submitReadyOrder({ ...orderRow, fulfillment_status: FULFILLMENT_STATE.READY_FOR_CJ }, { maxDeliveryDays, prepared });
  } catch {
    // Unknown outcome: the row deliberately stays SUBMITTING, which blocks
    // every further attempt until a human reconciles it against CJ.
    await sendOwnerAlert('REVIEW_REQUIRED', orderRow, { reason: 'SUBMISSION_OUTCOME_UNKNOWN' });
    return { created: false, outcome: 'SUBMISSION_OUTCOME_UNKNOWN' };
  }
  if (result.outcome === SUBMIT_OUTCOME.LIVE_ORDER_CREATION_DISABLED) await releaseClaim(orderRow.id);
  if (result.submitted && result.paid === false) {
    await sendOwnerAlert('PAY_CJ_ORDER', orderRow, result);
  } else if (REVIEW_OUTCOMES.includes(result.outcome)) {
    await sendOwnerAlert('REVIEW_REQUIRED', orderRow, { reason: result.reason });
  }
  return { created: Boolean(result.submitted), ...result };
};

// A paid order that preparation held for review (missing address field,
// unmapped variant, non-GREEN margin, no route...) is announced to the owner
// once automation is on — otherwise it would wait silently.
export const alertPreparationReview = async (orderRow, reason) => {
  if (!isAutoCreateEnabled()) return { sent: false, reason: 'AUTO_CREATE_DISABLED' };
  return sendOwnerAlert('REVIEW_REQUIRED', orderRow, { reason });
};

export const autoCreateAfterPayment = async (orderRow, { maxDeliveryDays, prepared } = {}) => {
  try {
    if (!isAutoCreateEnabled()) return { created: false, outcome: 'AUTO_CREATE_DISABLED' };
    if (CJ_PAYMENT_MODE !== 'manual') return { created: false, outcome: 'AUTO_CREATE_REQUIRES_MANUAL_PAYMENT_MODE' };
    if (!orderRow?.id || orderRow.fulfillment_external_order_id) return { created: false, outcome: SUBMIT_OUTCOME.ALREADY_SUBMITTED };
    return await createAndAlert(orderRow, { maxDeliveryDays, prepared });
  } catch {
    return { created: false, outcome: 'AUTO_CREATE_FAILED' };
  }
};
