// Admin-only CJ fulfillment RECOVERY tools, served as /api/admin-fulfillment
// (dispatched from api/commerce.js to stay within the function budget).
// Normal paid orders reach CJ automatically (api/_lib/fulfillment-auto.js);
// these actions exist to inspect, recover and retry — never as the normal path.
//
// POST { action, order_id, confirm_order_number? } with the signed-in admin's
// Supabase access token as "Authorization: Bearer <token>". Customers and
// anonymous callers are refused before any order is read.
//
//   status         read-only view of one order's fulfillment fields
//   reprepare      re-run live preparation (variants, address, cost, freight,
//                  route, margin) for an order not yet with CJ — e.g. one held
//                  in REVIEW_REQUIRED after the cause was fixed
//   create         create the CJ order for ONE READY_FOR_CJ order, exactly as
//                  the automatic path would (unpaid, payType 1). Requires the
//                  creation switch (CJ_AUTO_CREATE_ENABLED=true) and
//                  confirm_order_number equal to the order's number; only one
//                  order at a time. ('submit' is accepted as an alias.)
//   sync-tracking  read-only CJ order detail + tracking poll for one order
//
// Nothing here is reachable from the Stripe or Tabby payment paths.

import { quoteShipping } from '../shipping-quote.js';
import { isCreationAllowedFor, creationFlagFor } from './cj-client.js';
import { payTypeForMode, CJ_PAYMENT_MODE } from './cj-fulfillment.js';
import { FULFILLMENT_STATE, reprepareFulfillment } from './fulfillment-runner.js';
import { SUBMIT_OUTCOME } from './fulfillment-submitter.js';
import { claimForSubmission, releaseClaim, createAndAlert } from './fulfillment-auto.js';
import { syncTracking } from './fulfillment-tracking.js';

const json = { 'Content-Type': 'application/json' };
const serviceHeaders = () => ({ apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`, ...json });
const db = (path, options = {}) => fetch(`${process.env.SUPABASE_URL}${path}`, { ...options, headers: { ...serviceHeaders(), ...(options.headers || {}) } });

const bearer = (req) => String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();

// Same check as the other admin APIs: the caller's own token must satisfy
// public.is_admin() (profiles.role admin/owner, controlled by the database).
const isAdmin = async (token) => {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/is_admin`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, ...json },
    body: '{}'
  });
  return response.ok && (await response.json()) === true;
};

const loadOrder = async (id) => {
  const response = await db(`/rest/v1/orders?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!response.ok) throw new Error('Order lookup failed');
  return (await response.json())[0] || null;
};

const maxDaysFor = async (countryCode) => {
  try { return (await quoteShipping(countryCode)).max_days; } catch { return undefined; }
};

const summary = (order) => ({
  id: order.id,
  order_number: order.order_number,
  status: order.status,
  items: order.items,
  shipping_country_code: order.shipping_country_code,
  shipping_city: order.shipping_city,
  shipping_street: order.shipping_street ?? null,
  product_amount: order.product_amount,
  shipping_amount: order.shipping_amount,
  payment_mode: CJ_PAYMENT_MODE,
  fulfillment_status: order.fulfillment_status ?? null,
  fulfillment_error: order.fulfillment_error ?? null,
  fulfillment_logistics_method: order.fulfillment_logistics_method ?? null,
  fulfillment_cost_usd: order.fulfillment_cost ?? null,
  fulfillment_external_order_number: order.fulfillment_external_order_number ?? null,
  fulfillment_external_order_id: order.fulfillment_external_order_id ?? null,
  fulfillment_payment_url: order.fulfillment_payment_url ?? null,
  fulfillment_cj_paid_at: order.fulfillment_cj_paid_at ?? null,
  fulfillment_alert_sent_at: order.fulfillment_alert_sent_at ?? null,
  fulfillment_tracking_number: order.fulfillment_tracking_number ?? null,
  fulfillment_last_sync_at: order.fulfillment_last_sync_at ?? null
});

const submittingOrders = async () => {
  const response = await db(`/rest/v1/orders?fulfillment_status=eq.${FULFILLMENT_STATE.SUBMITTING}&select=id`);
  if (!response.ok) throw new Error('Submission lock lookup failed');
  return response.json();
};

const reprepare = async (order) => {
  const result = await reprepareFulfillment(order, { maxDeliveryDays: await maxDaysFor(order.shipping_country_code) });
  if (!result.ran) return { status: 409, body: { outcome: result.outcome, state: result.state ?? null } };
  const prepared = result.prepared;
  return {
    status: 200,
    body: {
      outcome: result.outcome, // READY_FOR_CJ | REVIEW_REQUIRED
      reason: result.reason ?? null,
      paymentMode: prepared?.paymentMode ?? CJ_PAYMENT_MODE,
      route: prepared ? { method: prepared.logistics.method, agingDays: prepared.logistics.agingDays, costUSD: prepared.logistics.cost, reason: prepared.logistics.reason } : (result.reviewFields?.fulfillment_logistics_method ?? null),
      requiredUSD: prepared ? Number(prepared.requiredUSD.toFixed(2)) : (result.reviewFields?.fulfillment_cost ?? null),
      margin: prepared ? { band: prepared.margin.band, percent: Number(prepared.margin.details.marginPercent.toFixed(2)) } : null,
      // Only read in 'balance' mode; null in the launch 'manual' mode.
      balance: prepared?.balance ? { availableUSD: prepared.balance.balanceUSD, sufficient: prepared.balance.sufficient, lowBalanceWarning: prepared.balance.lowBalanceWarning, remainingAfterUSD: Number(prepared.balance.remainingAfterUSD.toFixed(2)) } : null,
      payload: prepared?.payload ?? null // exactly what create would send, for review
    }
  };
};

const create = async (order, confirmOrderNumber) => {
  // Switch first: with it off, nothing is claimed and nothing is called.
  const payType = payTypeForMode();
  if (!isCreationAllowedFor(payType)) return { status: 409, body: { outcome: SUBMIT_OUTCOME.LIVE_ORDER_CREATION_DISABLED, flag: creationFlagFor(payType) } };
  if (String(confirmOrderNumber || '') !== String(order.order_number)) return { status: 400, body: { outcome: 'CONFIRMATION_MISMATCH' } };
  if (order.fulfillment_external_order_id) return { status: 409, body: { outcome: SUBMIT_OUTCOME.ALREADY_SUBMITTED, cjOrderId: order.fulfillment_external_order_id } };
  if (order.fulfillment_status !== FULFILLMENT_STATE.READY_FOR_CJ) return { status: 409, body: { outcome: SUBMIT_OUTCOME.NOT_READY, state: order.fulfillment_status ?? null } };

  // Manual recovery runs one order at a time across the whole store.
  if ((await submittingOrders()).length > 0) return { status: 409, body: { outcome: 'ANOTHER_SUBMISSION_IN_PROGRESS' } };
  if (!(await claimForSubmission(order.id))) return { status: 409, body: { outcome: 'CLAIM_FAILED' } };
  if ((await submittingOrders()).length > 1) {
    await releaseClaim(order.id);
    return { status: 409, body: { outcome: 'ANOTHER_SUBMISSION_IN_PROGRESS' } };
  }

  // Same code as the automatic path: fresh re-check, GREEN margin, no existing
  // CJ order, createOrderV2, persist the id, alert the owner to pay.
  const result = await createAndAlert(order, { maxDeliveryDays: await maxDaysFor(order.shipping_country_code), alreadyClaimed: true });
  if (result.outcome === 'SUBMISSION_OUTCOME_UNKNOWN') {
    return { status: 500, body: { outcome: 'SUBMISSION_OUTCOME_UNKNOWN', note: 'Order left in SUBMITTING for manual reconciliation; do not retry.' } };
  }

  // Belt and braces: the CJ id must be on the row, or the next attempt could not see it.
  if (result.cjOrderId) {
    const after = await loadOrder(order.id);
    if (after && !after.fulfillment_external_order_id) {
      await db(`/rest/v1/orders?id=eq.${encodeURIComponent(order.id)}`, { method: 'PATCH', body: JSON.stringify({ fulfillment_external_order_id: result.cjOrderId, fulfillment_last_sync_at: new Date().toISOString() }) });
    }
  }
  return { status: 200, body: result };
};

export const handleAdminFulfillment = async (req, res) => {
  res.setHeader?.('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  try {
    if (!(await isAdmin(token))) return res.status(403).json({ error: 'هذه العملية متاحة لمالك AJLIB فقط' });
    const { action, order_id: orderId, confirm_order_number: confirmOrderNumber } = req.body || {};
    if (!/^[0-9a-f-]{36}$/i.test(String(orderId || ''))) return res.status(400).json({ error: 'order_id must be the order UUID' });
    const order = await loadOrder(orderId);
    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });

    if (action === 'status') return res.status(200).json(summary(order));
    if (action === 'reprepare') { const r = await reprepare(order); return res.status(r.status).json(r.body); }
    if (action === 'create' || action === 'submit') { const r = await create(order, confirmOrderNumber); return res.status(r.status).json(r.body); }
    if (action === 'sync-tracking') {
      const r = await syncTracking(order);
      return res.status(r.synced || r.reason === 'NOT_SUBMITTED' ? 200 : 502).json(r);
    }
    return res.status(400).json({ error: 'action must be status, reprepare, create or sync-tracking' });
  } catch (error) {
    return res.status(500).json({ error: 'ADMIN_FULFILLMENT_FAILED' });
  }
};
