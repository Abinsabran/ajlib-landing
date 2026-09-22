const jsonHeaders = { 'Content-Type': 'application/json' };
const allowedStatuses = new Set(['paid', 'processing', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded']);

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

export default async function handler(req, res) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY || !process.env.SUPABASE_PUBLISHABLE_KEY) {
    return res.status(503).json({ error: 'خدمة إشعارات الطلبات غير مكتملة الإعداد' });
  }
  try {
    if (!(await requireAdmin(req.headers.authorization))) return res.status(403).json({ error: 'هذه العملية متاحة لإدارة AJLIB فقط' });
    const id = String(req.body?.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'رقم الطلب الداخلي غير صحيح' });

    const current = await databaseRequest(`/rest/v1/orders?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!current?.[0]) return res.status(404).json({ error: 'الطلب غير موجود' });
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
    // The database trigger queues email + push in the same transaction as a
    // real customer-stage change. The cron worker delivers them separately.
    return res.status(200).json({ order, emailSent: false,
      notificationQueued: Boolean(updates.status && updates.status !== current[0].status &&
        ['paid','processing','packed','shipped','delivered'].includes(order?.status)) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'تعذر تحديث الطلب' });
  }
}
