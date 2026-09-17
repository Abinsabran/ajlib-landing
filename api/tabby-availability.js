import { isTabbyPotentiallyAvailable } from '../lib/tabby-client.js';
import { currencyForCountry } from '../lib/currency.js';

// Public, read-only: tells a client whether to render a Tabby option at all.
// Stripe is never gated by this — it's always shown independently. This does
// not create a Tabby session; it only decides visibility so an ineligible
// customer never sees a payment method that would fail.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const countryCode = String(req.query.country_code || '').trim().toUpperCase();
  const amountFils = Number(req.query.amount_fils);
  const currency = currencyForCountry(countryCode) || 'AED';

  const available = isTabbyPotentiallyAvailable({ countryCode, currency, amountFils });
  return res.status(200).json({ available, currency, mode: process.env.TABBY_MODE || 'disabled' });
}
