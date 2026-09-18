// AJLIB's approved shipping markets — the single server-side whitelist.
//
// Enforced in quoteShipping (api/shipping-quote.js), which every price quote,
// checkout (Stripe web + app, Tabby) and shipping quote goes through, so a
// country outside this list cannot be quoted, priced or paid for, whatever a
// client sends. The storefront and the app show exactly this list.
//
// Approved 2026-09-18. Oman (OM) is deliberately excluded: its currently
// suitable CJ route is DDU (duties unpaid), which does not fit AJLIB's launch
// policy. Historical orders to other countries are not affected.
export const SHIPPING_COUNTRIES = Object.freeze(['AE', 'SA', 'KW', 'QA', 'BH', 'US', 'AU']);

export const isShippingCountry = (countryCode) => SHIPPING_COUNTRIES.includes(String(countryCode ?? '').trim().toUpperCase());
