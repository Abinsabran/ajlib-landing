// The CJ order-creation guard.
//
// LAUNCH ('manual' mode): createOrderV2 payType 1 creates the CJ order UNPAID
// (CJ's page payment — nothing deducted); the owner pays it in CJ. It can only
// happen with CJ_AUTO_CREATE_ENABLED exactly "true".
// OPTIONAL ('balance' mode): payType 2 creates, confirms AND pays from the CJ
// wallet in one irreversible request. It can only happen with
// CJ_LIVE_ORDER_CREATION_ENABLED exactly "true".
//
// In both modes every uncertain outcome is resolved by read-only
// reconciliation, never a retry, and a CJ order that already exists under the
// deterministic number is never created twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  createFulfillmentOrder, isLiveOrderCreationEnabled, isAutoCreateEnabled, LiveOrderCreationDisabledError,
  CjOrderRequestTimeoutError, CJ_LIVE_ORDER_FLAG, CJ_AUTO_CREATE_FLAG, creationFlagFor
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
  shipping_street: '1 Test St', shipping_city: 'دبي', shipping_country_code: 'AE', shipping_country_name: 'الإمارات',
  shipping_region: 'دبي', shipping_address: '1 St', customer_name: 'T',
  customer_phone: '+971500000001', customer_email: 'b@e.com',
  product_amount: 26900, shipping_amount: 0, amount_total: 26900,
  stripe_session_id: 'cs_live_1',
  fulfillment_status: 'READY_FOR_CJ', fulfillment_external_order_id: null,
  ...overrides
});

// Stubs the whole world. `create` decides what createOrderV2 does. CJ's order
// list returns `existing` before any create attempt (the pre-create duplicate
// check) and `orders` afterwards (timeout reconciliation). Every request is
// recorded so a test can prove what did — or did not — go out.
const world = ({ create, orders = [], existing = [], balance = 500, listError = false } = {}) => {
  const calls = [];
  let createAttempted = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', body: options.body });
    if (u.includes('/rest/v1/orders') && options.method === 'PATCH') return { ok: true, status: 204, text: async () => '' };
    if (u.includes('getAccessToken')) return { ok: true, json: async () => ({ data: { accessToken: 't', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) };
    if (u.includes('/product/conn/connection')) return { ok: true, json: async () => ({ code: 200, result: true, data: { list: [{ cjVariantId: '1581871544320667650', cjPrice: '2.21' }] } }) };
    if (u.includes('/logistic/freightCalculate')) return { ok: true, json: async () => ({ code: 200, result: true, data: [{ logisticName: 'CJPacket Liquid Line', totalPostageFee: 23.15, logisticAging: '7-10' }] }) };
    if (u.includes('/shopping/pay/getBalance')) return { ok: true, json: async () => ({ code: 200, result: true, data: { amount: balance, freezeAmount: 0, noWithdrawalAmount: 0 } }) };
    if (u.includes('/shopping/order/list')) {
      if (listError && createAttempted) return { ok: true, json: async () => ({ code: 1600200, result: false, message: 'QPS' }) };
      return { ok: true, json: async () => ({ code: 200, result: true, data: { list: createAttempted ? orders : existing } }) };
    }
    if (u.includes('/shopping/order/createOrderV2')) {
      createAttempted = true;
      if (!create) throw new Error('createOrderV2 must not be reachable in this test');
      return create(options);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
};

const ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SECRET_KEY: 'k', CJ_API_KEY: 'cj' };
const createRequests = (calls) => calls.filter(c => /createOrderV2/.test(c.url));
const patches = (calls) => calls.filter(c => c.url.includes('/rest/v1/orders') && c.method === 'PATCH').map(c => JSON.parse(c.body));
const timeout = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };

// ---- THE SWITCHES FAIL CLOSED --------------------------------------------------

test('both creation switches are off by default and only the exact string "true" turns them on', async () => {
  assert.equal(CJ_LIVE_ORDER_FLAG, 'CJ_LIVE_ORDER_CREATION_ENABLED');
  assert.equal(CJ_AUTO_CREATE_FLAG, 'CJ_AUTO_CREATE_ENABLED');
  for (const value of [undefined, '', 'false', '0', '1', 'TRUE', 'True', 'yes', 'on', ' true']) {
    await withEnv({ [CJ_LIVE_ORDER_FLAG]: value, [CJ_AUTO_CREATE_FLAG]: value }, async () => {
      assert.equal(isLiveOrderCreationEnabled(), false, `wallet switch must stay off for ${JSON.stringify(value)}`);
      assert.equal(isAutoCreateEnabled(), false, `auto-create switch must stay off for ${JSON.stringify(value)}`);
    });
  }
  await withEnv({ [CJ_AUTO_CREATE_FLAG]: 'true' }, async () => assert.equal(isAutoCreateEnabled(), true));
});

test('each payType is governed by its own switch; unknown payTypes are never allowed', () => {
  assert.equal(creationFlagFor(1), CJ_AUTO_CREATE_FLAG);
  assert.equal(creationFlagFor(3), CJ_AUTO_CREATE_FLAG);
  assert.equal(creationFlagFor(2), CJ_LIVE_ORDER_FLAG);
  for (const bad of [undefined, null, 0, 4, '1', '2']) assert.equal(creationFlagFor(bad), null, String(bad));
});

test('with its switch off, createFulfillmentOrder refuses before ANY network activity', async () => {
  await withEnv({ ...ENV, [CJ_LIVE_ORDER_FLAG]: undefined, [CJ_AUTO_CREATE_FLAG]: undefined }, async () => {
    const { calls, restore } = world();
    try {
      for (const payType of [1, 2, 3, undefined, 9]) {
        await assert.rejects(() => createFulfillmentOrder({ orderNumber: 'AJLIB-X', payType }), LiveOrderCreationDisabledError);
      }
      assert.equal(calls.length, 0, 'not even a token request may go out');
    } finally { restore(); }
  });
  // The auto-create switch never unlocks wallet payment, and vice versa.
  await withEnv({ ...ENV, [CJ_AUTO_CREATE_FLAG]: 'true', [CJ_LIVE_ORDER_FLAG]: undefined }, async () => {
    const { calls, restore } = world();
    try {
      await assert.rejects(() => createFulfillmentOrder({ orderNumber: 'AJLIB-X', payType: 2 }), LiveOrderCreationDisabledError);
      assert.equal(calls.length, 0);
    } finally { restore(); }
  });
  await withEnv({ ...ENV, [CJ_LIVE_ORDER_FLAG]: 'true', [CJ_AUTO_CREATE_FLAG]: undefined }, async () => {
    const { calls, restore } = world();
    try {
      await assert.rejects(() => createFulfillmentOrder({ orderNumber: 'AJLIB-X', payType: 1 }), LiveOrderCreationDisabledError);
      assert.equal(calls.length, 0);
    } finally { restore(); }
  });
});

test('with the switch off, a READY order sends nothing — and reads nothing either — in either mode', async () => {
  for (const flag of [undefined, 'false']) {
    await withEnv({ ...ENV, [CJ_LIVE_ORDER_FLAG]: flag, [CJ_AUTO_CREATE_FLAG]: flag }, async () => {
      for (const paymentMode of ['manual', 'balance']) {
        const { calls, restore } = world();
        try {
          const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14, paymentMode });
          assert.equal(result.outcome, SUBMIT_OUTCOME.LIVE_ORDER_CREATION_DISABLED);
          assert.equal(result.submitted, false);
          assert.equal(calls.length, 0, 'the switch is checked before anything else');
        } finally { restore(); }
      }
    });
  }
});

test('the switch is enforced at the call itself, so no other code path can bypass it', async () => {
  const source = (await readFile(new URL('../api/_lib/cj-client.js', import.meta.url), 'utf8')).replace(/\/\/[^\n]*/g, '');
  const fn = source.slice(source.indexOf('export const createFulfillmentOrder'));
  const guardAt = fn.indexOf('isCreationAllowedFor(payload?.payType)');
  const fetchAt = fn.indexOf('fetch(');
  assert.ok(guardAt > 0 && guardAt < fetchAt, 'the switch check must precede the request inside createFulfillmentOrder');
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

test('automatic creation goes only through fulfillment-auto, which checks the auto-create switch first', async () => {
  const strip = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\/\/[^\n]*/g, '');
  const webhook = await strip('../api/stripe-webhook.js');
  assert.match(webhook, /import \{ autoCreateAfterPayment[^}]*\} from '\.\/_lib\/fulfillment-auto\.js'/);
  for (const file of ['../api/stripe-webhook.js', '../api/commerce.js', '../api/_lib/fulfillment-runner.js']) {
    assert.ok(!/submitReadyOrder|fulfillment-submitter/.test(await strip(file)), `${file} must not call the submitter directly`);
  }
  const auto = await strip('../api/_lib/fulfillment-auto.js');
  const fn = auto.slice(auto.indexOf('export const autoCreateAfterPayment'));
  assert.ok(fn.indexOf('isAutoCreateEnabled()') > 0 && fn.indexOf('isAutoCreateEnabled()') < fn.indexOf('createAndAlert('), 'switch before any work');
});

// ---- MANUAL MODE (launch): created UNPAID, owner pays in CJ --------------------------

const AUTO = { ...ENV, [CJ_AUTO_CREATE_FLAG]: 'true', [CJ_LIVE_ORDER_FLAG]: undefined };
const createdUnpaid = (capture) => (o) => {
  if (capture) capture.body = JSON.parse(o.body);
  return { ok: true, status: 200, json: async () => ({ code: 200, result: true, data: { orderId: 'CJ-ORDER-1', orderNumber: 'AJLIB-AJ-LIVE-1', cjPayUrl: 'https://cjdropshipping.com/pay/CJ-ORDER-1', orderStatus: 'UNPAID' } }) };
};

test('manual mode: createOrderV2 payType 1, never the wallet; WAITING_FOR_CJ_PAYMENT, pay link and CJ id persisted', async () => {
  await withEnv(AUTO, async () => {
    const sent = {};
    const { calls, restore } = world({ create: createdUnpaid(sent), balance: 0 });
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14, paymentMode: 'manual' });
      assert.equal(result.outcome, SUBMIT_OUTCOME.CREATED_AWAITING_PAYMENT);
      assert.equal(result.paid, false);
      assert.equal(sent.body.payType, 1, 'page payment: nothing is deducted');
      assert.equal(sent.body.orderNumber, 'AJLIB-AJ-LIVE-1');
      assert.equal(calls.filter(c => /getBalance|payBalance|confirmOrder|addCart/.test(c.url)).length, 0, 'no wallet read, no payment, no confirmation calls');
      assert.equal(createRequests(calls).length, 1);
      const saved = patches(calls).at(-1);
      assert.equal(saved.fulfillment_external_order_id, 'CJ-ORDER-1');
      assert.equal(saved.fulfillment_status, 'WAITING_FOR_CJ_PAYMENT');
      assert.equal(saved.fulfillment_payment_url, 'https://cjdropshipping.com/pay/CJ-ORDER-1');
      assert.equal(saved.status, 'processing', 'the customer now sees "Preparing your order"');
      assert.equal(saved.fulfillment_cj_paid_at, undefined);
    } finally { restore(); }
  });
});

test('manual mode: an empty wallet does not block creation', async () => {
  await withEnv(AUTO, async () => {
    const { calls, restore } = world({ create: createdUnpaid(), balance: 0 });
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14, paymentMode: 'manual' });
      assert.equal(result.submitted, true);
      assert.equal(calls.filter(c => c.url.includes('getBalance')).length, 0);
    } finally { restore(); }
  });
});

test('a CJ order already existing under AJLIB-<number> is never created again; the order goes to review with its id', async () => {
  await withEnv(AUTO, async () => {
    const { calls, restore } = world({ create: createdUnpaid(), existing: [{ orderNum: 'AJLIB-AJ-LIVE-1', orderId: 'CJ-PRIOR', orderStatus: 'UNPAID' }] });
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14, paymentMode: 'manual' });
      assert.equal(result.reason, 'CJ_ORDER_ALREADY_EXISTS');
      assert.equal(createRequests(calls).length, 0);
      const saved = patches(calls).at(-1);
      assert.equal(saved.fulfillment_status, 'REVIEW_REQUIRED');
      assert.equal(saved.fulfillment_external_order_id, 'CJ-PRIOR', 'recorded so nothing can create another');
    } finally { restore(); }
  });
});

test('if CJ cannot be checked for an existing order, nothing is created', async () => {
  await withEnv(AUTO, async () => {
    const calls = [];
    const original = globalThis.fetch;
    const inner = world({ create: createdUnpaid() });
    const wrapped = globalThis.fetch;
    globalThis.fetch = async (url, o) => {
      calls.push(String(url));
      if (String(url).includes('/shopping/order/list')) return { ok: true, json: async () => ({ code: 1600200, result: false, message: 'QPS' }) };
      return wrapped(url, o);
    };
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14, paymentMode: 'manual' });
      assert.equal(result.reason, 'CJ_ORDER_LOOKUP_FAILED');
      assert.equal(calls.filter(u => u.includes('createOrderV2')).length, 0);
    } finally { inner.restore(); globalThis.fetch = original; }
  });
});

test('a margin below GREEN is never created automatically', async () => {
  await withEnv(AUTO, async () => {
    // 10 pieces for 120 AED: costs outweigh revenue.
    const { calls, restore } = world({ create: createdUnpaid() });
    try {
      const result = await submitReadyOrder(readyOrder({ product_amount: 12000 }), { maxDeliveryDays: 14, paymentMode: 'manual' });
      assert.equal(result.outcome, SUBMIT_OUTCOME.BLOCKED_ON_RECHECK);
      assert.equal(result.reason, 'MARGIN_BELOW_25_PERCENT');
      assert.equal(createRequests(calls).length, 0);
    } finally { restore(); }
  });
});

test('manual mode: a timeout that CJ shows as an existing UNPAID order is recorded as created — sent once, no retry', async () => {
  await withEnv(AUTO, async () => {
    const { calls, restore } = world({ create: timeout, orders: [{ orderNum: 'AJLIB-AJ-LIVE-1', orderId: 'CJ-UNPAID-1', orderStatus: 'UNPAID' }] });
    try {
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14, timeoutMs: 10, paymentMode: 'manual' });
      assert.equal(result.outcome, SUBMIT_OUTCOME.RECONCILED_AWAITING_PAYMENT);
      assert.equal(result.cjOrderId, 'CJ-UNPAID-1');
      assert.equal(createRequests(calls).length, 1);
      const saved = patches(calls).at(-1);
      assert.equal(saved.fulfillment_external_order_id, 'CJ-UNPAID-1');
      assert.equal(saved.fulfillment_status, 'WAITING_FOR_CJ_PAYMENT');
    } finally { restore(); }
  });
});

// ---- BALANCE MODE (optional, wallet-paid) -------------------------------------------

const LIVE = { ...ENV, [CJ_LIVE_ORDER_FLAG]: 'true', [CJ_AUTO_CREATE_FLAG]: undefined };
const BAL = { maxDeliveryDays: 14, paymentMode: 'balance' };

test('balance mode: re-check, balance, createOrderV2 with payType=2, then persist the CJ reference', async () => {
  await withEnv(LIVE, async () => {
    let sent;
    const { calls, restore } = world({ create: (o) => { sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ code: 200, result: true, data: { orderId: 'CJ-ORDER-1', orderStatus: 'UNSHIPPED' } }) }; } });
    try {
      const result = await submitReadyOrder(readyOrder(), BAL);
      assert.equal(result.outcome, SUBMIT_OUTCOME.SUBMITTED);
      assert.equal(result.cjOrderId, 'CJ-ORDER-1');
      assert.equal(sent.payType, 2);
      assert.equal(sent.orderNumber, 'AJLIB-AJ-LIVE-1', 'deterministic idempotency key');
      const balanceAt = calls.findIndex(c => c.url.includes('getBalance'));
      const createAt = calls.findIndex(c => c.url.includes('createOrderV2'));
      assert.ok(balanceAt >= 0 && balanceAt < createAt, 'balance must be checked before createOrderV2');
      assert.equal(patches(calls).at(-1).fulfillment_external_order_id, 'CJ-ORDER-1');
    } finally { restore(); }
  });
});

test('balance mode: an insufficient balance at re-check stops before createOrderV2', async () => {
  await withEnv(LIVE, async () => {
    const { calls, restore } = world({ balance: 0 });
    try {
      const result = await submitReadyOrder(readyOrder(), BAL);
      assert.equal(result.outcome, SUBMIT_OUTCOME.BLOCKED_ON_RECHECK);
      assert.equal(result.reason, 'INSUFFICIENT_CJ_BALANCE');
      assert.deepEqual(createRequests(calls), []);
    } finally { restore(); }
  });
});

// ---- BOTH MODES: idempotency and reconciliation ----------------------------------------

for (const [label, env, opts] of [['manual', AUTO, { maxDeliveryDays: 14, paymentMode: 'manual' }], ['balance', LIVE, BAL]]) {
  test(`${label} mode: an order already carrying a CJ reference is never sent again`, async () => {
    await withEnv(env, async () => {
      const { calls, restore } = world();
      try {
        const result = await submitReadyOrder(readyOrder({ fulfillment_external_order_id: 'CJ-EXISTING' }), opts);
        assert.equal(result.outcome, SUBMIT_OUTCOME.ALREADY_SUBMITTED);
        assert.deepEqual(createRequests(calls), []);
      } finally { restore(); }
    });
  });

  test(`${label} mode: an order not in READY_FOR_CJ (e.g. under review) is never sent`, async () => {
    await withEnv(env, async () => {
      const { calls, restore } = world();
      try {
        const result = await submitReadyOrder(readyOrder({ fulfillment_status: 'REVIEW_REQUIRED' }), opts);
        assert.equal(result.outcome, SUBMIT_OUTCOME.NOT_READY);
        assert.deepEqual(createRequests(calls), []);
      } finally { restore(); }
    });
  });

  test(`${label} mode: a timeout CJ shows as PAID is recorded — sent exactly once`, async () => {
    await withEnv(env, async () => {
      const { calls, restore } = world({ create: timeout, orders: [{ orderNum: 'AJLIB-AJ-LIVE-1', orderId: 'CJ-ORDER-TIMEOUT', orderStatus: 'PENDING', paymentDate: '2026-09-18 10:00:00' }] });
      try {
        const result = await submitReadyOrder(readyOrder(), { ...opts, timeoutMs: 10 });
        assert.equal(result.outcome, SUBMIT_OUTCOME.RECONCILED_ALREADY_PAID);
        assert.equal(result.cjOrderId, 'CJ-ORDER-TIMEOUT');
        assert.equal(createRequests(calls).length, 1, 'no retry after a timeout');
        assert.equal(patches(calls).at(-1).fulfillment_external_order_id, 'CJ-ORDER-TIMEOUT');
      } finally { restore(); }
    });
  });

  test(`${label} mode: a timeout where CJ has no such order returns to READY_FOR_CJ and is NOT retried automatically`, async () => {
    await withEnv(env, async () => {
      const { calls, restore } = world({ create: timeout, orders: [] });
      try {
        const result = await submitReadyOrder(readyOrder(), { ...opts, timeoutMs: 10 });
        assert.equal(result.outcome, SUBMIT_OUTCOME.NOT_CREATED_SAFE_TO_RETRY);
        assert.equal(createRequests(calls).length, 1);
        assert.equal(patches(calls).at(-1).fulfillment_status, 'READY_FOR_CJ');
      } finally { restore(); }
    });
  });

  test(`${label} mode: a timeout where CJ cannot be read goes to review — an unknown outcome never authorises a retry`, async () => {
    await withEnv(env, async () => {
      const { calls, restore } = world({ create: timeout, listError: true });
      try {
        const result = await submitReadyOrder(readyOrder(), { ...opts, timeoutMs: 10 });
        assert.equal(result.outcome, SUBMIT_OUTCOME.REVIEW_REQUIRED);
        assert.equal(result.reason, 'CJ_ORDER_OUTCOME_UNKNOWN');
        assert.equal(createRequests(calls).length, 1);
      } finally { restore(); }
    });
  });

  test(`${label} mode: a "success" with no order id is not assumed to have worked`, async () => {
    await withEnv(env, async () => {
      const { restore } = world({ create: () => ({ ok: true, status: 200, json: async () => ({ code: 200, result: true, data: {} }) }), orders: [] });
      try {
        const result = await submitReadyOrder(readyOrder(), opts);
        assert.equal(result.outcome, SUBMIT_OUTCOME.NOT_CREATED_SAFE_TO_RETRY);
        assert.equal(result.trigger, 'CJ_SUCCESS_WITHOUT_ORDER_ID');
      } finally { restore(); }
    });
  });
}

test('balance mode: a CJ business error (e.g. "already paid") is reconciled, not treated as failure', async () => {
  await withEnv(LIVE, async () => {
    const { restore } = world({
      create: () => ({ ok: true, status: 200, json: async () => ({ code: 1600300, result: false, message: 'order already paid' }) }),
      orders: [{ orderNum: 'AJLIB-AJ-LIVE-1', orderId: 'CJ-ALREADY', orderStatus: 'UNSHIPPED', paymentDate: '2026-09-18 10:00:00' }]
    });
    try {
      const result = await submitReadyOrder(readyOrder(), BAL);
      assert.equal(result.outcome, SUBMIT_OUTCOME.RECONCILED_ALREADY_PAID);
    } finally { restore(); }
  });
});

test('the request timeout surfaces as its own error type for reconciliation', () => {
  const e = new CjOrderRequestTimeoutError(8000);
  assert.equal(e.code, 'CJ_ORDER_REQUEST_TIMEOUT');
  assert.match(e.message, /reconcile before any retry/);
});

test('the profit guard is re-checked at creation: NET_PROFIT_BELOW_30_AED holds the order for review, nothing is created', async () => {
  await withEnv(AUTO, async () => {
    const { calls, restore } = world({ create: createdUnpaid() });
    try {
      // A preparation whose margin clears 25% but whose net profit is under 30 AED.
      const prepared = { payload: { orderNumber: 'AJLIB-AJ-LIVE-1', payType: 1 }, margin: { approved: false, band: 'GREEN', reason: 'NET_PROFIT_BELOW_30_AED' } };
      const result = await submitReadyOrder(readyOrder(), { maxDeliveryDays: 14, paymentMode: 'manual', prepared });
      assert.equal(result.outcome, SUBMIT_OUTCOME.BLOCKED_ON_RECHECK);
      assert.equal(result.reason, 'NET_PROFIT_BELOW_30_AED');
      assert.equal(createRequests(calls).length, 0);
      const saved = patches(calls).at(-1);
      assert.equal(saved.fulfillment_status, 'REVIEW_REQUIRED');
      assert.equal(saved.fulfillment_error, 'NET_PROFIT_BELOW_30_AED');
    } finally { restore(); }
  });
});
