// Admin-only CJ fulfillment control, served as /api/admin-fulfillment
// (dispatched from api/commerce.js to stay within the function budget).
//
// POST { action, order_id, confirm_order_number? } with the signed-in admin's
// Supabase access token as "Authorization: Bearer <token>". Customers and
// anonymous callers are refused before any order is read.
//
//   status         read-only view of one order's fulfillment fields
//   reprepare      re-run live preparation (variants, cost, freight, margin,
//                  balance) for an order that is not yet with CJ — this is how
//                  an order paid while the wallet was empty gets unstuck
//   submit         send exactly ONE READY_FOR_CJ order to CJ (createOrderV2,
//                  payType=2). Requires CJ_LIVE_ORDER_CREATION_ENABLED=true and
//                  confirm_order_number equal to the order's number.
//   sync-tracking  read-only CJ order detail + tracking poll for one order
//
// Nothing here is reachable from the Stripe or Tabby payment paths.

import { quoteShipping } from '../shipping-quote.js';
import { isLiveOrderCreationEnabled } from './cj-client.js';
import { FULFILLMENT_STATE, reprepareFulfillment } from './fulfillment-runner.js';
import { submitReadyOrder, SUBMIT_OUTCOME } from './fulfillment-submitter.js';
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
  fulfillment_status: order.fulfillment_status ?? null,
  fulfillment_error: order.fulfillment_error ?? null,
  fulfillment_logistics_method: order.fulfillment_logistics_method ?? null,
  fulfillment_cost_usd: order.fulfillment_cost ?? null,
  fulfillment_external_order_number: order.fulfillment_external_order_number ?? null,
  fulfillment_external_order_id: order.fulfillment_external_order_id ?? null,
  fulfillment_tracking_number: order.fulfillment_tracking_number ?? null,
  fulfillment_last_sync_at: order.fulfillment_last_sync_at ?? null
});

const submittingOrders = async () => {
  const response = await db(`/rest/v1/orders?fulfillment_status=eq.${FULFILLMENT_STATE.SUBMITTING}&select=id`);
  if (!response.ok) throw new Error('Submission lock lookup failed');
  return response.json();
};

// Atomic claim: only succeeds if the row is STILL READY_FOR_CJ with no CJ id.
const claimForSubmission = async (order) => {
  const response = await db(
    `/rest/v1/orders?id=eq.${encodeURIComponent(order.id)}&fulfillment_status=eq.${FULFILLMENT_STATE.READY_FOR_CJ}&fulfillment_external_order_id=is.null&select=id`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ fulfillment_status: FULFILLMENT_STATE.SUBMITTING, fulfillment_last_sync_at: new Date().toISOString() }) }
  );
  if (!response.ok) return false;
  const rows = await response.json();
  return Array.isArray(rows) && rows.length === 1;
};

// Only ever releases our OWN claim, and only while it is still SUBMITTING.
const releaseClaim = (order) => db(
  `/rest/v1/orders?id=eq.${encodeURIComponent(order.id)}&fulfillment_status=eq.${FULFILLMENT_STATE.SUBMITTING}&fulfillment_external_order_id=is.null`,
  { method: 'PATCH', body: JSON.stringify({ fulfillment_status: FULFILLMENT_STATE.READY_FOR_CJ }) }
);

const reprepare = async (order) => {
  const result = await reprepareFulfillment(order, { maxDeliveryDays: await maxDaysFor(order.shipping_country_code) });
  if (!result.ran) return { status: 409, body: { outcome: result.outcome, state: result.state ?? null } };
  const prepared = result.prepared;
  return {
    status: 200,
    body: {
      outcome: result.outcome, // READY_FOR_CJ | REVIEW_REQUIRED
      reason: result.reason ?? null,
      route: prepared ? { method: prepared.logistics.method, agingDays: prepared.logistics.agingDays, costUSD: prepared.logistics.cost, reason: prepared.logistics.reason } : (result.reviewFields?.fulfillment_logistics_method ?? null),
      requiredUSD: prepared ? Number(prepared.requiredUSD.toFixed(2)) : (result.reviewFields?.fulfillment_cost ?? null),
      margin: prepared ? { band: prepared.margin.band, percent: Number(prepared.margin.details.marginPercent.toFixed(2)) } : null,
      balance: prepared?.balance ? { availableUSD: prepared.balance.balanceUSD, sufficient: prepared.balance.sufficient, lowBalanceWarning: prepared.balance.lowBalanceWarning, remainingAfterUSD: Number(prepared.balance.remainingAfterUSD.toFixed(2)) } : null,
      payload: prepared?.payload ?? null // exactly what submit would send, for review
    }
  };
};

const submit = async (order, confirmOrderNumber) => {
  // Flag first: with it off, nothing is claimed and nothing is called.
  if (!isLiveOrderCreationEnabled()) return { status: 409, body: { outcome: SUBMIT_OUTCOME.LIVE_ORDER_CREATION_DISABLED } };
  if (String(confirmOrderNumber || '') !== String(order.order_number)) return { status: 400, body: { outcome: 'CONFIRMATION_MISMATCH' } };
  if (order.fulfillment_external_order_id) return { status: 409, body: { outcome: SUBMIT_OUTCOME.ALREADY_SUBMITTED, cjOrderId: order.fulfillment_external_order_id } };
  if (order.fulfillment_status !== FULFILLMENT_STATE.READY_FOR_CJ) return { status: 409, body: { outcome: SUBMIT_OUTCOME.NOT_READY, state: order.fulfillment_status ?? null } };

  // One order at a time, across the whole store.
  if ((await submittingOrders()).length > 0) return { status: 409, body: { outcome: 'ANOTHER_SUBMISSION_IN_PROGRESS' } };
  if (!(await claimForSubmission(order))) return { status: 409, body: { outcome: 'CLAIM_FAILED' } };
  if ((await submittingOrders()).length > 1) {
    await releaseClaim(order);
    return { status: 409, body: { outcome: 'ANOTHER_SUBMISSION_IN_PROGRESS' } };
  }

  let result;
  try {
    // Re-runs the full live preparation, then createOrderV2 (payType=2), then
    // records the CJ order id; uncertain outcomes are reconciled read-only.
    result = await submitReadyOrder({ ...order, fulfillment_status: FULFILLMENT_STATE.READY_FOR_CJ }, { maxDeliveryDays: await maxDaysFor(order.shipping_country_code) });
  } catch (error) {
    // Unknown outcome: the row deliberately stays SUBMITTING, which blocks
    // every further submit until a human reconciles it against CJ.
    return { status: 500, body: { outcome: 'SUBMISSION_OUTCOME_UNKNOWN', note: 'Order left in SUBMITTING for manual reconciliation; do not retry.' } };
  }

  // Nothing was created on CJ's side: hand the order back as READY_FOR_CJ.
  if ([SUBMIT_OUTCOME.NOT_CREATED_SAFE_TO_RETRY, SUBMIT_OUTCOME.LIVE_ORDER_CREATION_DISABLED].includes(result.outcome)) await releaseClaim(order);

  // Belt and braces: the CJ id must be on the row, or the next submit could not see it.
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
    if (action === 'submit') { const r = await submit(order, confirmOrderNumber); return res.status(r.status).json(r.body); }
    if (action === 'sync-tracking') {
      const r = await syncTracking(order);
      return res.status(r.synced || r.reason === 'NOT_SUBMITTED' ? 200 : 502).json(r);
    }
    return res.status(400).json({ error: 'action must be status, reprepare, submit or sync-tracking' });
  } catch (error) {
    return res.status(500).json({ error: 'ADMIN_FULFILLMENT_FAILED' });
  }
};
