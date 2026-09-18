// Owner/operations alerts for CJ fulfillment, sent through the same Resend
// setup as the paid-order email (api/stripe-webhook.js) to the same internal
// address (ORDER_NOTIFICATION_EMAIL, default support@ajlib.store). Never sent
// to the customer, never shown on the storefront.
//
//   PAY_CJ_ORDER     a CJ order was created UNPAID and must be paid in CJ
//   REVIEW_REQUIRED  a paid order could not be sent to CJ automatically
//
// Alerts never throw: a failed email must not affect the order. Each alert
// is idempotent per order and kind (Resend Idempotency-Key), and the pay
// alert records fulfillment_alert_sent_at so it is only sent once.

import { patchOrder } from './fulfillment-runner.js';

const escapeHtml = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const units = (items) => (Array.isArray(items) ? items.reduce((n, item) => n + (Number(item.quantity) || 0), 0) : 0);

export const buildOwnerAlert = (kind, orderRow, details = {}) => {
  const destination = [orderRow.shipping_city, orderRow.shipping_region, orderRow.shipping_country_code].filter(Boolean).join(', ');
  const rows = kind === 'PAY_CJ_ORDER'
    ? [
        ['Action required', 'PAY THIS ORDER IN CJ'],
        ['Status', 'WAITING_FOR_CJ_PAYMENT'],
        ['AJLIB order', orderRow.order_number],
        ['CJ order ID', details.cjOrderId],
        ['Destination', destination],
        ['Quantity', `${details.units ?? units(orderRow.items)} pieces`],
        ['Route', details.route],
        ['CJ payable', details.requiredUSD != null ? `USD ${Number(details.requiredUSD).toFixed(2)}` : 'see CJ'],
        ['Pay link', details.payUrl || 'Open the order in the CJ dashboard']
      ]
    : [
        ['Action required', 'REVIEW THIS ORDER — it was NOT sent to CJ'],
        ['Status', 'REVIEW_REQUIRED'],
        ['Reason', details.reason],
        ['AJLIB order', orderRow.order_number],
        ['Destination', destination],
        ['Quantity', `${units(orderRow.items)} pieces`]
      ];
  const subject = kind === 'PAY_CJ_ORDER'
    ? `ACTION: pay CJ order for AJLIB ${orderRow.order_number}`
    : `ACTION: review AJLIB order ${orderRow.order_number} (not sent to CJ)`;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.7;color:#171914;max-width:640px;margin:auto">
    <h2 style="color:#8a2d1c">${escapeHtml(subject)}</h2>
    <table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0"><b>${escapeHtml(k)}</b></td><td>${k === 'Pay link' && /^https:\/\//.test(String(v)) ? `<a href="${escapeHtml(v)}">${escapeHtml(v)}</a>` : escapeHtml(v ?? '—')}</td></tr>`).join('')}</table>
    <p style="color:#686b62">Internal fulfillment alert. The customer sees only "Preparing your order".</p>
  </div>`;
  return { subject, html, idempotencyKey: `ajlib-${kind.toLowerCase()}-${orderRow.order_number}-${details.cjOrderId || details.reason || 'x'}` };
};

export const sendOwnerAlert = async (kind, orderRow, details = {}) => {
  try {
    if (!process.env.RESEND_API_KEY || !orderRow?.order_number) return { sent: false, reason: 'NOT_CONFIGURED' };
    if (kind === 'PAY_CJ_ORDER' && orderRow.fulfillment_alert_sent_at) return { sent: false, reason: 'ALREADY_SENT' };
    const alert = buildOwnerAlert(kind, orderRow, details);
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'ajlib-store/1.0', 'Idempotency-Key': alert.idempotencyKey },
      body: JSON.stringify({
        from: process.env.ORDER_FROM_EMAIL || 'AJLIB Orders <orders@ajlib.store>',
        to: [process.env.ORDER_NOTIFICATION_EMAIL || 'support@ajlib.store'],
        subject: alert.subject,
        html: alert.html
      })
    });
    if (!response.ok) return { sent: false, reason: `EMAIL_${response.status}` };
    if (kind === 'PAY_CJ_ORDER' && orderRow.id) await patchOrder(orderRow.id, { fulfillment_alert_sent_at: new Date().toISOString() }).catch(() => false);
    return { sent: true };
  } catch {
    return { sent: false, reason: 'EMAIL_FAILED' };
  }
};
