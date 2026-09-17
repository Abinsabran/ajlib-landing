import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/commerce.js';

// api/order-quote.js, api/catalog.js, api/currency.js and
// api/tabby-availability.js were consolidated into this single file to stay
// within Vercel Hobby's 12-Serverless-Function limit (project was at 13).
// Their public URLs are preserved unchanged via vercel.json rewrites to
// /api/commerce?resource=<name>; this test proves the dispatcher resolves
// correctly both from that query param (how Vercel's rewrite reaches it) and
// from req.url (a defensive fallback in case a given Vercel routing mode
// presents the original path instead), and rejects anything unknown.

const makeRes = () => {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  return res;
};

test('dispatch: unknown resource returns 404 instead of silently doing nothing', async () => {
  const res = await handler({ method: 'GET', query: { resource: 'nope' }, url: '/api/commerce?resource=nope' }, makeRes());
  assert.equal(res.statusCode, 404);
});

test('dispatch: resource resolves via query param (Vercel rewrite path)', async () => {
  const res = await handler({ method: 'GET', query: { resource: 'catalog' }, url: '/api/commerce?resource=catalog' }, makeRes());
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.products));
});

test('dispatch: resource resolves via req.url pathname fallback (no query param)', async () => {
  const res = await handler({ method: 'GET', query: {}, url: '/api/catalog' }, makeRes());
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.products));
});

test('catalog resource: still exposes the one live product with all 16 variants worth of colors/sizes', async () => {
  const res = await handler({ method: 'GET', query: { resource: 'catalog' } }, makeRes());
  assert.equal(res.body.products.length, 1);
  assert.equal(res.body.products[0].colors.length, 4);
  assert.equal(res.body.products[0].sizes.length, 4);
});

test('currency resource: unchanged behavior after consolidation', async () => {
  const listRes = await handler({ method: 'GET', query: { resource: 'currency' } }, makeRes());
  assert.deepEqual(Object.keys(listRes.body.countries).sort(), ['AE', 'AU', 'BH', 'KW', 'OM', 'QA', 'SA', 'US'].sort());

  const convertRes = await handler({ method: 'GET', query: { resource: 'currency', country_code: 'AE', amount_fils: '10000' } }, makeRes());
  assert.equal(convertRes.body.currency, 'AED');
  assert.equal(convertRes.body.display_amount, 100);
});

test('tabby-availability resource: hidden (available:false) when TABBY_MODE is not test', async () => {
  const previous = process.env.TABBY_MODE;
  delete process.env.TABBY_MODE;
  try {
    const res = await handler({ method: 'GET', query: { resource: 'tabby-availability', country_code: 'AE', amount_fils: '11900' } }, makeRes());
    assert.equal(res.body.available, false);
    assert.equal(res.body.mode, 'disabled');
  } finally {
    if (previous !== undefined) process.env.TABBY_MODE = previous;
  }
});

test('order-quote resource still works when dispatched through the consolidated handler', async () => {
  const res = await handler({ method: 'GET', query: { resource: 'order-quote', country: 'AE', quantity: '10' } }, makeRes());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.productSubtotal, 26900);
  assert.equal(res.body.shipping, 0);
});
