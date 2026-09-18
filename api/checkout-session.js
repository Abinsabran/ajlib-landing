import { buildValidatedOrder, OrderValidationError } from './_lib/order-validation.js';

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
      const paymentIntentId = String(req.query.payment_intent_id || '');
      if (sessionId) {
        if (!sessionId.startsWith('cs_')) return res.status(400).json({ error: 'جلسة غير صحيحة' });
        const session = await stripeRequest(`checkout/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
        return res.status(200).json({ id: session.id, payment_status: session.payment_status, order_id: session.client_reference_id });
      }
      if (paymentIntentId) {
        if (!paymentIntentId.startsWith('pi_')) return res.status(400).json({ error: 'جلسة غير صحيحة' });
        const intent = await stripeRequest(`payment_intents/${encodeURIComponent(paymentIntentId)}`, { method: 'GET' });
        return res.status(200).json({ id: intent.id, payment_status: intent.status === 'succeeded' ? 'paid' : intent.status, order_id: intent.metadata?.order_id || '' });
      }
      return res.status(400).json({ error: 'جلسة غير صحيحة' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const order = req.body || {};

    let validated;
    try {
      const accessToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      validated = await buildValidatedOrder(order, { accessToken });
    } catch (error) {
      if (error instanceof OrderValidationError) return res.status(error.status).json({ error: error.message });
      throw error; // falls through to the outer catch below, same as before extraction
    }
    const { quantity, itemSummary, productAmount, shipping, customer, customerEmail, countryCode, userId, preorders } = validated;
    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const metadataFields = {
      'metadata[order_id]': String(order.id),
      'metadata[items]': itemSummary,
      'metadata[customer_name]': String(customer.name || '').slice(0, 500),
      'metadata[phone]': String(customer.phone || '').slice(0, 500),
      'metadata[address_id]': String(customer.address_id || '').slice(0, 100),
      'metadata[country_code]': countryCode,
      'metadata[country_name]': String(customer.country_name || '').slice(0, 100),
      'metadata[region]': String(customer.region || '').slice(0, 100),
      // Carried as its own field (not only flattened into metadata[address]
      // below) so it can be persisted structurally — CJ's createOrderV2
      // requires shippingCity as a distinct value and must never have it
      // parsed back out of a free-text address.
      'metadata[city]': String(customer.city || '').slice(0, 100),
      'metadata[postal_code]': String(customer.postal_code || '').slice(0, 40),
      'metadata[address]': `${customer.address || ''}${customer.address_line2 ? `, ${customer.address_line2}` : ''}, ${customer.city || ''}, ${customer.region || ''}, ${customer.country_name || countryCode}, ${customer.postal_code || ''}`.slice(0, 500),
      'metadata[notes]': String(customer.notes || '').slice(0, 500),
      'metadata[product_amount]': String(productAmount),
      'metadata[shipping_amount]': String(shipping.amount),
      'metadata[shipping_zone]': shipping.zone_code,
      'metadata[user_id]': userId,
      'metadata[preorder]': (preorders||[]).map(x=>`${x.variant}:${x.preorder_eta||'سيحدد لاحقًا'}`).join(',').slice(0,500)
    };

    // Native iOS/Android checkout (Expo app via Stripe PaymentSheet) needs a
    // PaymentIntent client secret, not a hosted Checkout Session URL. The web
    // storefront's hosted_page flow below is unchanged.
    if (order.mobile === true) {
      if (!process.env.STRIPE_PUBLISHABLE_KEY) return res.status(503).json({ error: 'الدفع عبر التطبيق غير مفعّل بعد' });
      const intentParams = new URLSearchParams({
        amount: String(productAmount + shipping.amount),
        currency: 'aed',
        receipt_email: customerEmail,
        description: `AJLIB order ${String(order.id)}`,
        'automatic_payment_methods[enabled]': 'true',
        ...metadataFields
      });
      const intent = await stripeRequest('payment_intents', { method: 'POST', body: intentParams });
      return res.status(200).json({ id: intent.id, clientSecret: intent.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
    }

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
      ...metadataFields,
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
