// Sends ONE order that is already READY_FOR_CJ to CJ, paying from the CJ
// Balance (payType=2). This is the only caller of createFulfillmentOrder, the
// only code in the project that can spend CJ money.
//
//   READY_FOR_CJ
//     -> safety flag      (CJ_LIVE_ORDER_CREATION_ENABLED must be "true")
//     -> fresh re-check   (cost, freight, delivery promise, margin, balance)
//     -> createOrderV2    (payType=2: create + confirm + pay, irreversible)
//     -> persist the CJ order reference
//     -> on any doubt: read-only reconciliation, never a blind retry
//
// DELIBERATELY NOT TRIGGERED AUTOMATICALLY. Nothing calls this yet — not the
// payment webhook, not an endpoint. What should trigger it (an operator
// action, or a scheduled pass over READY_FOR_CJ orders) is an open decision.
// Keeping it out of the payment webhook also keeps a slow CJ call from ever
// sitting inside a customer's payment request.
//
// It never throws for business outcomes; every path returns an outcome and,
// where appropriate, records it on the order for an operator.

import { createFulfillmentOrder, isLiveOrderCreationEnabled, isCjErrorBody, LiveOrderCreationDisabledError } from './cj-client.js';
import { prepareFulfillment, reconcileAfterTimeout, FulfillmentBlockedError } from './cj-fulfillment.js';
import { patchOrder, FULFILLMENT_STATE } from './fulfillment-runner.js';

export const SUBMIT_OUTCOME = Object.freeze({
  LIVE_ORDER_CREATION_DISABLED: 'LIVE_ORDER_CREATION_DISABLED',
  NOT_READY: 'NOT_READY',
  ALREADY_SUBMITTED: 'ALREADY_SUBMITTED',
  BLOCKED_ON_RECHECK: 'BLOCKED_ON_RECHECK',
  SUBMITTED: 'SUBMITTED',
  RECONCILED_ALREADY_PAID: 'RECONCILED_ALREADY_PAID',
  NOT_CREATED_SAFE_TO_RETRY: 'NOT_CREATED_SAFE_TO_RETRY',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
});

// CJ's createOrderV2 success body is expected to carry the new CJ order id in
// data.orderId (per CJ's docs). This is confirmed on the first real order; if
// the shape differs, a success body WITHOUT an id is treated as "outcome
// unknown" and resolved by reconciliation — never assumed to have failed.
const cjOrderIdFrom = (body) => body?.data?.orderId ?? null;

const recordSubmitted = (orderRow, { cjOrderId, cjStatus }) => patchOrder(orderRow.id, {
  fulfillment_external_order_id: cjOrderId,
  fulfillment_status: cjStatus || 'CREATED',
  fulfillment_last_sync_at: new Date().toISOString(),
  fulfillment_error: null
});

const recordReview = (orderRow, reason) => patchOrder(orderRow.id, {
  fulfillment_status: FULFILLMENT_STATE.REVIEW_REQUIRED,
  fulfillment_error: reason,
  fulfillment_last_sync_at: new Date().toISOString()
});

// Called whenever the result of createOrderV2 is not a clean, confirmed
// success: a timeout, a network failure, a business error (including CJ's
// "already paid"), or a success body without an order id. The money may or
// may not have moved; only CJ's own records can say, so ask them read-only.
const resolveUncertainOutcome = async (orderRow, trigger) => {
  const r = await reconcileAfterTimeout(orderRow.order_number);

  if (r.outcome === 'ALREADY_PAID') {
    await recordSubmitted(orderRow, { cjOrderId: r.cjOrderId, cjStatus: r.status });
    return { submitted: true, outcome: SUBMIT_OUTCOME.RECONCILED_ALREADY_PAID, trigger, cjOrderId: r.cjOrderId };
  }

  if (r.outcome === 'NOT_FOUND') {
    // Nothing was created and nothing was charged. Safe to try again later —
    // but NOT automatically here. The order stays READY_FOR_CJ; the reason
    // is recorded so an operator can see why the attempt didn't land.
    await patchOrder(orderRow.id, { fulfillment_error: `NOT_CREATED:${trigger}`, fulfillment_last_sync_at: new Date().toISOString() });
    return { submitted: false, outcome: SUBMIT_OUTCOME.NOT_CREATED_SAFE_TO_RETRY, trigger };
  }

  // EXISTS_UNPAID (order created but not paid) or UNKNOWN (CJ unreadable).
  // Either way a retry could double-charge, so a human must decide.
  const reason = r.outcome === 'EXISTS_UNPAID' ? 'CJ_ORDER_EXISTS_UNPAID' : 'CJ_ORDER_OUTCOME_UNKNOWN';
  await recordReview(orderRow, reason);
  return { submitted: false, outcome: SUBMIT_OUTCOME.REVIEW_REQUIRED, reason, trigger };
};

export const submitReadyOrder = async (orderRow, { maxDeliveryDays, timeoutMs } = {}) => {
  // 1. The flag comes first — before any read, any network call, anything.
  if (!isLiveOrderCreationEnabled()) {
    return { submitted: false, outcome: SUBMIT_OUTCOME.LIVE_ORDER_CREATION_DISABLED };
  }

  // 2. Idempotency: an order with a CJ reference already has a CJ order.
  if (orderRow?.fulfillment_external_order_id) {
    return { submitted: false, outcome: SUBMIT_OUTCOME.ALREADY_SUBMITTED, cjOrderId: orderRow.fulfillment_external_order_id };
  }
  if (orderRow?.fulfillment_status !== FULFILLMENT_STATE.READY_FOR_CJ) {
    return { submitted: false, outcome: SUBMIT_OUTCOME.NOT_READY, state: orderRow?.fulfillment_status ?? null };
  }

  // 3. Re-check everything with fresh CJ data. Time has passed since the
  //    order was marked READY: cost, freight or the wallet may have moved.
  let prepared;
  try {
    prepared = await prepareFulfillment(orderRow, { maxDeliveryDays });
  } catch (error) {
    const reason = error instanceof FulfillmentBlockedError ? error.reason : 'FULFILLMENT_RECHECK_FAILED';
    await recordReview(orderRow, reason);
    return { submitted: false, outcome: SUBMIT_OUTCOME.BLOCKED_ON_RECHECK, reason };
  }

  // 4. The irreversible call.
  let response;
  try {
    response = await createFulfillmentOrder(prepared.payload, { timeoutMs });
  } catch (error) {
    if (error instanceof LiveOrderCreationDisabledError) {
      return { submitted: false, outcome: SUBMIT_OUTCOME.LIVE_ORDER_CREATION_DISABLED };
    }
    // Timeout or network failure: the outcome is unknown, NOT failed.
    return resolveUncertainOutcome(orderRow, error?.code || 'CJ_REQUEST_FAILED');
  }

  const cjOrderId = cjOrderIdFrom(response.body);
  if (!isCjErrorBody(response.body) && cjOrderId) {
    await recordSubmitted(orderRow, { cjOrderId, cjStatus: response.body?.data?.orderStatus });
    return { submitted: true, outcome: SUBMIT_OUTCOME.SUBMITTED, cjOrderId };
  }

  // A business error (e.g. CJ reporting the order as already paid) is not
  // proof of failure, and a success without an id is not proof of success.
  return resolveUncertainOutcome(orderRow, isCjErrorBody(response.body) ? `CJ_BUSINESS_ERROR_${response.body?.code}` : 'CJ_SUCCESS_WITHOUT_ORDER_ID');
};
