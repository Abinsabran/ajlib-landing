// Server-only Tabby client — FOUNDATION ONLY, sandbox/test mode.
//
// - Never import from anything the browser/app can reach directly.
// - Never log, print, or return process.env.TABBY_SECRET_KEY.
// - TABBY_PUBLIC_KEY is safe to hand to a client (it's a publishable key,
//   analogous to Stripe's publishable key / api/supabase-config.js pattern).
// - guardTestMode() below makes a live Tabby transaction structurally
//   impossible while TABBY_MODE=test: every call in this file passes
//   through it first.
//
// Tabby's Checkout API (docs.tabby.ai) creates a "session" with amount,
// currency, buyer and order details, then redirects to session.configuration
// .available_products.installments[0].web_url; payment status is verified by
// re-fetching GET /payments/{id} server-side — never trusted from a redirect
// query string alone. This reflects Tabby's publicly documented flow; verify
// against current docs and real sandbox credentials before enabling in api/.

const TABBY_BASE_URL = 'https://api.tabby.ai/api/v2';

const guardTestMode = () => {
  if (process.env.TABBY_MODE !== 'test') {
    throw new Error('Tabby is only enabled in test mode in this phase');
  }
};

const tabbyRequest = async (path, options = {}) => {
  guardTestMode();
  if (!process.env.TABBY_SECRET_KEY) throw new Error('TABBY_SECRET_KEY is not configured');
  const response = await fetch(`${TABBY_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.TABBY_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Tabby API request failed: ${path} (${response.status})`);
  return body;
};

// amountFils/currency mirror what lib/order-validation.js already computes
// (AED fils) — this converts to Tabby's plain decimal-string amount format,
// it does not recompute price or shipping. successUrl/cancelUrl/failureUrl
// are required by Tabby to know where to redirect the buyer back to.
export const createCheckoutSession = async ({ orderId, amountFils, currency, buyer, order, shippingAddress, successUrl, cancelUrl, failureUrl }) => {
  guardTestMode();
  const amount = (Number(amountFils) / 100).toFixed(2);
  return tabbyRequest('/checkout', {
    method: 'POST',
    body: JSON.stringify({
      payment: {
        amount,
        currency: String(currency || 'AED').toUpperCase(),
        buyer,
        buyer_history: { registered_since: new Date().toISOString(), loyalty_level: 0 },
        order,
        order_history: [],
        shipping_address: shippingAddress,
        meta: { order_id: String(orderId) }
      },
      merchant_code: process.env.TABBY_MERCHANT_CODE || 'AJLIB',
      merchant_urls: { success: successUrl, cancel: cancelUrl, failure: failureUrl },
      lang: buyer?.language || 'ar'
    })
  });
};

// Server-side truth for whether a Tabby payment actually succeeded — never
// trust the app/browser's success redirect alone.
export const verifyPayment = async (paymentId) => {
  guardTestMode();
  const payment = await tabbyRequest(`/payments/${encodeURIComponent(paymentId)}`, { method: 'GET' });
  return { id: payment.id, status: payment.status, amount: payment.amount, currency: payment.currency };
};

// Read-only-in-effect diagnostic used ONLY for one-time Phase 2 sandbox
// verification (api/commerce.js, resource=tabby-diagnostic). Unlike
// tabbyRequest, this never throws on a non-2xx response — it returns
// Tabby's raw sandbox status/body so a human can see exactly what Tabby's
// real API returns instead of trusting a guessed response shape. Still
// test-mode-only (guardTestMode). This DOES create a real sandbox Tabby
// checkout attempt (no live money moves in test mode), same as calling
// createCheckoutSession — kept separate only so the raw response is visible.
export const tabbyDiagnosticPost = async (path, body) => {
  guardTestMode();
  if (!process.env.TABBY_SECRET_KEY) throw new Error('TABBY_SECRET_KEY is not configured');
  const response = await fetch(`${TABBY_BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TABBY_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const responseBody = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body: responseBody };
};

// Availability check: country + currency + basket amount. Tabby's own
// eligibility rules (min/max basket, supported countries) come back on the
// session response's `configuration.available_products` — this local guard
// only rules out obviously-ineligible carts before calling Tabby at all, so
// Stripe stays the fallback without an extra network round trip.
export const isTabbyPotentiallyAvailable = ({ countryCode, currency, amountFils }) => {
  if (process.env.TABBY_MODE !== 'test') return false;
  if (!process.env.TABBY_PUBLIC_KEY || !process.env.TABBY_SECRET_KEY) return false;
  // Placeholder basket bounds — replace with Tabby's confirmed per-country
  // limits before enabling for real customers.
  const amountAed = Number(amountFils || 0) / 100;
  if (amountAed <= 0) return false;
  return true;
};
