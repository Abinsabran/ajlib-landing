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

// CJ enforces a hard QPS limit and rejects bursts with
// {"code":1600200,"message":"Too Many Requests, QPS limit is 1 time/1second"}
// — confirmed live, not guessed. The fulfillment pipeline makes several CJ
// calls back-to-back per order (cost lookup, freight, balance), so requests
// are serialized through one promise chain with a minimum gap. Without
// this, the second call of any pair silently comes back empty.
export const CJ_MIN_REQUEST_GAP_MS = 1100;
let cjRequestChain = Promise.resolve();
let lastCjRequestAt = 0;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Serializes every CJ call and spaces them out. Returns whatever `fn`
// returns; failures do not break the chain for subsequent callers.
export const throttleCj = (fn) => {
  const result = cjRequestChain.then(async () => {
    const wait = lastCjRequestAt + CJ_MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCjRequestAt = Date.now();
    return fn();
  });
  cjRequestChain = result.then(() => undefined, () => undefined);
  return result;
};

// CJ reports rate limiting in the BODY with HTTP 200, so a caller checking
// only response.ok sees a success with empty data. Callers must use this to
// tell "CJ refused/errored" apart from "genuinely nothing available".
export const CJ_RATE_LIMITED_CODE = 1600200;
export const isCjErrorBody = (body) => body?.result === false || (body?.code != null && Number(body.code) !== 200);

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

export const getShops = async () => {
  const accessToken = await getAccessToken();
  const response = await fetch(`${CJ_BASE_URL}/shop/getShops`, {
    method: 'GET',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' }
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
};

// READ-ONLY balance query. This is the ONLY balance endpoint this codebase
// calls — CJ's sibling payment-write endpoints are deliberately NOT
// implemented anywhere, so no code path can spend the CJ wallet directly.
// Balance is only ever spent as a side effect of an approved createOrderV2
// with payType=2.
//
// PATH CORRECTED per CJ support: the balance endpoint is under /shopping/pay/,
// NOT /shopping/balance/ as the public docs page shows. The documented
// /shopping/balance/getBalance returns {"code":1600101,"message":"Interface
// not found"} — that was a wrong path, not a disabled permission. CJ also
// confirmed no account enablement is required.
//
// Contract per CJ support: CJ-Access-Token header only, NO request body, NO
// query parameters. Sending any of those is a deviation from the confirmed
// contract, so this builds a bare GET deliberately.
export const getAccountBalance = async () => throttleCj(async () => {
  const accessToken = await getAccessToken();
  const response = await fetch(`${CJ_BASE_URL}/shopping/pay/getBalance`, {
    method: 'GET',
    headers: { 'CJ-Access-Token': accessToken }
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
});

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

// Accepts either a single {vid, quantity} (Phase 3 usage) or a real
// multi-line {products: [{vid, quantity}, ...]} for an actual order with
// several variants — CJ's documented schema supports multiple products per
// freight calculation and returns weight-combined results.
export const calculateFreight = async ({ startCountryCode, endCountryCode, vid, quantity, products }) => throttleCj(async () => {
  const accessToken = await getAccessToken();
  // Confirmed via CJ's official example request body: vid/quantity nest
  // inside a `products` array, not top-level fields (an earlier summary of
  // the docs missed this nesting — corrected after a live "products must be
  // not null" response).
  const items = products || [{ vid, quantity }];
  const response = await fetch(`${CJ_BASE_URL}/logistic/freightCalculate`, {
    method: 'POST',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startCountryCode, endCountryCode, products: items })
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
});

// ---- API-store product connection WRITES (approved, one-time execution) --
// Each hardcoded to exactly one documented endpoint. These create/modify
// AJLIB's own store-product/variant/connection records in CJ — never a CJ
// order, never packaging/sticker config, never Production data.

export const saveStoreProduct = async (payload) => {
  const accessToken = await getAccessToken();
  const response = await fetch(`${CJ_BASE_URL}/store/product/saveProduct`, {
    method: 'POST',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
};

export const saveStoreVariantBatch = async (payload) => {
  const accessToken = await getAccessToken();
  const response = await fetch(`${CJ_BASE_URL}/store/product/saveVariantBatch`, {
    method: 'POST',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
};

export const createProductConnection = async (payload) => {
  const accessToken = await getAccessToken();
  const response = await fetch(`${CJ_BASE_URL}/product/conn/connection`, {
    method: 'POST',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
};

// Read-only — "Query Product Connection List", documented as a distinct GET
// at the same URL as the POST/DELETE forms above.
export const queryProductConnections = async ({ shopId, platformProductId, page = 1, pageSize = 100 } = {}) => throttleCj(async () => {
  const accessToken = await getAccessToken();
  const qs = new URLSearchParams({
    ...(shopId ? { shopId } : {}),
    ...(platformProductId ? { platformProductId } : {}),
    page: String(page),
    pageSize: String(pageSize)
  });
  const response = await fetch(`${CJ_BASE_URL}/product/conn/connection?${qs}`, {
    method: 'GET',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' }
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
});

// READ-ONLY order list. Confirmed via CJ's docs: GET /shopping/order/list,
// paged with pageNum/pageSize. It does NOT accept our own orderNumber as a
// filter, so a lookup by our deterministic AJLIB number has to page through
// and match CJ's `orderNum` field. Used only for post-timeout
// reconciliation — it creates and modifies nothing.
export const listOrders = async ({ pageNum = 1, pageSize = 20 } = {}) => throttleCj(async () => {
  const accessToken = await getAccessToken();
  const qs = new URLSearchParams({ pageNum: String(pageNum), pageSize: String(pageSize) });
  const response = await fetch(`${CJ_BASE_URL}/shopping/order/list?${qs}`, {
    method: 'GET',
    headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' }
  });
  const body = await response.json().catch((e) => ({ parseError: e.message }));
  return { status: response.status, body };
});

// Finds a CJ order by the orderNumber WE submitted (AJLIB-<order_number>).
// Pages until found or until maxPages is exhausted. Returns the raw CJ row
// or null. Read-only. Distinguishes "definitively not found" from "could
// not determine" by throwing on an API error, so a caller can never read a
// transport failure as "the order does not exist".
export const findOrderByOrderNumber = async (orderNumber, { maxPages = 5, pageSize = 20 } = {}) => {
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const { body } = await listOrders({ pageNum, pageSize });
    if (isCjErrorBody(body)) {
      throw new Error(`CJ order list failed (code ${body?.code}: ${body?.message})`);
    }
    const rows = body?.data?.list ?? body?.data ?? [];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const match = rows.find(row => row.orderNum === orderNumber);
    if (match) return match;
    if (rows.length < pageSize) return null; // last page reached
  }
  return null;
};

// Read-only order/tracking lookup by the external CJ order id already stored
// on our side (fulfillmentExternalOrderId) — never exposes this externally.
// GET /shopping/order/getOrderDetail. Real documented status enum (CJ's
// official docs, developers.cjdropshipping.com/en/api/api2/api/shopping.html):
// CREATED, IN_CART, UNPAID, PENDING, PROCESSING, UNSHIPPED (parent of
// PENDING/PROCESSING), SHIPPED, DELIVERED, CANCELLED. Tracking fields:
// trackNumber, trackingProvider, trackingUrl (null when no tracking exists
// yet). See api/_lib/fulfillment-status.js PROVIDER_STATUS_MAP for the mapping
// of these into AJLIB's 5 customer-facing statuses.
export const getFulfillmentOrderStatus = async (cjOrderId) => {
  const body = await authorizedRequest(`/shopping/order/getOrderDetail?orderId=${encodeURIComponent(cjOrderId)}`, { method: 'GET' });
  return body.data || null;
};

// Phase 4: confirmed real endpoint via CJ's official docs —
// POST /api2.0/v1/shopping/order/createOrderV2. `orderNumber` is documented
// as CJ's own idempotency key (duplicate submissions with the same
// orderNumber do not create a second order).
//
// CJ support confirmed the payType=2 contract: this single request performs
// order creation + confirmation + CJ Balance deduction, the deduction is
// IMMEDIATE, and it CANNOT be rolled back.
//
// Therefore the caller MUST NOT wrap it in a blind retry. A timeout is not a
// failure — the money may already be gone. Every timeout, and every
// repeated-payment business error, must be resolved through
// api/_lib/cj-fulfillment.js reconcileAfterTimeout(), which is read-only and only
// reports safeToRetry=true when CJ has no order under our deterministic
// orderNumber at all. api/_lib/fulfillment-submitter.js is the one caller and
// does exactly that.
//
// THE ONLY MONEY-SPENDING CALL IN THIS CODEBASE. With payType=2 it creates,
// confirms and pays a CJ order from the CJ Balance in one irreversible step.
//
// It cannot run unless CJ_LIVE_ORDER_CREATION_ENABLED is exactly the string
// "true". Anything else — unset, "false", "1", "TRUE" — refuses before any
// network activity, so a missing or mistyped variable fails closed. This is
// checked here, at the call itself, not only by callers, so no future code
// path can reach createOrderV2 without it.
export const CJ_LIVE_ORDER_FLAG = 'CJ_LIVE_ORDER_CREATION_ENABLED';
export const isLiveOrderCreationEnabled = () => process.env[CJ_LIVE_ORDER_FLAG] === 'true';

export class LiveOrderCreationDisabledError extends Error {
  constructor() {
    super(`Live CJ order creation is disabled (${CJ_LIVE_ORDER_FLAG} is not "true")`);
    this.code = 'LIVE_ORDER_CREATION_DISABLED';
  }
}

// A timed-out payType=2 request is NOT a failed request — the balance may
// already have been deducted. Callers must treat this as "unknown" and
// reconcile read-only (api/_lib/cj-fulfillment.js reconcileAfterTimeout), never
// retry. The timeout exists so a hung request resolves into that path
// instead of outliving the serverless function.
export class CjOrderRequestTimeoutError extends Error {
  constructor(ms) {
    super(`CJ createOrderV2 did not respond within ${ms}ms — outcome unknown, reconcile before any retry`);
    this.code = 'CJ_ORDER_REQUEST_TIMEOUT';
  }
}

export const CJ_CREATE_ORDER_TIMEOUT_MS = 8000;

export const createFulfillmentOrder = async (payload, { timeoutMs = CJ_CREATE_ORDER_TIMEOUT_MS } = {}) => {
  if (!isLiveOrderCreationEnabled()) throw new LiveOrderCreationDisabledError();

  return throttleCj(async () => {
    const accessToken = await getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${CJ_BASE_URL}/shopping/order/createOrderV2`, {
        method: 'POST',
        headers: { 'CJ-Access-Token': accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const body = await response.json().catch((e) => ({ parseError: e.message }));
      return { status: response.status, body };
    } catch (error) {
      if (error?.name === 'AbortError') throw new CjOrderRequestTimeoutError(timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
};
