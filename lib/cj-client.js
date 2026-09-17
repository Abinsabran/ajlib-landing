// Server-only CJdropshipping API client — FOUNDATION ONLY.
//
// - Never import this from anything the browser/app can reach directly.
// - Never log, print, or return process.env.CJ_API_KEY or any token it
//   produces. Every function below only ever returns the minimal fields a
//   caller needs (a status string, a tracking number, etc).
// - No function in this file is called from anywhere yet. Live order
//   creation is intentionally NOT implemented — see createFulfillmentOrder
//   below, which throws until explicitly enabled for a specific order after
//   payment is verified server-side.
//
// CJ's v2 API (developers.cjdropshipping.com/api2.0) authenticates with an
// access token obtained from an email + API key, then a refresh token for
// renewal. The exact getAccessToken/refreshAccessToken request/response
// shape below reflects CJ's publicly documented v2 flow as of this writing —
// verify it against the current CJ developer docs and a real CJ_API_KEY in
// the Vercel environment before relying on it; this repo has no network
// access to CJ's API to verify it live.

const CJ_BASE_URL = 'https://developers.cjdropshipping.com/api2.0/v1';

let cachedToken = null; // { accessToken, expiresAt } — memory-only; a cold
// serverless start loses this, which is fine: getAccessToken() re-fetches.

const cjRequest = async (path, options = {}) => {
  const response = await fetch(`${CJ_BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.result === false) {
    // Never include request headers/body (may carry the token) in the thrown error.
    throw new Error(`CJ API request failed: ${path} (${response.status})`);
  }
  return body;
};

export const getAccessToken = async () => {
  if (!process.env.CJ_API_KEY) throw new Error('CJ_API_KEY is not configured');
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.accessToken;

  const body = await cjRequest('/authentication/getAccessToken', {
    method: 'POST',
    body: JSON.stringify({ apiKey: process.env.CJ_API_KEY })
  });
  const accessToken = body.data?.accessToken;
  const expiryDate = body.data?.accessTokenExpiryDate;
  if (!accessToken) throw new Error('CJ did not return an access token');
  cachedToken = { accessToken, expiresAt: expiryDate ? new Date(expiryDate).getTime() : Date.now() + 3_600_000 };
  return accessToken;
};

// TEMPORARY: Phase 3 diagnostic only. Fetches a fresh access-token response
// and returns it with every token-like field redacted, to find any
// store/shop identifier CJ returns alongside the token. Never returns
// accessToken/refreshToken values themselves.
export const rawAuthInfo = async () => {
  if (!process.env.CJ_API_KEY) throw new Error('CJ_API_KEY is not configured');
  const response = await fetch(`${CJ_BASE_URL}/authentication/getAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: process.env.CJ_API_KEY })
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  const redacted = JSON.parse(JSON.stringify(body), (key, value) => {
    if (/token/i.test(key) && typeof value === 'string') return `[REDACTED length=${value.length}]`;
    return value;
  });
  return { status: response.status, body: redacted };
};

const authorizedRequest = async (path, options = {}) => {
  const accessToken = await getAccessToken();
  return cjRequest(path, { ...options, headers: { 'CJ-Access-Token': accessToken, ...(options.headers || {}) } });
};

// Read-only lookup for a product family's variants (colors/sizes/SKUs).
// Safe to call — does not create or modify anything in CJ.
export const listProductVariants = async (productId) => {
  const body = await authorizedRequest(`/product/variant/query?pid=${encodeURIComponent(productId)}`, { method: 'GET' });
  return body.data || [];
};

// Read-only diagnostic GET used ONLY for the one-time Phase 2 variant
// discovery (see api/commerce.js resource=cj-diagnostic). Unlike cjRequest,
// this never throws on a non-2xx response — it returns the raw CJ status and
// body so a human can inspect exactly what CJ's real API returns instead of
// guessing at a response shape. Restricted by the caller to /product* paths
// only, so it can never reach an order/warehouse/packaging endpoint.
export const rawCjGet = async (path) => {
  const accessToken = await getAccessToken();
  const response = await fetch(`${CJ_BASE_URL}${path}`, {
    method: 'GET',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' }
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
};

// ---- Phase 3: read-only Global Warehouse List, Stock, and Freight Calculate
// (developers.cjdropshipping.com/en/api/api2/api/product.html /
// .../logistic.html). Each hits exactly one hardcoded, documented path —
// no caller-supplied path — so there's no way to redirect these at a write
// endpoint. freightCalculate is a POST per CJ's docs but only computes
// shipping cost/methods; it creates or modifies nothing.

export const getGlobalWarehouseList = async () => {
  const accessToken = await getAccessToken();
  const response = await fetch(`${CJ_BASE_URL}/product/globalWarehouseList`, {
    method: 'GET',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' }
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
};

export const getStockByVid = async (vid, countryCode) => {
  const accessToken = await getAccessToken();
  const qs = new URLSearchParams({ vid, ...(countryCode ? { countryCode } : {}) });
  const response = await fetch(`${CJ_BASE_URL}/product/stock/queryByVid?${qs}`, {
    method: 'GET',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' }
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
};

export const calculateFreight = async ({ startCountryCode, endCountryCode, vid, quantity }) => {
  const accessToken = await getAccessToken();
  // Confirmed via CJ's official example request body: vid/quantity nest
  // inside a `products` array, not top-level fields (an earlier summary of
  // the docs missed this nesting — corrected after a live "products must be
  // not null" response).
  const response = await fetch(`${CJ_BASE_URL}/logistic/freightCalculate`, {
    method: 'POST',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startCountryCode, endCountryCode, products: [{ vid, quantity }] })
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
};

// Read-only order/tracking lookup by the external CJ order id already stored
// on our side (fulfillmentExternalOrderId) — never exposes this externally.
export const getFulfillmentOrderStatus = async (cjOrderId) => {
  const body = await authorizedRequest(`/shopping/order/getOrderDetail?orderId=${encodeURIComponent(cjOrderId)}`, { method: 'GET' });
  return body.data || null;
};

// Intentionally not enabled. Wire this up only once: (1) payment is verified
// server-side, (2) the AJLIB order is marked paid, (3) idempotency is
// enforced by order id so duplicate Stripe webhook deliveries can never
// create two CJ orders. See lib/fulfillment-status.js for the customer-safe
// status mapping this should feed into.
export const createFulfillmentOrder = async () => {
  throw new Error('Live CJ order creation is disabled in this phase');
};

// CJ's own fulfillment status strings -> AJLIB's 5 customer-facing statuses.
// Left unpopulated until real CJ status values are confirmed (do not guess);
// see lib/fulfillment-status.js PROVIDER_STATUS_MAP for where this plugs in.
export const CJ_STATUS_MAP = Object.freeze({});
