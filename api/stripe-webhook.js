import crypto from 'node:crypto';
import { quoteShipping } from './shipping-quote.js';
import { runFulfillmentPreparation, FULFILLMENT_STATE } from './_lib/fulfillment-runner.js';
import { autoCreateAfterPayment, alertPreparationReview } from './_lib/fulfillment-auto.js';

export const config = { api: { bodyParser: false } };

const readRawBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const verifyStripeSignature = (payload, header, secret) => {
  const values = Object.fromEntries(String(header || '').split(',').map(part => part.split('=')));
  const timestamp = values.t;
  const signature = values.v1;
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
}[char]));

const formatItems = (value = '') => String(value).split(',').filter(Boolean).map(item => {
  const separator = item.lastIndexOf(':');
  const variant = separator >= 0 ? item.slice(0, separator) : item;
  const count = separator >= 0 ? item.slice(separator + 1) : '';
  return `<li><b>${escapeHtml(count)} قطعة</b> — ${escapeHtml(variant.replace('-', ' / '))}</li>`;
}).join('');

// The order's CANONICAL total, in AED fils. AJLIB prices in AED and puts
// the server-computed product and shipping amounts in the payment metadata,
// so that is the source whenever present. Otherwise (payments made before
// that metadata existed) it falls back to the charged amount, which was
// always AED — including the older Adaptive Pricing shape where the session
// carried the presentment currency and the AED amount sat under
// currency_conversion.
export const settledOrderAmount = (session) => {
  const metadata = session.metadata || {};
  const product = Number(metadata.product_amount);
  const shipping = Number(metadata.shipping_amount);
  if (metadata.product_amount !== undefined && Number.isInteger(product) && Number.isInteger(shipping)) {
    return { amount_total: product + shipping, currency: 'aed' };
  }
  const conversion = session.currency_conversion;
  if (conversion && String(conversion.source_currency || '').toLowerCase() === 'aed' && Number.isFinite(Number(conversion.amount_total))) {
    return { amount_total: Number(conversion.amount_total), currency: 'aed' };
  }
  return { amount_total: session.amount_total || 0, currency: String(session.currency || 'aed').toLowerCase() };
};

// What the customer was ACTUALLY charged: the currency and amount of the
// payment itself (AED for AED checkouts, USD cents for USD checkouts).
// Stripe's presentment_details, when present, is the charged presentment.
export const paidAmount = (session) => {
  const presentment = session.presentment_details;
  if (presentment?.presentment_currency && Number.isFinite(Number(presentment.presentment_amount))) {
    return { paid_currency: String(presentment.presentment_currency).toLowerCase(), paid_amount: Number(presentment.presentment_amount) };
  }
  return { paid_currency: String(session.currency || 'aed').toLowerCase(), paid_amount: Number(session.amount_total || 0) };
};

// Every amount column written for a paid order. amount_total/currency keep
// their long-standing meaning — the canonical AED total — so revenue totals,
// historical orders and the CJ profit guard all stay in AED.
export const orderAmountFields = (session) => {
  const canonical = settledOrderAmount(session);
  return {
    amount_total: canonical.amount_total,
    currency: canonical.currency,
    canonical_total_aed: canonical.currency === 'aed' ? canonical.amount_total : null,
    ...paidAmount(session)
  };
};

const money = (amount, currency) => new Intl.NumberFormat('ar-AE', { style: 'currency', currency: String(currency || 'aed').toUpperCase() }).format(Number(amount || 0) / 100);

const sendOrderEmail = async (session) => {
  const metadata = session.metadata || {};
  const orderId = metadata.order_id || session.client_reference_id || session.id;
  const customerEmail = session.customer_details?.email || session.customer_email || '';
  const fields = orderAmountFields(session);
  const amount = money(fields.amount_total, fields.currency)
    + (fields.paid_currency !== fields.currency ? ` — المدفوع: ${money(fields.paid_amount, fields.paid_currency)}` : '');
  const shippingAmount = new Intl.NumberFormat('ar-AE', { style: 'currency', currency: 'AED' }).format(Number(metadata.shipping_amount || 0) / 100);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ajlib-store/1.0',
      'Idempotency-Key': `ajlib-order-${session.id}`
    },
    body: JSON.stringify({
      from: process.env.ORDER_FROM_EMAIL || 'AJLIB Orders <orders@ajlib.store>',
      to: [process.env.ORDER_NOTIFICATION_EMAIL || 'support@ajlib.store'],
      reply_to: customerEmail || undefined,
      subject: `طلب AJLIB جديد ومدفوع — ${orderId}`,
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#171914;max-width:640px;margin:auto">
        <h1 style="color:#26352d">طلب جديد ومدفوع ✓</h1>
        <p><b>رقم الطلب:</b> ${escapeHtml(orderId)}</p>
        <p><b>المبلغ:</b> ${escapeHtml(amount)}</p>
        <hr><h2>بيانات العميل</h2>
        <p><b>الاسم:</b> ${escapeHtml(metadata.customer_name)}</p>
        <p><b>الهاتف:</b> <span dir="ltr">${escapeHtml(metadata.phone)}</span></p>
        <p><b>البريد:</b> ${escapeHtml(customerEmail)}</p>
        <p><b>العنوان:</b> ${escapeHtml(metadata.address)}</p>
        <p><b>الدولة:</b> ${escapeHtml(metadata.country_name || metadata.country_code)}</p>
        <p><b>الشحن:</b> ${escapeHtml(shippingAmount)} — ${escapeHtml(metadata.shipping_zone || '')}</p>
        <p style="color:#686b62">قد تختلف الرسوم الجمركية والضرائب حسب خط الشحن وبلد الاستلام.</p>
        <p><b>ملاحظات:</b> ${escapeHtml(metadata.notes || 'لا توجد')}</p>
        <hr><h2>الألوان والمقاسات</h2><ul>${formatItems(metadata.items)}</ul>
        <p style="color:#686b62">تم إرسال هذه الرسالة بعد تأكيد الدفع${session.provider === 'ziina' ? ' من Ziina' : ' من Stripe'}.</p>
      </div>`
    })
  });
  if (!response.ok) throw new Error(`Email provider rejected request: ${response.status}`);
};

const trimmed = (value) => String(value ?? '').trim();

const saveOrder = async (session) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;
  const metadata = session.metadata || {};
  const customerEmail = session.customer_details?.email || session.customer_email || '';
  const items = String(metadata.items || '').split(',').filter(Boolean).map(item => {
    const separator = item.lastIndexOf(':');
    return { variant: separator >= 0 ? item.slice(0, separator) : item, quantity: Number(separator >= 0 ? item.slice(separator + 1) : 1) };
  });
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?on_conflict=stripe_session_id&select=*`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      // return=minimal previously hid this: a 2xx status here does NOT prove
      // a row exists (e.g. an RLS-restricted SELECT on the same request can
      // make PostgREST report success with an empty result). representation
      // forces PostgREST to hand back the actual persisted row so we can
      // verify it ourselves instead of trusting the HTTP status alone.
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify({
      order_number: metadata.order_id || session.client_reference_id || session.id,
      user_id: metadata.user_id || null,
      // Contact and shipping fields are stored trimmed: they are what CJ puts
      // on the shipping label.
      customer_email: trimmed(customerEmail),
      customer_name: trimmed(metadata.customer_name),
      customer_phone: trimmed(metadata.phone),
      shipping_address: trimmed(metadata.address),
      shipping_address_id: /^[0-9a-f-]{36}$/i.test(metadata.address_id || '') ? metadata.address_id : null,
      shipping_country_code: trimmed(metadata.country_code).toUpperCase() || null,
      shipping_country_name: trimmed(metadata.country_name) || null,
      shipping_region: trimmed(metadata.region) || null,
      // Structured city and street lines — the single shared persistence path
      // for BOTH Stripe and Tabby (api/commerce.js tabby-verify normalizes into
      // this same metadata shape), so neither provider can drift from the
      // other. Absent (e.g. an order placed before they were captured) stays
      // NULL: a street is never parsed back out of shipping_address.
      shipping_city: trimmed(metadata.city) || null,
      shipping_street: trimmed(metadata.street) || null,
      shipping_street2: trimmed(metadata.street2) || null,
      shipping_postal_code: trimmed(metadata.postal_code) || null,
      items,
      product_amount: Number(metadata.product_amount || 0),
      shipping_amount: Number(metadata.shipping_amount || 0),
      ...orderAmountFields(session),
      status: 'paid',
      stripe_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent || null,
      ...(session.provider === 'ziina' ? {
        payment_provider: 'ziina',
        provider_payment_id: session.provider_payment_id,
        provider_operation_id: session.provider_operation_id || null,
        provider_status: 'completed',
        provider_fee_amount: session.provider_fee_amount ?? null,
        provider_fee_currency: session.provider_fee_currency || null,
        provider_settled_amount_aed: session.provider_settled_amount_aed
      } : {}),
      // paid_at comes from the payment provider's own timestamp (Stripe's
      // session.created; Tabby's payment created_at). It is only written
      // when that timestamp is real. Omitting it — rather than falling back
      // to "now" — matters because this is an upsert with merge-duplicates:
      // an omitted column is left as-is on conflict, so a duplicate delivery
      // or re-verification can never move an already-recorded paid_at.
      ...(Number.isFinite(session.created) ? { paid_at: new Date(session.created * 1000).toISOString() } : {})
    })
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`Order database rejected request: ${response.status} ${rawBody.slice(0, 300)}`);
  }
  let rows;
  try { rows = JSON.parse(rawBody); } catch { rows = null; }
  if (!Array.isArray(rows) || rows.length === 0) {
    // The exact bug this replaces: PostgREST returned 2xx with no row, so a
    // caller trusting response.ok alone would believe the order was saved
    // when it was not. Never let that be mistaken for success again.
    throw new Error(`Order upsert reported success but returned no row for stripe_session_id=${session.id}`);
  }
  return rows[0];
};

const updateInventory = async (session) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;
  const requested = String(session.metadata?.items || '').split(',').filter(Boolean).map(item => {
    const separator = item.lastIndexOf(':');
    return { variant: separator >= 0 ? item.slice(0, separator) : item, quantity: Number(separator >= 0 ? item.slice(separator + 1) : 1) || 1 };
  });
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/process_paid_inventory`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: session.id, requested })
  });
  if (!response.ok) throw new Error('Inventory update failed');
};

// Shared, provider-neutral order-persistence pipeline: save the paid order
// (idempotent upsert on stripe_session_id — reused here as a generic
// "this provider's unique payment reference" key, not Stripe-specific),
// email the team, decrement inventory, and then prepare fulfillment. Both
// Stripe event handlers below and the Tabby verify path (api/commerce.js,
// resource=tabby-verify) call this instead of each re-implementing it, so
// this is the single integration point where payment meets fulfillment.
//
// Fulfillment preparation deliberately depends only on the order having been
// SAVED — not on the email or inventory calls succeeding. A failed team
// email must not leave a paid order unprepared. It also never throws, so it
// can neither fail the payment response nor alter the paid order.
export const persistPaidOrder = async (session) => {
  const settled = await Promise.allSettled([saveOrder(session), sendOrderEmail(session), updateInventory(session)]);
  const [saved] = settled;

  if (saved.status === 'fulfilled' && saved.value?.id) {
    let maxDeliveryDays;
    try {
      // The delivery promise is per-destination and lives in shipping_zones,
      // so it is read rather than assumed. If it cannot be resolved,
      // prepareFulfillment blocks on DELIVERY_PROMISE_NOT_CONFIGURED rather
      // than picking an arbitrarily slow route.
      const shipping = await quoteShipping(saved.value.shipping_country_code);
      maxDeliveryDays = shipping.max_days;
    } catch { maxDeliveryDays = undefined; }
    const preparation = await runFulfillmentPreparation(saved.value, { maxDeliveryDays });
    // Only an order that THIS delivery just prepared continues: a duplicate
    // webhook or re-verification finds it already prepared and stops here.
    // autoCreateAfterPayment is a no-op unless CJ_AUTO_CREATE_ENABLED=true,
    // claims the order atomically, and never throws.
    if (preparation?.ran && preparation.outcome === FULFILLMENT_STATE.READY_FOR_CJ) {
      await autoCreateAfterPayment({ ...saved.value, fulfillment_status: FULFILLMENT_STATE.READY_FOR_CJ }, { maxDeliveryDays, prepared: preparation.prepared });
    } else if (preparation?.ran && preparation.outcome === FULFILLMENT_STATE.REVIEW_REQUIRED) {
      await alertPreparationReview(saved.value, preparation.reason);
    }
  }

  // Preserve the previous contract: any failure among save/email/inventory
  // still surfaces to the caller, so tabby-verify cannot report paid:true on
  // an unconfirmed persistence.
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  return saved.value;
};

// Transitional compatibility with the checkout that was live before this
// branch: it created the app's PaymentIntent with ONLY metadata[order_id] and
// kept the order details in the private pending_mobile_orders table. A
// PaymentIntent created by that code can still succeed after this deploy
// (rows expire after 24 hours), so its details are read back from that table
// instead of being persisted as an empty order. No shipping_city exists
// there, so fulfillment will stop at MISSING_SHIPPING_CITY for manual review.
const loadPendingMobileOrder = async (intent) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error('Mobile order storage is not configured');
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_mobile_orders?stripe_payment_intent_id=eq.${encodeURIComponent(intent.id)}&select=*`, {
    headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
  });
  if (!response.ok) throw new Error('Pending mobile order lookup failed');
  const pending = (await response.json())[0];
  if (!pending) throw new Error(`No order details for PaymentIntent ${intent.id}`);
  return {
    order_id: pending.order_number, user_id: pending.user_id || '', customer_name: pending.customer_name || '', phone: pending.customer_phone || '',
    address: pending.shipping_address || '', address_id: pending.shipping_address_id || '', country_code: pending.shipping_country_code || '',
    country_name: pending.shipping_country_name || '', region: pending.shipping_region || '', postal_code: pending.shipping_postal_code || '',
    notes: pending.notes || '', items: pending.item_summary || '', product_amount: String(pending.product_amount || 0),
    shipping_amount: String(pending.shipping_amount || 0), shipping_zone: pending.shipping_zone || '', preorder: pending.preorder || '',
    customer_email: pending.customer_email || ''
  };
};

const deletePendingMobileOrder = async (intentId) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_mobile_orders?stripe_payment_intent_id=eq.${encodeURIComponent(intentId)}`, {
    method: 'DELETE', headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
  });
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: 'Order notifications are not configured' });
  }
  try {
    const raw = await readRawBody(req);
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) {
      return res.status(400).json({ error: 'Invalid Stripe signature' });
    }
    const event = JSON.parse(raw.toString('utf8'));
    if (event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'paid') {
      await persistPaidOrder(event.data.object);
    }
    // Native Expo app checkout (PaymentSheet) confirms via PaymentIntent, not a
    // Checkout Session — normalize it into the same shape so paid orders from
    // the app are persisted, emailed and deduct inventory exactly like the web.
    // IMPORTANT: a hosted Checkout Session (the web flow above) also has an
    // underlying PaymentIntent, so this event fires for web payments too —
    // but api/checkout-session.js only ever attaches metadata[order_id] to a
    // PaymentIntent directly for the native branch (order.mobile === true).
    // Web-originated intents therefore have no order_id here, so this guard
    // is what stops every web order from being double-processed.
    if (event.type === 'payment_intent.succeeded' && event.data?.object?.metadata?.order_id) {
      const intent = event.data.object;
      // Intents from this branch carry the order in metadata; intents from the
      // previous checkout carry only order_id (see loadPendingMobileOrder).
      const legacy = !intent.metadata.items;
      const { customer_email: pendingEmail, ...metadata } = legacy ? await loadPendingMobileOrder(intent) : { ...intent.metadata };
      const normalized = {
        id: intent.id,
        metadata,
        customer_details: null,
        customer_email: intent.receipt_email || pendingEmail || '',
        amount_total: legacy ? (intent.amount_received || intent.amount) : intent.amount,
        currency: intent.currency,
        payment_intent: intent.id,
        created: intent.created
      };
      await persistPaidOrder(normalized);
      if (legacy) await deletePendingMobileOrder(intent.id);
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Webhook failed' });
  }
}
