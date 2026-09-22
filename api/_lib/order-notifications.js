// Server-only delivery of status events queued by the orders database trigger.
// Never called from payment or fulfillment writes: a notification failure must
// not affect a paid order. Email uses Resend's stable idempotency key. Expo
// push has no idempotency key, so an ambiguous network result is quarantined
// instead of blindly retried (which could notify the customer twice).
import { customerStatusFor } from './fulfillment-status.js';

const headers = () => ({
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
  'Content-Type': 'application/json'
});
const db = async (path, options = {}) => {
  const response = await fetch(`${process.env.SUPABASE_URL}${path}`, {
    ...options, headers: { ...headers(), ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Notification database request failed (${response.status})`);
  const value = await response.text();
  return value ? JSON.parse(value) : null;
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const customerStatuses = Object.freeze({
  ORDER_RECEIVED: { ar: ['تم استلام طلبك من AJLIB', 'تم استلام طلبك وسنبدأ تجهيزه قريبًا.'], en: ['Your AJLIB order has been received', 'We received your order and will prepare it soon.'] },
  PREPARING_ORDER: { ar: ['بدأنا تجهيز طلبك', 'نعمل الآن على تجهيز طلبك.'], en: ["We're preparing your AJLIB order", 'We are now preparing your order.'] },
  PREPARING_SHIPMENT: { ar: ['طلبك جاهز للشحن', 'نعمل على تجهيز شحنة طلبك.'], en: ['Your AJLIB order is being prepared for shipment', 'Your shipment is being prepared.'] },
  SHIPPED: { ar: ['تم شحن طلبك', 'تم شحن طلبك، وأصبحت معلومات التتبع متاحة.'], en: ['Your AJLIB order has shipped', 'Your order has shipped and tracking is now available.'] },
  DELIVERED: { ar: ['تم توصيل طلبك', 'تم توصيل طلبك. شكرًا لتسوقك مع AJLIB.'], en: ['Your AJLIB order has been delivered', 'Your order has been delivered. Thank you for shopping with AJLIB.'] }
});
export const customerNotificationCopy = (status, language, orderNumber) => {
  const locale = language === 'ar' ? 'ar' : 'en';
  const copy = customerStatuses[status]?.[locale];
  if (!copy) throw new Error('Unsupported customer status');
  return { language: locale, title: copy[0], body: `${copy[1]} ${locale === 'ar' ? 'رقم الطلب:' : 'Order:'} ${orderNumber}` };
};
export const safeTrackingForNotification = (order, status) => {
  if (!['SHIPPED', 'DELIVERED'].includes(status) || !order.tracking_number) return null;
  const url = String(order.fulfillment_tracking_url || '');
  return { number: order.tracking_number, carrier: order.shipping_company || null,
    url: /^https:\/\/t\.17track\.net\//i.test(url) ? url : null };
};
const patchEvent = (id, patch) => db(`/rest/v1/order_notification_events?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
const patchToken = (id, patch) => db(`/rest/v1/order_push_tokens?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
const patchDelivery = (eventId, tokenId, patch) => db(`/rest/v1/order_push_deliveries?event_id=eq.${encodeURIComponent(eventId)}&token_id=eq.${encodeURIComponent(tokenId)}`, { method: 'PATCH', body: JSON.stringify(patch) });

const contextFor = async (event) => {
  const orders = await db(`/rest/v1/orders?id=eq.${encodeURIComponent(event.order_id)}&select=id,order_number,customer_email,user_id,status,tracking_number,shipping_company,fulfillment_tracking_url`);
  const order = orders?.[0];
  if (!order) throw new Error('Order no longer exists');
  const notes = await db(`/rest/v1/order_notifications?order_id=eq.${encodeURIComponent(order.id)}&customer_status=eq.${event.customer_status}&select=user_id`);
  const userId = notes?.[0]?.user_id || order.user_id || null;
  const profiles = userId ? await db(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=preferred_language`) : [];
  return { order, userId, language: profiles?.[0]?.preferred_language === 'ar' ? 'ar' : 'en' };
};

const sendEmail = async (event, context) => {
  if (!process.env.RESEND_API_KEY) throw new Error('Resend is not configured');
  const { order, language } = context;
  if (!order.customer_email) throw new Error('Order has no customer email');
  const copy = customerNotificationCopy(event.customer_status, language, order.order_number);
  const tracking = safeTrackingForNotification(order, event.customer_status);
  const direction = language === 'ar' ? 'rtl' : 'ltr';
  const trackHtml = tracking ? `<p>${language === 'ar' ? 'رقم التتبع' : 'Tracking number'}: <b dir="ltr">${escapeHtml(tracking.number)}</b>${tracking.url ? ` · <a href="${escapeHtml(tracking.url)}">${language === 'ar' ? 'تتبع الشحنة' : 'Track shipment'}</a>` : ''}</p>` : '';
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'ajlib-store/1.0', 'Idempotency-Key': `ajlib-status-${event.order_id}-${event.customer_status}` },
      body: JSON.stringify({ from: process.env.ORDER_FROM_EMAIL || 'AJLIB Orders <orders@ajlib.store>', to: [order.customer_email],
        reply_to: process.env.ORDER_NOTIFICATION_EMAIL || 'support@ajlib.store',
        subject: `${copy.title} — ${order.order_number}`,
        html: `<div dir="${direction}" style="font-family:Arial,sans-serif;max-width:620px;margin:auto;line-height:1.8;color:#26352d"><h1>${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.body)}</p>${trackHtml}<p><a href="https://www.ajlib.store/?order=${encodeURIComponent(order.order_number)}">${language === 'ar' ? 'افتح طلبك في AJLIB' : 'Open your order in AJLIB'}</a></p></div>` })
    });
  } catch {
    // A network failure cannot prove Resend did not accept the email. Hold
    // for an operator instead of risking a duplicate after its key expires.
    throw new Error('Resend outcome unknown; manual review required');
  }
  if (!response.ok) throw new Error(`Resend rejected notification (${response.status})`);
  return (await response.json().catch(() => ({}))).id || null;
};

const sendPush = async (event, context) => {
  const { order, userId, language } = context;
  // A device registered later must not receive an obsolete stage after the
  // order has progressed again (e.g. SHIPPED after DELIVERED).
  if (customerStatusFor(order.status) !== event.customer_status) return null;
  if (!userId) return null; // Guest orders have email, but no registered device.
  const tokens = await db(`/rest/v1/order_push_tokens?user_id=eq.${encodeURIComponent(userId)}&enabled=eq.true&select=id,token`);
  // Build 20 does not register push tokens. Keep the newest stage pending
  // until a customer opts in on a future build; do not falsely mark it sent.
  if (!tokens?.length) throw new Error('NO_REGISTERED_DEVICE');
  const copy = customerNotificationCopy(event.customer_status, language, order.order_number);
  const tracking = safeTrackingForNotification(order, event.customer_status);
  let firstTicket = null;
  for (const token of tokens) {
    // One durable device row per event; already accepted tokens are never sent
    // again when a different device has a retriable failure.
    await db('/rest/v1/order_push_deliveries?on_conflict=event_id,token_id', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ event_id: event.id, token_id: token.id })
    });
    const deliveries = await db(`/rest/v1/order_push_deliveries?event_id=eq.${encodeURIComponent(event.id)}&token_id=eq.${encodeURIComponent(token.id)}&select=state`);
    if (deliveries?.[0]?.state !== 'pending' && deliveries?.[0]?.state !== 'failed') continue;
    let response;
    try {
      response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ to: token.token, title: copy.title, body: copy.body,
          data: { type: 'order_status', order_number: order.order_number, ...(tracking ? { tracking_number: tracking.number } : {}) },
          sound: 'default', channelId: 'order-updates' })
      });
    } catch {
      await patchDelivery(event.id, token.id, { state: 'indeterminate', error: 'Expo network outcome unknown' });
      continue;
    }
    if (!response.ok) {
      await patchDelivery(event.id, token.id, { state: 'failed', error: `Expo HTTP ${response.status}` });
      continue;
    }
    const ticket = (await response.json().catch(() => ({}))).data;
    const entry = Array.isArray(ticket) ? ticket[0] : ticket;
    if (entry?.details?.error === 'DeviceNotRegistered') {
      await patchToken(token.id, { enabled: false });
      await patchDelivery(event.id, token.id, { state: 'sent', error: 'DeviceNotRegistered' });
    } else if (entry?.status === 'ok' && entry.id) {
      firstTicket ||= entry.id;
      await patchDelivery(event.id, token.id, { state: 'sent', ticket_id: entry.id, error: null });
    } else {
      await patchDelivery(event.id, token.id, { state: 'failed', error: String(entry?.message || 'Expo rejected ticket').slice(0, 250) });
    }
  }
  const outstanding = await db(`/rest/v1/order_push_deliveries?event_id=eq.${encodeURIComponent(event.id)}&state=in.(pending,failed,indeterminate)&select=state`);
  if (outstanding?.some(row => row.state === 'indeterminate')) throw new Error('Expo delivery outcome unknown; manual review required');
  if (outstanding?.length) throw new Error('Expo rejected one or more devices');
  return firstTicket;
};

// Expo tickets only confirm queue acceptance. Receipts arrive later and may
// identify tokens invalidated after the send. Never re-send a ticketed device.
export const checkExpoPushReceipts = async () => {
  const before = new Date(Date.now() - 15 * 60_000).toISOString();
  const rows = await db(`/rest/v1/order_push_deliveries?state=eq.sent&ticket_id=not.is.null&receipt_checked_at=is.null&created_at=lt.${encodeURIComponent(before)}&select=event_id,token_id,ticket_id&limit=50`);
  if (!rows?.length) return { checked: 0 };
  const response = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ids: rows.map(row => row.ticket_id) })
  });
  if (!response.ok) return { checked: 0, error: `Expo receipts HTTP ${response.status}` };
  const receipts = (await response.json().catch(() => ({}))).data || {};
  let checked = 0;
  for (const row of rows) {
    const receipt = receipts[row.ticket_id];
    if (!receipt) continue;
    if (receipt.details?.error === 'DeviceNotRegistered') await patchToken(row.token_id, { enabled: false });
    await patchDelivery(row.event_id, row.token_id, {
      receipt_checked_at: new Date().toISOString(),
      ...(receipt.status === 'error' ? { error: String(receipt.details?.error || receipt.message || 'Expo receipt error').slice(0, 250) } : {})
    });
    checked += 1;
  }
  return { checked };
};

export const deliverOrderNotifications = async ({ limit = 20 } = {}) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return { ok: false, reason: 'DATABASE_NOT_CONFIGURED' };
  const events = await db('/rest/v1/rpc/claim_order_notification_events', { method: 'POST', body: JSON.stringify({ p_limit: limit }) });
  const results = [];
  for (const event of events || []) {
    try {
      const context = await contextFor(event);
      const providerId = event.channel === 'email' ? await sendEmail(event, context) : await sendPush(event, context);
      await patchEvent(event.id, { state: 'sent', sent_at: new Date().toISOString(), provider_message_id: providerId, leased_until: null, error: null });
      results.push({ channel: event.channel, sent: true });
    } catch (error) {
      const indeterminate = /outcome unknown/.test(String(error.message));
      await patchEvent(event.id, { state: indeterminate ? 'indeterminate' : 'failed', leased_until: null,
        next_attempt_at: new Date(Date.now() + Math.min(24, 2 ** Math.min(event.attempts, 5)) * 60_000).toISOString(),
        error: String(error.message).slice(0, 250) }).catch(() => {});
      results.push({ channel: event.channel, sent: false });
    }
  }
  const receipts = await checkExpoPushReceipts().catch(() => ({ checked: 0, error: 'RECEIPT_CHECK_FAILED' }));
  return { ok: true, processed: results.length, failed: results.filter(r => !r.sent).length, receipts };
};
