import { quoteShipping } from '../shipping-quote.js';
import { computeProductPricing, MIN_QUANTITY, MAX_QUANTITY } from './pricing.js';

// The single authoritative place that turns a raw client-submitted order
// (cart items + customer/shipping details) into validated, server-computed
// numbers. Extracted verbatim from api/checkout-session.js's original inline
// logic — every status code and error message below is unchanged from what
// checkout-session.js already returned. Both the Stripe checkout paths
// (api/checkout-session.js) and the Tabby checkout resource
// (api/commerce.js, resource=tabby-checkout) call this instead of each
// re-implementing quantity/pricing/inventory/email/shipping validation.
// Neither ever trusts a client-submitted price or total.
export class OrderValidationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const COMMON_DOMAIN_TYPOS = new Set(['gamil.com', 'gmial.com', 'gmai.com', 'gmail.co', 'hotnail.com', 'hotmai.com', 'outlok.com', 'yaho.com']);

export const buildValidatedOrder = async (order, { accessToken } = {}) => {
  const grouped = {};
  for (const item of order.cart?.items || []) {
    const key = `${item.color}-${item.size}`;
    grouped[key] = (grouped[key] || 0) + 1;
  }
  const itemSummary = Object.entries(grouped).map(([key, count]) => `${key}:${count}`).join(',').slice(0, 500);
  const requestedItems = Object.entries(grouped).map(([variant, quantity]) => ({ variant, quantity }));
  const quantity = requestedItems.reduce((sum, item) => sum + item.quantity, 0);
  if (!Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
    throw new OrderValidationError(400, 'كمية الطلب غير صحيحة');
  }
  const { productAmount } = computeProductPricing(quantity);

  let preorders = [];
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
    const inventoryResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/check_inventory`, {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requested: requestedItems })
    });
    if (!inventoryResponse.ok) throw new OrderValidationError(502, 'تعذر التحقق من توفر المخزون');
    const shortages = await inventoryResponse.json();
    const unavailable = shortages.filter(x => !x.allow_preorder);
    if (unavailable.length) {
      throw new OrderValidationError(409, `الكمية غير متوفرة حاليًا: ${unavailable.map(x => `${x.variant} (متاح ${x.available})`).join('، ')}`);
    }
    preorders = shortages.filter(x => x.allow_preorder);
  }

  const customer = order.customer || {};
  const customerEmail = String(customer.email || '').trim().toLowerCase();
  const emailDomain = customerEmail.split('@')[1] || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new OrderValidationError(400, 'اكتب بريدًا إلكترونيًا صحيحًا');
  if (COMMON_DOMAIN_TYPOS.has(emailDomain)) throw new OrderValidationError(400, 'يبدو أن نطاق البريد مكتوب بشكل غير صحيح. راجع gmail أو مزود بريدك قبل الدفع.');

  const countryCode = String(customer.country_code || '').trim().toUpperCase();
  const shipping = await quoteShipping(countryCode); // may throw a plain Error — callers let it propagate, matching prior behavior

  let userId = '';
  if (accessToken && process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY) {
    const authResponse = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${accessToken}` }
    });
    if (authResponse.ok) userId = String((await authResponse.json()).id || '');
  }

  return { quantity, itemSummary, requestedItems, productAmount, shipping, customer, customerEmail, countryCode, userId, preorders };
};
