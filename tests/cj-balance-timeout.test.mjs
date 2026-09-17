// CJ Balance (corrected endpoint) and payType=2 timeout reconciliation.
//
// Context that makes these tests load-bearing, confirmed by CJ support:
// createOrderV2 with payType=2 performs creation + confirmation + balance
// deduction in ONE request, the deduction is immediate, and it CANNOT be
// rolled back. A timed-out request is therefore NOT a failed request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseCjBalance, parseCjBalanceUSD, evaluateBalanceSufficiency,
  buildCjOrderPayload, cjOrderNumberFor,
  isCjOrderPaid, reconcileAfterTimeout, resolveRepeatedPaymentError,
  CJ_PAY_TYPE_BALANCE
} from '../lib/cj-fulfillment.js';
import { getAccountBalance } from '../lib/cj-client.js';

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
};

const authResponse = { ok: true, json: async () => ({ data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 3600_000).toISOString() } }) };

// ---- CORRECTED BALANCE ENDPOINT ---------------------------------------------

test('the balance client calls /shopping/pay/getBalance, not the wrong /shopping/balance/ path', async () => {
  const source = await readFile(new URL('../lib/cj-client.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, ''); // comments may still name the old path
  assert.ok(code.includes('/shopping/pay/getBalance'), 'must use the CJ-confirmed path');
  assert.ok(!code.includes('/shopping/balance/getBalance'), 'the incorrect path must be gone');
});

test('the balance request sends the token header only — no body, no query parameters', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    let captured = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes('getAccessToken')) return authResponse;
      captured = { url: String(url), options };
      return { ok: true, json: async () => ({ code: 200, result: true, data: { amount: 0, noWithdrawalAmount: 0, freezeAmount: 0 } }) };
    };
    try {
      await getAccountBalance();
      assert.ok(captured.url.endsWith('/shopping/pay/getBalance'), 'unexpected url: ' + captured.url);
      assert.ok(!captured.url.includes('?'), 'no query parameters may be sent');
      assert.equal(captured.options.body, undefined, 'no request body may be sent');
      assert.equal(captured.options.method, 'GET');
      assert.ok(captured.options.headers['CJ-Access-Token']);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('available / frozen / non-withdrawable balances are parsed from the real CJ field names', () => {
  const live = { code: 200, result: true, message: 'Success', data: { amount: 12.5, noWithdrawalAmount: 3.25, freezeAmount: 1.75 } };
  const parsed = parseCjBalance(live);
  assert.equal(parsed.availableUSD, 12.5);
  assert.equal(parsed.nonWithdrawableUSD, 3.25);
  assert.equal(parsed.frozenUSD, 1.75);
  assert.equal(parseCjBalanceUSD(live), 12.5); // only AVAILABLE is spendable
});

test('frozen and non-withdrawable funds are never counted toward affordability', () => {
  const live = { code: 200, result: true, data: { amount: 5, noWithdrawalAmount: 100, freezeAmount: 100 } };
  const verdict = evaluateBalanceSufficiency({ balanceUSD: parseCjBalanceUSD(live), requiredUSD: 25.51 });
  assert.equal(verdict.sufficient, false, 'a large frozen balance must not make a small available balance look sufficient');
  assert.equal(verdict.reason, 'INSUFFICIENT_CJ_BALANCE');
});

test('a real zero balance blocks, and stays distinguishable from an unreadable balance', () => {
  // The actual live AJLIB wallet state observed today.
  const zero = { code: 200, result: true, data: { amount: 0, noWithdrawalAmount: 0, freezeAmount: 0 } };
  assert.equal(parseCjBalanceUSD(zero), 0);
  const zeroVerdict = evaluateBalanceSufficiency({ balanceUSD: 0, requiredUSD: 25.51 });
  assert.equal(zeroVerdict.reason, 'INSUFFICIENT_CJ_BALANCE'); // means "top up the wallet"

  const unreadable = { code: 1600101, result: false, data: null };
  assert.equal(parseCjBalanceUSD(unreadable), null);
  const unknownVerdict = evaluateBalanceSufficiency({ balanceUSD: null, requiredUSD: 25.51 });
  assert.equal(unknownVerdict.reason, 'CJ_BALANCE_UNAVAILABLE'); // means "cannot verify"
  assert.notEqual(zeroVerdict.reason, unknownVerdict.reason);
});

test('a non-success envelope or non-numeric amount is never coerced to a zero balance', () => {
  assert.equal(parseCjBalance({ code: 200, result: true, data: { amount: 'abc' } }), null);
  assert.equal(parseCjBalance({ code: 200, result: false, data: { amount: 5 } }), null);
  assert.equal(parseCjBalance({ code: 1600200, result: false }), null);
  assert.equal(parseCjBalance(null), null);
});

// ---- payType=2 IMMEDIATE PAYMENT --------------------------------------------

test('payType=2 is used, and its irreversibility is documented at the call site', async () => {
  const payload = buildCjOrderPayload({
    ajlibOrderNumber: 'AJ-1', resolvedItems: [{ cjVariantId: '1', quantity: 5 }],
    logisticName: 'CJPacket Liquid Line', shippingCountryCode: 'AE',
    shippingCity: 'Dubai', shippingCustomerName: 'Test', shippingAddress: 'x'
  });
  assert.equal(payload.payType, CJ_PAY_TYPE_BALANCE);
  assert.equal(payload.payType, 2);
  const source = await readFile(new URL('../lib/cj-client.js', import.meta.url), 'utf8');
  assert.ok(/cannot be rolled back/i.test(source), 'irreversibility must be documented where the call lives');
});

// ---- TIMEOUT RECONCILIATION --------------------------------------------------

test('isCjOrderPaid requires BOTH a paid status and a payment date', () => {
  assert.equal(isCjOrderPaid({ orderStatus: 'UNPAID', paymentDate: null }), false);
  assert.equal(isCjOrderPaid({ orderStatus: 'CREATED', paymentDate: null }), false);
  // Paid-looking status but no payment timestamp -> ambiguous, not paid.
  assert.equal(isCjOrderPaid({ orderStatus: 'PENDING', paymentDate: null }), false);
  assert.equal(isCjOrderPaid({ orderStatus: 'PENDING', paymentDate: '' }), false);
  // An unrecognized status is never assumed paid.
  assert.equal(isCjOrderPaid({ orderStatus: 'SOMETHING_NEW', paymentDate: null }), false);
  assert.equal(isCjOrderPaid({ orderStatus: 'PENDING', paymentDate: '2026-09-17 10:00:00' }), true);
  assert.equal(isCjOrderPaid({ orderStatus: 'SHIPPED', paymentDate: '2026-09-17 10:00:00' }), true);
  assert.equal(isCjOrderPaid(null), false);
});

const mockCjOrderList = (rows, { fail = false } = {}) => async (url) => {
  if (String(url).includes('getAccessToken')) return authResponse;
  if (fail) return { ok: true, json: async () => ({ code: 1600200, result: false, message: 'Too Many Requests, QPS limit is 1 time/1second' }) };
  return { ok: true, json: async () => ({ code: 200, result: true, data: { list: rows } }) };
};

test('after a timeout, an order CJ already paid is reconciled as success — no second request', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCjOrderList([
      { orderNum: 'AJLIB-AJ-777', orderId: 'cj-order-777', orderStatus: 'PENDING', paymentDate: '2026-09-17 10:00:00' }
    ]);
    try {
      const result = await reconcileAfterTimeout('AJ-777');
      assert.equal(result.outcome, 'ALREADY_PAID');
      assert.equal(result.safeToRetry, false);
      assert.equal(result.cjOrderId, 'cj-order-777');
      assert.equal(result.paymentDate, '2026-09-17 10:00:00');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('after a timeout, an order that exists but is UNPAID is never retried automatically', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCjOrderList([
      { orderNum: 'AJLIB-AJ-778', orderId: 'cj-order-778', orderStatus: 'UNPAID', paymentDate: null }
    ]);
    try {
      const result = await reconcileAfterTimeout('AJ-778');
      assert.equal(result.outcome, 'EXISTS_UNPAID');
      assert.equal(result.safeToRetry, false, 'an existing order must never be re-created');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('a retry is only ever permitted when CJ has no order under our deterministic orderNumber', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCjOrderList([{ orderNum: 'AJLIB-SOMEONE-ELSE', orderId: 'x', orderStatus: 'PENDING', paymentDate: '2026-01-01' }]);
    try {
      const result = await reconcileAfterTimeout('AJ-779');
      assert.equal(result.outcome, 'NOT_FOUND');
      assert.equal(result.safeToRetry, true);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('if CJ cannot be read after a timeout, the outcome is UNKNOWN and retry stays forbidden', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCjOrderList([], { fail: true });
    try {
      const result = await reconcileAfterTimeout('AJ-780');
      assert.equal(result.outcome, 'UNKNOWN');
      assert.equal(result.safeToRetry, false, 'an unknown state must never authorize a retry that could double-charge');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('a repeated-payment business error is resolved by read-only reconciliation, not treated as a failed payment', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCjOrderList([
      { orderNum: 'AJLIB-AJ-781', orderId: 'cj-order-781', orderStatus: 'PROCESSING', paymentDate: '2026-09-17 11:00:00' }
    ]);
    try {
      const result = await resolveRepeatedPaymentError('AJ-781');
      assert.equal(result.outcome, 'ALREADY_PAID', 'a repeat-payment error means already handled, not failed');
      assert.equal(result.safeToRetry, false);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('reconciliation keys off our deterministic orderNumber and is itself idempotent', async () => {
  await withEnv({ CJ_API_KEY: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCjOrderList([
      { orderNum: cjOrderNumberFor('AJ-782'), orderId: 'cj-order-782', orderStatus: 'SHIPPED', paymentDate: '2026-09-17 12:00:00' }
    ]);
    try {
      const a = await reconcileAfterTimeout('AJ-782');
      const b = await reconcileAfterTimeout('AJ-782');
      assert.equal(a.orderNumber, 'AJLIB-AJ-782');
      assert.deepEqual(a, b, 'reading twice must produce the same answer and change nothing');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('the CJ wallet still cannot be spent directly — only via an approved createOrderV2', async () => {
  const source = await readFile(new URL('../lib/cj-client.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/payBalance/.test(code), 'payBalance/payBalanceV2 must never be callable');
});
