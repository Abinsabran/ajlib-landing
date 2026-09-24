import crypto from 'node:crypto';
import { buildValidatedOrder, OrderValidationError } from './_lib/order-validation.js';
import { parsePaymentCurrency, paymentAmounts, PaymentCurrencyError } from './_lib/payment-currency.js';
import { createZiinaIntent, getZiinaIntent, ZIINA_COMPLETED_STATUS, ZIINA_TERMINAL_FAILURES } from './_lib/ziina-client.js';
import { persistPaidOrder } from './stripe-webhook.js';

// One Vercel function handles the hidden checkout, read-only payment check,
// and signed webhook. All three are disabled safely when credentials are
// absent. Body parsing is off so the HMAC covers Ziina's exact raw bytes.
export const config = { api: { bodyParser: false }, maxDuration: 60 };
const WEBHOOK_IPS = new Set(['3.29.184.186', '3.29.190.95', '20.233.47.127', '13.202.161.181']);
const dbHeaders = () => ({
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
  'Content-Type': 'application/json'
});
const db = (path, options = {}) => fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
  ...options, headers: { ...dbHeaders(), ...(options.headers || {}) }
});
const readRaw = async (req) => {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  const chunks = [];
  for await (const part of req) chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  return Buffer.concat(chunks);
};
const safeJson = async (response) => {
  try { return await response.json(); } catch { return null; }
};
const jsonBody = (raw) => { try { return JSON.parse(raw.toString('utf8')); } catch { return null; } };
const uuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
const orderNumber = (value) => /^AJ[0-9]{8}$/.test(String(value || ''));

export const verifyZiinaWebhook = (raw, signature, secret, ip) => {
  if (!secret || !WEBHOOK_IPS.has(String(ip || '').trim()) || !/^[a-f0-9]{64}$/i.test(String(signature || ''))) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

const isOwner = async (token) => {
  if (!token || !process.env.SUPABASE_PUBLISHABLE_KEY) return false;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/is_admin`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}'
  });
  return response.ok && (await safeJson(response)) === true;
};

const loadAttempt = async (paymentId) => {
  const response = await db(`ziina_payment_attempts?provider_payment_id=eq.${encodeURIComponent(paymentId)}&select=*`);
  if (!response.ok) throw new Error('Payment record lookup failed');
  return (await response.json())[0] || null;
};

const patchAttempt = async (id, values) => {
  const response = await db(`ziina_payment_attempts?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ ...values, updated_at: new Date().toISOString() })
  });
  if (!response.ok) throw new Error('Payment record update failed');
};

const snapshotFor = (order, validated, charge) => {
  const { customer, customerEmail, countryCode, itemSummary, productAmount, shipping, userId, preorders } = validated;
  return {
    customer_email: customerEmail,
    metadata: {
      order_id: String(order.id), items: itemSummary,
      customer_name: String(customer.name || '').slice(0, 500),
      phone: String(customer.phone || '').slice(0, 500),
      address_id: String(customer.address_id || '').slice(0, 100),
      country_code: countryCode,
      country_name: String(customer.country_name || '').slice(0, 100),
      region: String(customer.region || '').slice(0, 100),
      city: String(customer.city || '').slice(0, 100),
      street: String(customer.address || '').trim().slice(0, 200),
      street2: String(customer.address_line2 || '').trim().slice(0, 200),
      postal_code: String(customer.postal_code || '').slice(0, 40),
      address: `${customer.address || ''}${customer.address_line2 ? `, ${customer.address_line2}` : ''}, ${customer.city || ''}, ${customer.region || ''}, ${customer.country_name || countryCode}, ${customer.postal_code || ''}`.slice(0, 500),
      notes: String(customer.notes || '').slice(0, 500),
      product_amount: String(productAmount),
      shipping_amount: String(shipping.amount),
      shipping_zone: shipping.zone_code,
      canonical_total_aed: String(charge.canonicalTotalAed),
      payment_currency: charge.currency,
      payment_amount: String(charge.total),
      user_id: userId,
      preorder: (preorders || []).map(x => `${x.variant}:${x.preorder_eta || 'سيحدد لاحقًا'}`).join(',').slice(0, 500)
    }
  };
};

const createCheckout = async (req, res, body) => {
  if (process.env.ZIINA_ENABLED !== 'true') return res.status(503).json({ error: 'الدفع غير متاح حاليًا' });
  if (!process.env.ZIINA_WEBHOOK_SECRET) return res.status(503).json({ error: 'التحقق من الدفع غير مهيأ' });
  if (process.env.ZIINA_ROLLOUT !== 'public') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!(await isOwner(token))) return res.status(403).json({ error: 'الدفع التجريبي غير متاح' });
  }
  const order = body || {};
  if (!orderNumber(order.id)) return res.status(400).json({ error: 'رقم الطلب غير صحيح' });
  let currency, validated;
  try {
    currency = parsePaymentCurrency(order.payment_currency);
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    validated = await buildValidatedOrder(order, { accessToken: token });
  } catch (error) {
    if (error instanceof PaymentCurrencyError) return res.status(400).json({ error: error.message });
    if (error instanceof OrderValidationError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  const charge = paymentAmounts({ productAmountFils: validated.productAmount, shippingAmountFils: validated.shipping.amount, currency });
  const reservation = await db('ziina_payment_attempts?select=id', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      order_number: order.id, currency, amount: charge.total,
      canonical_total_aed: charge.canonicalTotalAed,
      is_test: process.env.ZIINA_TEST_MODE === 'true',
      order_snapshot: snapshotFor(order, validated, charge)
    })
  });
  if (reservation.status === 409) return res.status(409).json({ error: 'هذا الطلب لديه عملية دفع قيد المعالجة' });
  if (!reservation.ok) throw new Error('Payment reservation failed');
  const attempt = (await reservation.json())[0];
  if (!attempt?.id) throw new Error('Payment reservation unconfirmed');

  // The origin is configured server-side, never taken from the Host header.
  const origin = process.env.ZIINA_RETURN_ORIGIN || 'https://www.ajlib.store';
  let returnUrl;
  try { returnUrl = new URL(origin); } catch { throw new Error('Invalid payment return origin'); }
  if (returnUrl.protocol !== 'https:' || returnUrl.username || returnUrl.password || returnUrl.search || returnUrl.hash || returnUrl.pathname !== '/') {
    throw new Error('Invalid payment return origin');
  }
  const returnBase = `${origin}/?id=${encodeURIComponent(order.id)}&payment_intent_id={PAYMENT_INTENT_ID}`;
  try {
    const intent = await createZiinaIntent({
      amount: charge.total, currency: currency.toUpperCase(), orderNumber: order.id,
      successUrl: `${returnBase}&ziina=success`,
      cancelUrl: `${returnBase}&ziina=cancelled`,
      failureUrl: `${returnBase}&ziina=failed`
    });
    if (!uuid(intent?.id) || !String(intent.redirect_url || '').startsWith('https://') || Number(intent.amount) !== charge.total || String(intent.currency_code).toLowerCase() !== currency) {
      throw new Error('Invalid payment intent response');
    }
    await patchAttempt(attempt.id, {
      provider_payment_id: intent.id, provider_operation_id: intent.operation_id || null,
      state: 'ready', redirect_url: intent.redirect_url
    });
    return res.status(200).json({ id: intent.id, url: intent.redirect_url });
  } catch {
    // Ziina's create request schema does not document an operation_id input.
    // Do not blindly retry a possibly accepted request and risk a double charge.
    await patchAttempt(attempt.id, { state: 'indeterminate' });
    return res.status(502).json({ error: 'تعذر تجهيز الدفع؛ يُرجى التواصل معنا قبل إعادة المحاولة' });
  }
};

export const settleVerifiedZiinaPayment = async (paymentId) => {
  if (!uuid(paymentId)) return { status: 'invalid', paid: false };
  const attempt = await loadAttempt(paymentId);
  if (!attempt) throw new Error('Payment record not yet linked');
  const intent = await getZiinaIntent(paymentId);
  if (intent?.id !== paymentId || Number(intent.amount) !== attempt.amount || String(intent.currency_code || '').toLowerCase() !== attempt.currency ||
      (attempt.provider_operation_id && intent.operation_id !== attempt.provider_operation_id)) {
    throw new Error('Payment verification mismatch');
  }
  const status = String(intent.status || '');
  if (ZIINA_TERMINAL_FAILURES.has(status)) {
    await patchAttempt(attempt.id, { state: status });
    return { status, paid: false };
  }
  if (status !== ZIINA_COMPLETED_STATUS) return { status, paid: false };
  if (attempt.is_test) {
    // Ziina's test=true intent does not collect money. Never turn a test
    // completion into a paid AJLIB order or a real CJ fulfillment request.
    await patchAttempt(attempt.id, { state: 'completed' });
    return { status, paid: false, test: true };
  }
  if (attempt.state === 'completed') return { status, paid: true, order_id: attempt.order_number };
  // Ziina settles foreign-currency payments to the AED merchant wallet at
  // its live FX rate. The fulfillment profit guard must see that real AED
  // amount, not just AJLIB's displayed canonical conversion.
  const settledAed = Number(intent.settled?.amount);
  if (String(intent.settled?.currency_code || '').toUpperCase() !== 'AED' || !Number.isSafeInteger(settledAed) || settledAed <= 0) {
    throw new Error('AED settlement amount unavailable');
  }
  const snapshot = attempt.order_snapshot;
  if (!snapshot?.metadata || snapshot.metadata.order_id !== attempt.order_number ||
      Number(snapshot.metadata.canonical_total_aed) !== attempt.canonical_total_aed) throw new Error('Stored quote mismatch');
  const createdMs = Number(intent.created_at);
  const normalized = {
    id: `ziina_${paymentId}`, provider: 'ziina', provider_payment_id: paymentId,
    provider_operation_id: intent.operation_id || null,
    // The documented fee_amount has no documented currency denomination.
    // Retain it for reconciliation, but do not use it in profit math yet.
    provider_fee_amount: intent.fee_amount !== null && intent.fee_amount !== undefined && Number.isSafeInteger(Number(intent.fee_amount)) ? Number(intent.fee_amount) : null,
    provider_fee_currency: null,
    provider_settled_amount_aed: settledAed,
    metadata: snapshot.metadata, customer_email: snapshot.customer_email,
    amount_total: attempt.amount, currency: attempt.currency,
    payment_intent: null,
    created: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : null
  };
  const saved = await persistPaidOrder(normalized);
  if (!saved?.id || saved.order_number !== attempt.order_number) throw new Error('Paid order persistence unconfirmed');
  await patchAttempt(attempt.id, { state: 'completed', provider_fee_amount: normalized.provider_fee_amount, provider_settled_amount_aed: settledAed });
  return { status, paid: true, order_id: attempt.order_number };
};

export default async function handler(req, res) {
  res.setHeader?.('Cache-Control', 'no-store');
  const action = String(req.query?.action || '');
  if (action === 'availability') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const configured = process.env.ZIINA_ENABLED === 'true' && !!process.env.ZIINA_API_KEY && !!process.env.ZIINA_WEBHOOK_SECRET &&
      !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const available = configured && (process.env.ZIINA_ROLLOUT === 'public' || await isOwner(token));
    return res.status(200).json({ available });
  }
  if (!process.env.ZIINA_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    return res.status(503).json({ error: 'بوابة الدفع غير مهيأة' });
  }
  try {
    if (action === 'webhook') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const raw = await readRaw(req);
      // Vercel overwrites x-forwarded-for; its own x-vercel-forwarded-for is
      // preferred when available. Ziina requires BOTH an allowlisted source
      // address and the HMAC of the exact request body.
      const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '').trim();
      if (!verifyZiinaWebhook(raw, req.headers['x-hmac-signature'], process.env.ZIINA_WEBHOOK_SECRET, ip)) {
        return res.status(401).json({ error: 'Invalid webhook' });
      }
      const event = jsonBody(raw);
      if (!event || event.event !== 'payment_intent.status.updated' || !uuid(event.data?.id)) return res.status(200).json({ received: true });
      await settleVerifiedZiinaPayment(event.data.id);
      return res.status(200).json({ received: true });
    }
    if (action === 'checkout') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const body = req.body && typeof req.body === 'object' ? req.body : jsonBody(await readRaw(req));
      if (!body) return res.status(400).json({ error: 'طلب غير صحيح' });
      return createCheckout(req, res, body);
    }
    if (action === 'verify') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const result = await settleVerifiedZiinaPayment(String(req.query?.payment_intent_id || ''));
      return res.status(result.status === 'unknown' ? 404 : 200).json(result);
    }
    return res.status(404).json({ error: 'Not found' });
  } catch {
    // Never return provider errors, secrets, customer data or the stored
    // order snapshot to an untrusted client.
    return res.status(502).json({ error: 'تعذر التحقق من الدفع حاليًا' });
  }
}
