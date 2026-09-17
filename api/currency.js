import { COUNTRY_CURRENCY, currencyForCountry, convertAedFilsForDisplay } from '../lib/currency.js';

// Display-only currency helper. Nothing here touches Stripe settlement,
// checkout totals or shipping eligibility — those stay AED-authoritative in
// api/checkout-session.js and api/shipping-quote.js. Given an AED-fils
// amount and a country, returns the converted display amount for that
// country's local currency so the frontend/mobile never hardcode FX rates.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const countryCode = String(req.query.country_code || '').trim().toUpperCase();
  const amountFils = Number(req.query.amount_fils);

  if (!countryCode) {
    return res.status(200).json({ countries: COUNTRY_CURRENCY });
  }

  const currency = currencyForCountry(countryCode);
  if (!currency) return res.status(400).json({ error: 'دولة غير مدعومة لعرض العملة' });

  if (!Number.isFinite(amountFils)) {
    return res.status(200).json({ country_code: countryCode, currency });
  }

  const display = convertAedFilsForDisplay(amountFils, currency);
  return res.status(200).json({ country_code: countryCode, currency, amount_aed: amountFils / 100, display_amount: display, display_is_estimate: currency !== 'AED' });
}
