// The CJ live-order guard. createOrderV2 with payType=2 creates, confirms and
// pays a CJ order from the CJ Balance in one irreversible request, so these
// tests prove it cannot be reached unless CJ_LIVE_ORDER_CREATION_ENABLED is
// exactly "true" — and that when it IS reached, every uncertain outcome is
// resolved by read-only reconciliation rather than a retry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  createFulfillmentOrder, isLiveOrderCreationEnabled, LiveOrderCreationDisabledError,
  CjOrderRequestTimeoutError, CJ_LIVE_ORDER_FLAG
} from '../api/_lib/cj-client.js';
import { submitReadyOrder, SUBMIT_OUTCOME } from '../api/_lib/fulfillment-submitter.js';

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key]; else process.env[key] = vars[key];
  }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
};

const readyOrder = (overrides = {}) => ({
  id: 'order-live-1', order_number: 'AJ-LIVE-1', status: 'paid',
  items: [{ variant: 'أسود-L', quantity: 10 }],
  shipping_city: 'دبي', shipping_country_code: 'AE', shipping_country_name: 'الإمارات',
  shipping_region: 'دبي', shipping_address: '1 St', customer_name: 'T',
  customer_phone: '+971500000001', customer_email: 'b@e.com',
  product_amount: 26900, shipping_amount: 0, amount_total: 26900,
  stripe_session_id: 'cs_live_1',
  fulfillment_status: 'READY_FOR_CJ', fulfillment_external_order_id: null,
  ...overrides
});

// Stubs the whole world. `create` decides what createOrderV2 does; `orders`
// is what CJ's order list returns for reconciliation. Every request is
// recorded so a test can prove what did — or did not — go out.
const world = ({ create, orders = [], balance = 500 } = {}) => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', body: options.body });
    if (u.includes('/rest/v1/orders') && options.method === 'PATCH') return { ok: true, status: 204, text: async () => '' };
    if (u.includes('getAccessToken')) return { ok: true, json: async () => ({ data: { accessToken: 't', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) };
    if (u.includes('/product/conn/connection')) return { ok: true, json: async () => ({ code: 200, result: true, data: { list: [{ cjVariantId: '1581871544320667650', cjPrice: '2.21' }] } }) };
    if (u.includes('/logistic/freightCalculate')) return { ok: true, json: async () => ({ code: 200, result: true, data: [{ logisticName: 'CJPacket Ordinary', totalPostageFee: 23.15, logisticAging: '7-10' }] }) };
    if (u.includes('/shopping/pay/getBalance')) return { ok: true, json: async () => ({ code: 200, result: true, data: { amount: balance, freezeAmount: 0, noWithdrawalAmount: 0 } }) };
    if (u.includes('/shopping/order/list')) return { ok: true, json: async () => ({ code: 200, result: true, data: { list: orders } }) };
    if (u.includes('/shopping/order/createOrderV2')) {
      if (!create) throw new Error('createOrderV2 must not be reachable in this test');
      return create(options);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
};

const ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SECRET_KEY: 'k', CJ_API_KEY: 'cj' };
const moneyRequests = (calls) => calls.filter(c => /createOrderV2|payBalance/.test(c.url));
const patches = (calls) => calls.filter(c => c.url.includes('/rest/v1/orders') && c.method === 'PATCH').map(c => JSON.parse(c.body));

// ---- THE FLAG FAILS CLOSED ----------------------------------------------------

test('the flag is off by default and only the exact string "true" turns it on', async () => {
  assert.equal(CJ_LIVE_ORDER_FLAG, 'CJ_LIVE_ORDER_CREATION_ENABLED');
  for (const value of [undefined, '', 'false', '0', '1', 'TRUE', 'True', 'yes', 'on', ' true']) {
    await withEnv({ [CJ_LIVE_ORDER_FLAG]: value }, async () => {
      assert.equal(isLiveOrderCreationEnabled(), false, `must stay disabled for ${JSON.stringify(value)}`);
    });
  }
  await withEnv({ [CJ_LIVE_ORDER_FLAG]: 'true' }, async () => assert.equal(isLiveOrderCreationEnabled(), true));
});

test('with the flag unset, createFulfillmentOrder refuses before ANY network activity', async () => {
  await withEnv({ ...ENV, [CJ_LIVE_ORDER_FLAG]: undefined }, async () => {
    const { calls, restore } = world();
    try {
      await assert.rejects(() => createFulfillmentOrder({ orderNumber: 'AJLIB-X', payType: 2 }), LiveOrderCreationDisabledError);
      assert.equal(calls.length, 0, 'not even a token request may go out');
    } finally { restore(); }
  });
});

test('with the flag off, submitting a READY order sends no createOrderV2, no payType=2, no balance spend — and no reads either', async () => {
  for (const flag of [undefined, 'false']) {
    await withEnv({ ...ENV, [CJ_LIVE_ORDER_FLAG]: flag }, async () => {
      const { calls, restore } = world();
      try {
        const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14 });
        assert.equal(result.outcome, SUBMIT_OUTCOME.LIVE_ORDER_CREATION_DISABLED);
        assert.equal(result.submitted, false);
        assert.deepEqual(moneyRequests(calls), []);
        assert.equal(calls.length, 0, 'the flag is checked before anything else');
      } finally { restore(); }
    });
  }
});

test('the flag is enforced at the call itself, so no other code path can bypass it', async () => {
  const source = (await readFile(new URL('../api/_lib/cj-client.js', import.meta.url), 'utf8')).replace(/\/\/[^\n]*/g, '');
  const fn = source.slice(source.indexOf('export const createFulfillmentOrder'));
  const guardAt = fn.indexOf('isLiveOrderCreationEnabled()');
  const fetchAt = fn.indexOf('fetch(');
  assert.ok(guardAt > 0 && guardAt < fetchAt, 'the flag check must precede the request inside createFulfillmentOrder');
});

test('createFulfillmentOrder has exactly one caller: the submitter', async () => {
  const roots = ['../api/', '../api/_lib/'];
  const callers = [];
  for (const root of roots) {
    const dir = new URL(root, import.meta.url);
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.js')) continue;
      const code = (await readFile(new URL(file, dir), 'utf8')).replace(/\/\/[^\n]*/g, '');
      if (/createFulfillmentOrder\(/.test(code) && !/export const createFulfillmentOrder/.test(code)) callers.push(`${root}${file}`);
    }
  }
  assert.deepEqual(callers, ['../api/_lib/fulfillment-submitter.js']);
});

test('nothing triggers submission automatically — not the payment webhook, not an endpoint', async () => {
  for (const file of ['../api/stripe-webhook.js', '../api/commerce.js', '../api/_lib/fulfillment-runner.js']) {
    const code = (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\/\/[^\n]*/g, '');
    assert.ok(!/submitReadyOrder|fulfillment-submitter/.test(code), `${file} must not trigger live submission`);
  }
});

// ---- WITH THE FLAG ON (mocked CJ): the full path ------------------------------

const LIVE = { ...ENV, [CJ_LIVE_ORDER_FLAG]: 'true' };

test('the full path: re-check, balance, createOrderV2 with payType=2, then persist the CJ reference', async () => {
  await withEnv(LIVE, async () => {
    let sent;
    const { calls, restore } = world({ create: (o) => { sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ code: 200, result: true, data: { orderId: 'CJ-ORDER-1', orderStatus: 'UNSHIPPED' } }) }; } });
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14 });
      assert.equal(result.outcome, SUBMIT_OUTCOME.SUBMITTED);
      assert.equal(result.cjOrderId, 'CJ-ORDER-1');
      assert.equal(sent.payType, 2);
      assert.equal(sent.orderNumber, 'AJLIB-AJ-LIVE-1', 'deterministic idempotency key');
      // The balance was checked before the order went out.
      const balanceAt = calls.findIndex(c => c.url.includes('getBalance'));
      const createAt = calls.findIndex(c => c.url.includes('createOrderV2'));
      assert.ok(balanceAt >= 0 && balanceAt < createAt, 'balance must be checked before createOrderV2');
      assert.equal(patches(calls).at(-1).fulfillment_external_order_id, 'CJ-ORDER-1');
    } finally { restore(); }
  });
});

test('an insufficient balance at re-check stops before createOrderV2', async () => {
  await withEnv(LIVE, async () => {
    const { calls, restore } = world({ balance: 0 });
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14 });
      assert.equal(result.outcome, SUBMIT_OUTCOME.BLOCKED_ON_RECHECK);
      assert.equal(result.reason, 'INSUFFICIENT_CJ_BALANCE');
      assert.deepEqual(moneyRequests(calls), []);
    } finally { restore(); }
  });
});

test('an order already carrying a CJ reference is never sent again', async () => {
  await withEnv(LIVE, async () => {
    const { calls, restore } = world();
    try {
      const result = await submitReadyOrder(readyOrder({ fulfillment_external_order_id: 'CJ-EXISTING' }), { maxDeliveryDays: 14 });
      assert.equal(result.outcome, SUBMIT_OUTCOME.ALREADY_SUBMITTED);
      assert.deepEqual(moneyRequests(calls), []);
    } finally { restore(); }
  });
});

test('an order not in READY_FOR_CJ (e.g. under review) is never sent', async () => {
  await withEnv(LIVE, async () => {
    const { calls, restore } = world();
    try {
      const result = await submitReadyOrder(readyOrder({ fulfillment_status: 'REVIEW_REQUIRED' }), { maxDeliveryDays: 14 });
      assert.equal(result.outcome, SUBMIT_OUTCOME.NOT_READY);
      assert.deepEqual(moneyRequests(calls), []);
    } finally { restore(); }
  });
});

// ---- TIMEOUT RECONCILIATION IS WIRED ------------------------------------------

test('a timeout is reconciled read-only: CJ shows it paid, so the reference is persisted — and it is sent exactly once', async () => {
  await withEnv(LIVE, async () => {
    const { calls, restore } = world({
      create: () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
      orders: [{ orderNum: 'AJLIB-AJ-LIVE-1', orderId: 'CJ-ORDER-TIMEOUT', orderStatus: 'PENDING', paymentDate: '2026-09-18 10:00:00' }]
    });
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14, timeoutMs: 10 });
      assert.equal(result.outcome, SUBMIT_OUTCOME.RECONCILED_ALREADY_PAID);
      assert.equal(result.cjOrderId, 'CJ-ORDER-TIMEOUT');
      assert.equal(calls.filter(c => c.url.includes('createOrderV2')).length, 1, 'no retry after a timeout');
      assert.ok(calls.some(c => c.url.includes('/shopping/order/list')), 'reconciliation must consult CJ');
      assert.equal(patches(calls).at(-1).fulfillment_external_order_id, 'CJ-ORDER-TIMEOUT');
    } finally { restore(); }
  });
});

test('a timeout where CJ has no such order is left READY and NOT retried automatically', async () => {
  await withEnv(LIVE, async () => {
    const { calls, restore } = world({ create: () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, orders: [] });
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14, timeoutMs: 10 });
      assert.equal(result.outcome, SUBMIT_OUTCOME.NOT_CREATED_SAFE_TO_RETRY);
      assert.equal(calls.filter(c => c.url.includes('createOrderV2')).length, 1);
      assert.ok(!('fulfillment_status' in patches(calls).at(-1)), 'stays READY_FOR_CJ');
    } finally { restore(); }
  });
});

test('a timeout where CJ cannot be read goes to review — an unknown outcome never authorises a retry', async () => {
  await withEnv(LIVE, async () => {
    const calls = [];
    const original = globalThis.fetch;
    const inner = world({ create: () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
    const wrapped = globalThis.fetch;
    globalThis.fetch = async (url, o) => {
      calls.push(String(url));
      if (String(url).includes('/shopping/order/list')) return { ok: true, json: async () => ({ code: 1600200, result: false, message: 'QPS' }) };
      return wrapped(url, o);
    };
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14, timeoutMs: 10 });
      assert.equal(result.outcome, SUBMIT_OUTCOME.REVIEW_REQUIRED);
      assert.equal(result.reason, 'CJ_ORDER_OUTCOME_UNKNOWN');
      assert.equal(calls.filter(u => u.includes('createOrderV2')).length, 1);
    } finally { inner.restore(); globalThis.fetch = original; }
  });
});

test('a CJ business error (e.g. "already paid") is reconciled, not treated as failure', async () => {
  await withEnv(LIVE, async () => {
    const { restore } = world({
      create: () => ({ ok: true, status: 200, json: async () => ({ code: 1600300, result: false, message: 'order already paid' }) }),
      orders: [{ orderNum: 'AJLIB-AJ-LIVE-1', orderId: 'CJ-ALREADY', orderStatus: 'UNSHIPPED', paymentDate: '2026-09-18 10:00:00' }]
    });
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14 });
      assert.equal(result.outcome, SUBMIT_OUTCOME.RECONCILED_ALREADY_PAID);
    } finally { restore(); }
  });
});

test('a "success" with no order id is not assumed to have worked', async () => {
  await withEnv(LIVE, async () => {
    const { restore } = world({ create: () => ({ ok: true, status: 200, json: async () => ({ code: 200, result: true, data: {} }) }), orders: [] });
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14 });
      assert.equal(result.outcome, SUBMIT_OUTCOME.NOT_CREATED_SAFE_TO_RETRY);
      assert.equal(result.trigger, 'CJ_SUCCESS_WITHOUT_ORDER_ID');
    } finally { restore(); }
  });
});

test('the request timeout surfaces as its own error type for reconciliation', () => {
  const e = new CjOrderRequestTimeoutError(8000);
  assert.equal(e.code, 'CJ_ORDER_REQUEST_TIMEOUT');
  assert.match(e.message, /reconcile before any retry/);
});
