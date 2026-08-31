const jsonHeaders = { 'Content-Type': 'application/json' };
const allowedStatuses = new Set(['paid', 'processing', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded']);
const statusLabels = {
  paid: 'تم الدفع', processing: 'قيد التجهيز', packed: 'جاهز للشحن',
  shipped: 'تم الشحن', delivered: 'تم التسليم', cancelled: 'تم إلغاء الطلب', refunded: 'تم استرجاع المبلغ'
};

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
}[char]));

const requireAdmin = async (authorization = '') => {
  const token = String(authorization).replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/is_admin`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, ...jsonHeaders },
    body: '{}'
  });
  return response.ok && (await response.json()) === true;
};

const databaseRequest = async (path, options = {}) => {
  const response = await fetch(`${process.env.SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      ...jsonHeaders,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || 'تعذر تحديث الطلب');
  return data;
};

const sendStatusEmail = async (order, previousStatus) => {
  if (!order.customer_email || order.status === previousStatus) return false;
  const tracking = order.tracking_number
    ? `<div style="background:#eef4ef;border-radius:12px;padding:14px;margin:18px 0"><b>شركة الشحن:</b> ${escapeHtml(order.shipping_company || 'سيتم تحديدها')}<br><b>رقم التتبع:</b> <span dir="ltr">${escapeHtml(order.tracking_number)}</span></div>`
    : '';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      ...jsonHeaders,
      'User-Agent': 'ajlib-store/1.0',
      'Idempotency-Key': `ajlib-status-${order.id}-${order.status}-${new Date(order.updated_at).getTime()}`
    },
    body: JSON.stringify({
      from: process.env.ORDER_FROM_EMAIL || 'AJLIB Orders <orders@ajlib.store>',
      to: [order.customer_email],
      reply_to: process.env.ORDER_NOTIFICATION_EMAIL || 'support@ajlib.store',
      subject: `تحديث طلب AJLIB ${order.order_number} — ${statusLabels[order.status]}`,
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.9;color:#171914;max-width:620px;margin:auto;border:1px solid #ded8ca;border-radius:18px;padding:28px">
        <div style="color:#b58a3c;font-weight:800">AJLIB</div>
        <h1 style="color:#26352d">تحديث حالة طلبك</h1>
        <p>مرحبًا ${escapeHtml(order.customer_name || 'عميل AJLIB')}،</p>
        <p>تم تحديث الطلب <b dir="ltr">${escapeHtml(order.order_number)}</b> إلى:</p>
        <div style="background:#26352d;color:#fff;border-radius:14px;padding:16px;text-align:center;font-size:20px;font-weight:800">${escapeHtml(statusLabels[order.status])}</div>
        ${tracking}
        <p>يمكنك متابعة آخر حالة من قسم «طلباتي» في <a href="https://www.ajlib.store/">موقع AJLIB</a>.</p>
        <p style="color:#686b62;font-size:13px">للمساعدة: support@ajlib.store · +971 50 110 9215</p>
      </div>`
    })
  });
  if (!response.ok) throw new Error('تم تحديث الطلب لكن تعذر إرسال البريد للعميل');
  return true;
};

export default async function handler(req, res) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY || !process.env.SUPABASE_PUBLISHABLE_KEY || !process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: 'خدمة إشعارات الطلبات غير مكتملة الإعداد' });
  }
  try {
    if (!(await requireAdmin(req.headers.authorization))) return res.status(403).json({ error: 'هذه العملية متاحة لإدارة AJLIB فقط' });
    const id = String(req.body?.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'رقم الطلب الداخلي غير صحيح' });

    const current = await databaseRequest(`/rest/v1/orders?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!current?.[0]) return res.status(404).json({ error: 'الطلب غير موجود' });
    const previous = current[0];
    const updates = {};
    if (req.body.status !== undefined) {
      if (!allowedStatuses.has(req.body.status)) return res.status(400).json({ error: 'حالة الطلب غير مدعومة' });
      updates.status = req.body.status;
    }
    if (req.body.shipping_company !== undefined) updates.shipping_company = String(req.body.shipping_company || '').slice(0, 120) || null;
    if (req.body.tracking_number !== undefined) updates.tracking_number = String(req.body.tracking_number || '').slice(0, 180) || null;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'لا توجد تغييرات للحفظ' });

    const updated = await databaseRequest(`/rest/v1/orders?id=eq.${encodeURIComponent(id)}&select=*`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(updates)
    });
    const order = updated?.[0];
    const emailSent = updates.status ? await sendStatusEmail(order, previous.status) : false;
    return res.status(200).json({ order, emailSent });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'تعذر تحديث الطلب' });
  }
}
