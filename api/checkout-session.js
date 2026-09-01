import { quoteShipping } from './shipping-quote.js';

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

    const grouped = {};
    for (const item of order.cart?.items || []) {
      const key = `${item.color}-${item.size}`;
      grouped[key] = (grouped[key] || 0) + 1;
    }
    const itemSummary = Object.entries(grouped).map(([key, count]) => `${key}:${count}`).join(',').slice(0, 500);
    const requestedItems = Object.entries(grouped).map(([variant, quantity]) => ({ variant, quantity }));
    const quantity = requestedItems.reduce((sum, item) => sum + item.quantity, 0);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return res.status(400).json({ error: 'كمية الطلب غير صحيحة' });
    const unitPrice = quantity >= 50 ? 18.5 : quantity >= 20 ? 389 / 20 : quantity >= 15 ? 309 / 15 : quantity >= 10 ? 219 / 10 : quantity >= 5 ? 119 / 5 : 25;
    const productAmount = Math.round(quantity * unitPrice * 100);
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
      const inventoryResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/check_inventory`, {
        method: 'POST',
        headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requested: requestedItems })
      });
      if (!inventoryResponse.ok) throw new Error('تعذر التحقق من توفر المخزون');
      const shortages = await inventoryResponse.json();
      const unavailable = shortages.filter(x => !x.allow_preorder);
      if (unavailable.length) return res.status(409).json({ error: `الكمية غير متوفرة حاليًا: ${unavailable.map(x => `${x.variant} (متاح ${x.available})`).join('، ')}` });
      order.preorders = shortages.filter(x => x.allow_preorder);
    }
    const customer = order.customer || {};
    const customerEmail = String(customer.email || '').trim().toLowerCase();
    const emailDomain = customerEmail.split('@')[1] || '';
    const commonDomainTypos = new Set(['gamil.com', 'gmial.com', 'gmai.com', 'gmail.co', 'hotnail.com', 'hotmai.com', 'outlok.com', 'yaho.com']);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return res.status(400).json({ error: 'اكتب بريدًا إلكترونيًا صحيحًا' });
    if (commonDomainTypos.has(emailDomain)) return res.status(400).json({ error: 'يبدو أن نطاق البريد مكتوب بشكل غير صحيح. راجع gmail أو مزود بريدك قبل الدفع.' });
    const countryCode = String(customer.country_code || '').trim().toUpperCase();
    const shipping = await quoteShipping(countryCode);
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
      customer_email: customerEmail,
      'payment_intent_data[receipt_email]': customerEmail,
      'payment_intent_data[description]': `AJLIB order ${String(order.id)}`,
      'invoice_creation[enabled]': 'true',
      'phone_number_collection[enabled]': 'true',
      'line_items[0][price_data][currency]': 'aed',
      'line_items[0][price_data][unit_amount]': String(productAmount),
      'line_items[0][price_data][product_data][name]': `AJLIB — ${quantity} قطع`,
      'line_items[0][price_data][product_data][description]': 'طلب مخصص حسب اللون والمقاس',
      'line_items[0][quantity]': '1',
      'metadata[order_id]': String(order.id),
      'metadata[items]': itemSummary,
      'metadata[customer_name]': String(customer.name || '').slice(0, 500),
      'metadata[phone]': String(customer.phone || '').slice(0, 500),
      'metadata[address_id]': String(customer.address_id || '').slice(0, 100),
      'metadata[country_code]': countryCode,
      'metadata[country_name]': String(customer.country_name || '').slice(0, 100),
      'metadata[region]': String(customer.region || '').slice(0, 100),
      'metadata[postal_code]': String(customer.postal_code || '').slice(0, 40),
      'metadata[address]': `${customer.address || ''}${customer.address_line2 ? `, ${customer.address_line2}` : ''}, ${customer.city || ''}, ${customer.region || ''}, ${customer.country_name || countryCode}, ${customer.postal_code || ''}`.slice(0, 500),
      'metadata[notes]': String(customer.notes || '').slice(0, 500),
      'metadata[product_amount]': String(productAmount),
      'metadata[shipping_amount]': String(shipping.amount),
      'metadata[shipping_zone]': shipping.zone_code,
      'metadata[user_id]': userId,
      'metadata[preorder]': (order.preorders||[]).map(x=>`${x.variant}:${x.preorder_eta||'سيحدد لاحقًا'}`).join(',').slice(0,500),
      success_url: `${origin}/?payment=success&id=${encodeURIComponent(order.id)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?payment=cancelled&id=${encodeURIComponent(order.id)}`
    });
    if (shipping.amount > 0) {
      params.set('line_items[1][price_data][currency]', 'aed');
      params.set('line_items[1][price_data][unit_amount]', String(shipping.amount));
      params.set('line_items[1][price_data][product_data][name]', `الشحن — ${shipping.zone_name}`);
      params.set('line_items[1][price_data][product_data][description]', `المدة التقديرية ${shipping.min_days}-${shipping.max_days} أيام عمل`);
      params.set('line_items[1][quantity]', '1');
    }
    const session = await stripeRequest('checkout/sessions', { method: 'POST', body: params });
    return res.status(200).json({ id: session.id, url: session.url });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'تعذر الاتصال ببوابة Stripe' });
  }
}
