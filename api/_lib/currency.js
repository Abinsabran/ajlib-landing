// Centralized country -> display currency mapping and FX conversion.
// AED stays the canonical/base commercial currency: Stripe still settles in
// AED (see api/checkout-session.js) and every amount in the database and in
// Stripe metadata is AED fils. This module only affects what a customer
// *sees* on screen — it must never be used to change amounts sent to Stripe.
//
// Rates are illustrative fixed points, not a live feed. Do not hardcode a
// second copy of these numbers anywhere else (frontend or mobile) — always
// call GET /api/currency (see api/currency.js) so there is exactly one place
// to update them, or to later swap in a live FX provider.

export const COUNTRY_CURRENCY = Object.freeze({
  AE: 'AED',
  SA: 'SAR',
  KW: 'KWD',
  QA: 'QAR',
  BH: 'BHD',
  OM: 'OMR',
  US: 'USD',
  AU: 'AUD'
});

// AED -> currency. Update here only; verify against a live source before
// relying on these for anything beyond a rough on-screen estimate.
export const AED_EXCHANGE_RATES = Object.freeze({
  AED: 1,
  SAR: 1.02,
  KWD: 0.0836,
  QAR: 0.99,
  BHD: 0.1026,
  OMR: 0.1046,
  USD: 0.2723,
  AUD: 0.4128
});

export const currencyForCountry = (countryCode) => COUNTRY_CURRENCY[String(countryCode || '').toUpperCase()] || null;

// amountFils is an integer amount in AED fils (matches how orders/Stripe store amounts).
export const convertAedFilsForDisplay = (amountFils, targetCurrency) => {
  const rate = AED_EXCHANGE_RATES[String(targetCurrency || '').toUpperCase()];
  if (!rate) return null;
  return Math.round((Number(amountFils || 0) / 100) * rate * 100) / 100;
};
