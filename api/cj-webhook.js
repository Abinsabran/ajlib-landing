// CJdropshipping webhook receiver — ORDER/LOGISTIC topic events (tracking &
// status sync). NOT YET REGISTERED with CJ (registration is a write —
// POST /webhook/set — never called by this codebase) and NOT YET RELIED ON
// in production: it reads/writes fulfillment_* columns and the
// cj_webhook_events dedup table, neither of which exist yet (see
// fulfillment-migration.sql, prepared but not applied). This file is Phase
// 4 design/prep only.
//
// Signature verification per CJ's documented scheme: HMAC-SHA256 over the
// raw request body, keyed by the account's `openId`, base64-encoded, sent
// in a request header. Confirmed against CJ's official webhook docs — not
// guessed. Requires the raw, unparsed body (same reason api/stripe-webhook.js
// disables Vercel's body parser).
import crypto from 'node:crypto';
import { nextInternalStatusFromCjStatus } from './_lib/fulfillment-status.js';

export const config = { api: { bodyParser: false } };

const readRawBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const verifyCjSignature = (rawBody, header, openId) => {
  if (!header) return false;
  const expected = crypto.createHmac('sha256', openId).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Records the messageId before doing anything else. A unique-constraint
// violation means this exact event was already processed — treat it as a
// no-op success (CJ should not be told to keep retrying), never as an error.
const claimEventOnce = async ({ messageId, topic }) => {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/cj_webhook_events`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ message_id: messageId, topic })
  });
  if (response.status === 409) return { alreadyProcessed: true };
  if (!response.ok) throw new Error(`Could not claim webhook event ${messageId}: ${response.status}`);
  return { alreadyProcessed: false };
};

// Finds the AJLIB order by CJ's order id (stored on fulfillment_external_order_id
// once a real CJ order exists — never guesses or falls back to any other key)
// and advances its internal status via the same rank-checked, no-regression
// mapping used everywhere else in the fulfillment pipeline.
const applyOrderUpdate = async ({ cjOrderId, cjStatus, trackingNumber, logisticsMethod }) => {
  const lookup = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/orders?fulfillment_external_order_id=eq.${encodeURIComponent(cjOrderId)}&select=id,status`,
    { headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
  );
  if (!lookup.ok) throw new Error(`Order lookup failed for CJ order ${cjOrderId}: ${lookup.status}`);
  const rows = await lookup.json();
  const order = rows[0];
  if (!order) return { matched: false };

  const nextStatus = nextInternalStatusFromCjStatus(order.status, cjStatus);
  const patch = {
    fulfillment_status: cjStatus,
    fulfillment_last_sync_at: new Date().toISOString(),
    ...(trackingNumber ? { fulfillment_tracking_number: trackingNumber } : {}),
    ...(logisticsMethod ? { fulfillment_logistics_method: logisticsMethod } : {}),
    // Only ever moves orders.status forward (or to cancelled) — an
    // unrecognized or regressive CJ status leaves the customer-visible
    // status untouched rather than guessing.
    ...(nextStatus ? { status: nextStatus } : {})
  };
  const update = await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
  if (!update.ok) throw new Error(`Order update failed for CJ order ${cjOrderId}: ${update.status}`);
  return { matched: true, nextStatus };
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.CJ_OPEN_ID || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    return res.status(503).json({ error: 'CJ webhook processing is not configured' });
  }
  try {
    const raw = await readRawBody(req);
    if (!verifyCjSignature(raw, req.headers['cj-signature'], process.env.CJ_OPEN_ID)) {
      return res.status(400).json({ error: 'Invalid CJ signature' });
    }
    const event = JSON.parse(raw.toString('utf8'));
    const messageId = event.messageId;
    if (!messageId) return res.status(400).json({ error: 'Missing messageId' });

    const { alreadyProcessed } = await claimEventOnce({ messageId, topic: event.topic });
    if (alreadyProcessed) return res.status(200).json({ received: true, deduped: true });

    // ORDER topic: order-level status change. LOGISTIC topic: tracking
    // number assigned/updated. Field names below follow CJ's documented
    // webhook payload shape (orderId/orderStatus, trackNumber/logisticName) —
    // to be re-confirmed against a real delivered payload before this is
    // ever registered live, per the "never guess a schema" rule.
    if (event.topic === 'ORDER' || event.topic === 'LOGISTIC') {
      await applyOrderUpdate({
        cjOrderId: event.data?.orderId,
        cjStatus: event.data?.orderStatus,
        trackingNumber: event.data?.trackNumber || null,
        logisticsMethod: event.data?.logisticName || null
      });
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Webhook failed' });
  }
}
