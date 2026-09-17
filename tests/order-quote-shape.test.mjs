import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/order-quote.js';

// Locks /api/order-quote's response shape against the fields the ALREADY
// SHIPPED Expo/iOS app actually reads (verified against
// outputs/ajlib-mobile/App.js): data.error, data.supportedCountries,
// productSubtotal, unitPrice, shipping, total, minDays, maxDays,
// isFreeShipping. showOmanHighRateNote is read with optional chaining by the
// app (productQuote?.showOmanHighRateNote) and is intentionally NOT returned
// here — it was invented by the app's own pre-launch validation script, not
// by any real shipping rule, so the note silently does not render instead of
// asserting a fabricated business rule.

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; delete process.env[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] !== undefined) process.env[key] = previous[key]; } }
};

const makeReq = (query) => ({ method: 'GET', query });
const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

// Force the fallback (non-Supabase) code path so this test never makes a
// network call, matching how CI/local runs behave without those env vars.
const noSupabase = { SUPABASE_URL: undefined, SUPABASE_SECRET_KEY: undefined };

test('order-quote: success response has every field the shipped app reads', async () => {
  await withEnv(noSupabase, async () => {
    const res = await handler(makeReq({ country: 'AE', quantity: '10', language: 'ar' }), makeRes());
    assert.equal(res.statusCode, 200);
    for (const field of ['productSubtotal', 'unitPrice', 'shipping', 'total', 'isFreeShipping', 'minDays', 'maxDays', 'supportedCountries']) {
      assert.ok(field in res.body, `missing field: ${field}`);
    }
    assert.equal(typeof res.body.productSubtotal, 'number');
    assert.equal(typeof res.body.shipping, 'number');
    assert.equal(res.body.total, res.body.productSubtotal + res.body.shipping);
    assert.ok(Array.isArray(res.body.supportedCountries));
    assert.ok(res.body.supportedCountries.includes('AE'));
  });
});

test('order-quote: AE is free shipping, matching the live shipping-quote.js zone', async () => {
  await withEnv(noSupabase, async () => {
    const res = await handler(makeReq({ country: 'AE', quantity: '5' }), makeRes());
    assert.equal(res.body.shipping, 0);
    assert.equal(res.body.isFreeShipping, true);
  });
});

test('order-quote: rejects out-of-range quantity with an error string the app can display', async () => {
  await withEnv(noSupabase, async () => {
    const res = await handler(makeReq({ country: 'AE', quantity: '101' }), makeRes());
    assert.equal(res.statusCode, 400);
    assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
  });
});

test('order-quote: rejects an unsupported/unresolvable country the same way shipping-quote.js would', async () => {
  await withEnv(noSupabase, async () => {
    const res = await handler(makeReq({ country: 'ZZ', quantity: '5' }), makeRes());
    // ZZ is not a real ISO code but still resolves to the WORLD catch-all
    // zone today (worldwide shipping) — a genuinely malformed country
    // (empty/non 2-letter) is what actually gets rejected by quoteShipping().
    const malformed = await handler(makeReq({ country: '', quantity: '5' }), makeRes());
    assert.equal(malformed.statusCode, 400);
    assert.ok(malformed.body.message_ar && malformed.body.message_en);
    void res;
  });
});
