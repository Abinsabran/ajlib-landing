import crypto from 'node:crypto';

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

const sendOrderEmail = async (session) => {
  const metadata = session.metadata || {};
  const orderId = metadata.order_id || session.client_reference_id || session.id;
  const customerEmail = session.customer_details?.email || session.customer_email || '';
  const amount = new Intl.NumberFormat('ar-AE', { style: 'currency', currency: 'AED' }).format((session.amount_total || 0) / 100);
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
        <p style="color:#686b62">الرسوم الجمركية أو ضرائب الاستيراد المحلية — إن وُجدت — يتحملها المستلم.</p>
        <p><b>ملاحظات:</b> ${escapeHtml(metadata.notes || 'لا توجد')}</p>
        <hr><h2>الألوان والمقاسات</h2><ul>${formatItems(metadata.items)}</ul>
        <p style="color:#686b62">تم إرسال هذه الرسالة بعد تأكيد الدفع من Stripe.</p>
      </div>`
    })
  });
  if (!response.ok) throw new Error(`Email provider rejected request: ${response.status}`);
};

const saveOrder = async (session) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;
  const metadata = session.metadata || {};
  const customerEmail = session.customer_details?.email || session.customer_email || '';
  const items = String(metadata.items || '').split(',').filter(Boolean).map(item => {
    const separator = item.lastIndexOf(':');
    return { variant: separator >= 0 ? item.slice(0, separator) : item, quantity: Number(separator >= 0 ? item.slice(separator + 1) : 1) };
  });
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?on_conflict=stripe_session_id`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({
      order_number: metadata.order_id || session.client_reference_id || session.id,
      user_id: metadata.user_id || null,
      customer_email: customerEmail,
      customer_name: metadata.customer_name || '',
      customer_phone: metadata.phone || '',
      shipping_address: metadata.address || '',
      shipping_address_id: /^[0-9a-f-]{36}$/i.test(metadata.address_id || '') ? metadata.address_id : null,
      shipping_country_code: metadata.country_code || null,
      shipping_country_name: metadata.country_name || null,
      shipping_region: metadata.region || null,
      shipping_postal_code: metadata.postal_code || null,
      items,
      product_amount: Number(metadata.product_amount || 0),
      shipping_amount: Number(metadata.shipping_amount || 0),
      amount_total: session.amount_total || 0,
      currency: session.currency || 'aed',
      status: 'paid',
      stripe_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent || null,
      paid_at: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString()
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Order database rejected request: ${response.status} ${detail.slice(0, 300)}`);
  }
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
      await Promise.all([saveOrder(event.data.object), sendOrderEmail(event.data.object), updateInventory(event.data.object)]);
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Webhook failed' });
  }
}
