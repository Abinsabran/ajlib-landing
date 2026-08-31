const jsonHeaders = { 'Content-Type': 'application/json' };

const stripeGet = async (path) => {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'تعذر قراءة Stripe');
  return data;
};

const supabaseFetch = (path, options = {}) => fetch(`${process.env.SUPABASE_URL}${path}`, {
  ...options,
  headers: {
    apikey: process.env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    ...jsonHeaders,
    ...(options.headers || {})
  }
});

const requireOwner = async (authorization = '') => {
  const token = String(authorization).replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/is_admin`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      ...jsonHeaders
    },
    body: '{}'
  });
  return response.ok && (await response.json()) === true;
};

const parseMetadataItems = (value = '') => String(value).split(',').filter(Boolean).map(item => {
  const separator = item.lastIndexOf(':');
  return {
    variant: separator >= 0 ? item.slice(0, separator) : item,
    quantity: Number(separator >= 0 ? item.slice(separator + 1) : 1) || 1
  };
});

const historicalItems = async (session) => {
  const fromMetadata = parseMetadataItems(session.metadata?.items);
  if (fromMetadata.length) return fromMetadata;
  const lineItems = await stripeGet(`checkout/sessions/${encodeURIComponent(session.id)}/line_items?limit=100`);
  return (lineItems.data || []).map(item => ({
    variant: item.description || 'منتج AJLIB قديم',
    quantity: Number(item.quantity) || 1
  }));
};

const formattedAddress = (session) => {
  if (session.metadata?.address) return session.metadata.address;
  const address = session.customer_details?.address;
  if (!address) return '';
  return [address.line1, address.line2, address.city, address.state, address.country].filter(Boolean).join(', ');
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY || !process.env.SUPABASE_PUBLISHABLE_KEY) {
    return res.status(503).json({ error: 'خدمة المزامنة غير مكتملة الإعداد' });
  }
  try {
    if (!(await requireOwner(req.headers.authorization))) return res.status(403).json({ error: 'هذه العملية متاحة لمالك AJLIB فقط' });

    const sessions = [];
    let startingAfter = '';
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ limit: '100', status: 'complete' });
      if (startingAfter) query.set('starting_after', startingAfter);
      const result = await stripeGet(`checkout/sessions?${query}`);
      sessions.push(...(result.data || []).filter(session => session.payment_status === 'paid'));
      if (!result.has_more || !result.data?.length) break;
      startingAfter = result.data[result.data.length - 1].id;
    }

    const existingResponse = await supabaseFetch('/rest/v1/orders?select=stripe_session_id');
    if (!existingResponse.ok) throw new Error('تعذر قراءة سجل الطلبات الحالي');
    const existing = new Set((await existingResponse.json()).map(order => order.stripe_session_id));

    const usersResponse = await supabaseFetch('/auth/v1/admin/users?per_page=1000');
    const usersPayload = usersResponse.ok ? await usersResponse.json() : { users: [] };
    const usersByEmail = new Map((usersPayload.users || []).map(user => [String(user.email || '').toLowerCase(), user.id]));

    let imported = 0;
    let skipped = 0;
    for (const session of sessions) {
      if (existing.has(session.id)) { skipped += 1; continue; }
      const metadata = session.metadata || {};
      const email = String(session.customer_details?.email || session.customer_email || '').toLowerCase();
      if (!email) { skipped += 1; continue; }
      const items = await historicalItems(session);
      const orderNumber = metadata.order_id || session.client_reference_id || `AJ-${String(session.payment_intent || session.id).slice(-8).toUpperCase()}`;
      const payload = {
        order_number: orderNumber,
        user_id: metadata.user_id || usersByEmail.get(email) || null,
        customer_email: email,
        customer_name: metadata.customer_name || session.customer_details?.name || 'عميل AJLIB',
        customer_phone: metadata.phone || session.customer_details?.phone || '',
        shipping_address: formattedAddress(session),
        items,
        amount_total: session.amount_total || 0,
        currency: session.currency || 'aed',
        status: 'paid',
        stripe_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent || null,
        paid_at: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        created_at: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString()
      };
      const insertResponse = await supabaseFetch('/rest/v1/orders', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(payload)
      });
      if (!insertResponse.ok) {
        const detail = await insertResponse.text();
        if (insertResponse.status === 409) { skipped += 1; continue; }
        throw new Error(`تعذر استيراد الطلب ${orderNumber}: ${detail.slice(0, 180)}`);
      }
      imported += 1;
    }
    return res.status(200).json({ imported, skipped, examined: sessions.length });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'تعذرت مزامنة الطلبات القديمة' });
  }
}
