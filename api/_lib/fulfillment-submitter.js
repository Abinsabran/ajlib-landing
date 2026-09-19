// Creates the CJ order for ONE order that is READY_FOR_CJ. This is the only
// caller of createFulfillmentOrder.
//
// LAUNCH MODEL ('manual' payment mode, the default): the CJ order is created
// UNPAID with createOrderV2 payType 1 (CJ's "page payment": nothing is
// deducted, a cjPayUrl is returned) and the owner pays that order in CJ. The
// order is then WAITING_FOR_CJ_PAYMENT until the tracking sync sees CJ's
// payment. 'balance' mode (payType 2, wallet-paid) is kept as an option only.
//
//   READY_FOR_CJ
//     -> creation switch     (payType 1: CJ_AUTO_CREATE_ENABLED;
//                             payType 2: CJ_LIVE_ORDER_CREATION_ENABLED)
//     -> fresh preparation   (variants, address, cost, freight, route, margin;
//                             the wallet only in balance mode) unless the
//                             caller passes the preparation it just ran
//     -> margin must be GREEN
//     -> no CJ order may already exist under AJLIB-<order_number>
//     -> createOrderV2
//     -> persist the CJ order id (+ WAITING_FOR_CJ_PAYMENT, cjPayUrl)
//     -> on any doubt: read-only reconciliation, never a blind retry
//
// Callers (api/_lib/fulfillment-auto.js after a verified payment, and the
// admin recovery action) claim the order first (READY_FOR_CJ -> SUBMITTING)
// so two attempts can never both reach createOrderV2.
//
// It never throws for business outcomes; every path returns an outcome and,
// where appropriate, records it on the order for an operator.

import { createFulfillmentOrder, isCreationAllowedFor, creationFlagFor, isCjErrorBody, findOrderByOrderNumber, LiveOrderCreationDisabledError } from './cj-client.js';
import { prepareFulfillment, reconcileAfterTimeout, FulfillmentBlockedError, cjOrderNumberFor, CJ_PAYMENT_MODE, payTypeForMode, isCjOrderPaid } from './cj-fulfillment.js';
import { patchOrder, FULFILLMENT_STATE } from './fulfillment-runner.js';
import { MARGIN_BANDS } from './logistics-policy.js';

export const SUBMIT_OUTCOME = Object.freeze({
  LIVE_ORDER_CREATION_DISABLED: 'LIVE_ORDER_CREATION_DISABLED', // the creation switch for this payType is off
  NOT_READY: 'NOT_READY',
  ALREADY_SUBMITTED: 'ALREADY_SUBMITTED',
  BLOCKED_ON_RECHECK: 'BLOCKED_ON_RECHECK',
  CREATED_AWAITING_PAYMENT: 'CREATED_AWAITING_PAYMENT', // manual mode: CJ order exists, unpaid
  SUBMITTED: 'SUBMITTED', // balance mode: created and paid from the wallet
  RECONCILED_ALREADY_PAID: 'RECONCILED_ALREADY_PAID',
  RECONCILED_AWAITING_PAYMENT: 'RECONCILED_AWAITING_PAYMENT',
  NOT_CREATED_SAFE_TO_RETRY: 'NOT_CREATED_SAFE_TO_RETRY',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
});

// CJ's createOrderV2 success body carries data.orderId and, for payType 1,
// data.cjPayUrl (per CJ's docs). A success body WITHOUT an id is treated as
// "outcome unknown" and reconciled — never assumed to have failed.
const cjOrderIdFrom = (body) => body?.data?.orderId ?? null;

const now = () => new Date().toISOString();

// Records a CJ order that now exists. Unpaid (manual mode) -> the customer's
// order moves from "Order received" to "Preparing your order"; paid -> CJ's
// own status is recorded as before.
const recordCreated = (orderRow, { cjOrderId, paid, cjStatus, paymentDate, payUrl, prepared }) => patchOrder(orderRow.id, {
  fulfillment_external_order_id: cjOrderId,
  fulfillment_status: paid ? (cjStatus || 'UNSHIPPED') : FULFILLMENT_STATE.WAITING_FOR_CJ_PAYMENT,
  ...(payUrl ? { fulfillment_payment_url: payUrl } : {}),
  ...(paid && paymentDate ? { fulfillment_cj_paid_at: paymentDate } : {}),
  ...(prepared ? { fulfillment_logistics_method: prepared.logistics.method, fulfillment_cost: Number(prepared.requiredUSD.toFixed(2)), fulfillment_currency: 'USD' } : {}),
  ...(orderRow.status === 'paid' ? { status: 'processing' } : {}),
  fulfillment_last_sync_at: now(),
  fulfillment_error: null
});

const recordReview = (orderRow, reason, extra = {}) => patchOrder(orderRow.id, {
  fulfillment_status: FULFILLMENT_STATE.REVIEW_REQUIRED,
  fulfillment_error: reason,
  fulfillment_last_sync_at: now(),
  ...extra
});

// Called whenever the result of createOrderV2 is not a clean, confirmed
// success: a timeout, a network failure, a business error, or a success body
// without an order id. Only CJ's own records can say what happened, so ask
// them read-only.
const resolveUncertainOutcome = async (orderRow, trigger, { paymentMode, prepared }) => {
  const r = await reconcileAfterTimeout(orderRow.order_number);

  if (r.outcome === 'ALREADY_PAID') {
    await recordCreated(orderRow, { cjOrderId: r.cjOrderId, paid: true, cjStatus: r.status, paymentDate: r.paymentDate, prepared });
    return { submitted: true, outcome: SUBMIT_OUTCOME.RECONCILED_ALREADY_PAID, trigger, cjOrderId: r.cjOrderId };
  }

  if (r.outcome === 'EXISTS_UNPAID' && paymentMode === 'manual') {
    // In the manual model an unpaid CJ order IS the intended result.
    await recordCreated(orderRow, { cjOrderId: r.cjOrderId, paid: false, prepared });
    return { submitted: true, outcome: SUBMIT_OUTCOME.RECONCILED_AWAITING_PAYMENT, trigger, cjOrderId: r.cjOrderId, paid: false };
  }

  if (r.outcome === 'NOT_FOUND') {
    // Nothing was created. Safe to try again — but NOT automatically here:
    // the order goes back to READY_FOR_CJ with the reason recorded.
    await patchOrder(orderRow.id, { fulfillment_status: FULFILLMENT_STATE.READY_FOR_CJ, fulfillment_error: `NOT_CREATED:${trigger}`, fulfillment_last_sync_at: now() });
    return { submitted: false, outcome: SUBMIT_OUTCOME.NOT_CREATED_SAFE_TO_RETRY, trigger };
  }

  // UNKNOWN (CJ unreadable), or EXISTS_UNPAID in wallet mode: a human decides.
  const reason = r.outcome === 'EXISTS_UNPAID' ? 'CJ_ORDER_EXISTS_UNPAID' : 'CJ_ORDER_OUTCOME_UNKNOWN';
  await recordReview(orderRow, reason);
  return { submitted: false, outcome: SUBMIT_OUTCOME.REVIEW_REQUIRED, reason, trigger };
};

export const submitReadyOrder = async (orderRow, { maxDeliveryDays, timeoutMs, paymentMode = CJ_PAYMENT_MODE, prepared: preparedByCaller } = {}) => {
  // 1. The creation switch comes first — before any read or network call.
  const payType = payTypeForMode(paymentMode);
  if (!isCreationAllowedFor(payType)) {
    return { submitted: false, outcome: SUBMIT_OUTCOME.LIVE_ORDER_CREATION_DISABLED, flag: creationFlagFor(payType) };
  }

  // 2. Idempotency on our side: a CJ reference means a CJ order exists.
  if (orderRow?.fulfillment_external_order_id) {
    return { submitted: false, outcome: SUBMIT_OUTCOME.ALREADY_SUBMITTED, cjOrderId: orderRow.fulfillment_external_order_id };
  }
  if (orderRow?.fulfillment_status !== FULFILLMENT_STATE.READY_FOR_CJ) {
    return { submitted: false, outcome: SUBMIT_OUTCOME.NOT_READY, state: orderRow?.fulfillment_status ?? null };
  }

  // 3. Preparation: reuse the one the caller ran moments ago for this same
  //    order, otherwise re-check everything with fresh CJ data.
  let prepared = preparedByCaller?.payload?.orderNumber === cjOrderNumberFor(orderRow.order_number) ? preparedByCaller : null;
  if (!prepared) {
    try {
      prepared = await prepareFulfillment(orderRow, { maxDeliveryDays, paymentMode });
    } catch (error) {
      const reason = error instanceof FulfillmentBlockedError ? error.reason : 'FULFILLMENT_RECHECK_FAILED';
      await recordReview(orderRow, reason);
      return { submitted: false, outcome: SUBMIT_OUTCOME.BLOCKED_ON_RECHECK, reason };
    }
  }
  if (prepared.payload.payType !== payType) {
    await recordReview(orderRow, 'PAYMENT_MODE_MISMATCH');
    return { submitted: false, outcome: SUBMIT_OUTCOME.BLOCKED_ON_RECHECK, reason: 'PAYMENT_MODE_MISMATCH' };
  }

  // 4. Automatic creation needs the profit guard passed on the economics
  //    re-checked just now (>= 25% true net margin AND >= 30 AED net
  //    profit), whatever else is configured.
  if (!prepared.margin?.approved || prepared.margin?.band !== MARGIN_BANDS.GREEN) {
    const reason = prepared.margin?.approved === false && prepared.margin.reason ? prepared.margin.reason : 'MARGIN_NOT_GREEN';
    await recordReview(orderRow, reason);
    return { submitted: false, outcome: SUBMIT_OUTCOME.BLOCKED_ON_RECHECK, reason };
  }

  // 5. Idempotency on CJ's side: never create a second order under the same
  //    deterministic number. If CJ can't be read, do not create.
  let existing;
  try {
    existing = await findOrderByOrderNumber(prepared.payload.orderNumber);
  } catch {
    await recordReview(orderRow, 'CJ_ORDER_LOOKUP_FAILED');
    return { submitted: false, outcome: SUBMIT_OUTCOME.REVIEW_REQUIRED, reason: 'CJ_ORDER_LOOKUP_FAILED' };
  }
  if (existing) {
    // Record the id so nothing can create another one; a human confirms it.
    await recordReview(orderRow, 'CJ_ORDER_ALREADY_EXISTS', { fulfillment_external_order_id: existing.orderId ?? null });
    return { submitted: false, outcome: SUBMIT_OUTCOME.REVIEW_REQUIRED, reason: 'CJ_ORDER_ALREADY_EXISTS', cjOrderId: existing.orderId ?? null, paid: isCjOrderPaid(existing) };
  }

  // 6. Create.
  let response;
  try {
    response = await createFulfillmentOrder(prepared.payload, { timeoutMs });
  } catch (error) {
    if (error instanceof LiveOrderCreationDisabledError) {
      return { submitted: false, outcome: SUBMIT_OUTCOME.LIVE_ORDER_CREATION_DISABLED, flag: error.flag };
    }
    // Timeout or network failure: the outcome is unknown, NOT failed.
    return resolveUncertainOutcome(orderRow, error?.code || 'CJ_REQUEST_FAILED', { paymentMode, prepared });
  }

  const cjOrderId = cjOrderIdFrom(response.body);
  if (!isCjErrorBody(response.body) && cjOrderId) {
    const paid = paymentMode === 'balance';
    const payUrl = response.body?.data?.cjPayUrl || null;
    await recordCreated(orderRow, { cjOrderId, paid, cjStatus: response.body?.data?.orderStatus, payUrl, prepared });
    return {
      submitted: true,
      outcome: paid ? SUBMIT_OUTCOME.SUBMITTED : SUBMIT_OUTCOME.CREATED_AWAITING_PAYMENT,
      cjOrderId, paid, payUrl,
      route: prepared.logistics.method, requiredUSD: Number(prepared.requiredUSD.toFixed(2)),
      units: prepared.resolved.reduce((n, item) => n + item.quantity, 0)
    };
  }

  // A business error is not proof of failure, and a success without an id
  // is not proof of success.
  return resolveUncertainOutcome(orderRow, isCjErrorBody(response.body) ? `CJ_BUSINESS_ERROR_${response.body?.code}` : 'CJ_SUCCESS_WITHOUT_ORDER_ID', { paymentMode, prepared });
};
