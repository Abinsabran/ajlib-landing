const stripeRequest = async (path, options = {}) => {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(options.headers || {})
    }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Stripe request failed');
  return result;
};

export default async function handler(req, res) {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'الدفع الإلكتروني غير مفعّل بعد' });

  try {
    if (req.method === 'GET') {
      const sessionId = String(req.query.session_id || '');
      if (!sessionId.startsWith('cs_')) return res.status(400).json({ error: 'جلسة غير صحيحة' });
      const session = await stripeRequest(`checkout/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
      return res.status(200).json({ id: session.id, payment_status: session.payment_status, order_id: session.client_reference_id });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const order = req.body || {};
    const amount = Math.round(Number(order.amount) * 100);
    if (!Number.isInteger(amount) || amount < 200) return res.status(400).json({ error: 'قيمة الطلب غير صحيحة' });

    const grouped = {};
    for (const item of order.cart?.items || []) {
      const key = `${item.color}-${item.size}`;
      grouped[key] = (grouped[key] || 0) + 1;
    }
    const itemSummary = Object.entries(grouped).map(([key, count]) => `${key}:${count}`).join(',').slice(0, 500);
    const customer = order.customer || {};
    let userId = '';
    const accessToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (accessToken && process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY) {
      const authResponse = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${accessToken}` }
      });
      if (authResponse.ok) userId = String((await authResponse.json()).id || '');
    }
    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const params = new URLSearchParams({
      mode: 'payment',
      ui_mode: 'hosted_page',
      client_reference_id: String(order.id),
      customer_email: String(customer.email || ''),
      'payment_intent_data[receipt_email]': String(customer.email || ''),
      'payment_intent_data[description]': `AJLIB order ${String(order.id)}`,
      'invoice_creation[enabled]': 'true',
      'phone_number_collection[enabled]': 'true',
      'line_items[0][price_data][currency]': 'aed',
      'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][price_data][product_data][name]': `AJLIB — ${order.cart?.pack?.n || 1} قطع`,
      'line_items[0][price_data][product_data][description]': 'طلب مخصص حسب اللون والمقاس',
      'line_items[0][quantity]': '1',
      'metadata[order_id]': String(order.id),
      'metadata[items]': itemSummary,
      'metadata[customer_name]': String(customer.name || '').slice(0, 500),
      'metadata[phone]': String(customer.phone || '').slice(0, 500),
      'metadata[address]': `${customer.emirate || ''}, ${customer.city || ''}, ${customer.address || ''}`.slice(0, 500),
      'metadata[notes]': String(customer.notes || '').slice(0, 500),
      'metadata[user_id]': userId,
      success_url: `${origin}/?payment=success&id=${encodeURIComponent(order.id)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?payment=cancelled&id=${encodeURIComponent(order.id)}`
    });
    const session = await stripeRequest('checkout/sessions', { method: 'POST', body: params });
    return res.status(200).json({ id: session.id, url: session.url });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'تعذر الاتصال ببوابة Stripe' });
  }
}
