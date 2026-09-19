// The currency a customer PAYS in — chosen explicitly on AJLIB's checkout,
// before any Stripe object exists. Stripe Adaptive Pricing stays OFF: with a
// customer-side currency toggle on Stripe's page, Apple Pay was once shown
// the AED amount under the USD code ("$419.00"). Now each Checkout Session
// and PaymentIntent carries exactly one currency, fixed by AJLIB, so card,
// Apple Pay, Google Pay and Link all see the same currency and amount.
//
// AED is canonical: every price, fee, margin and CJ decision is in AED fils.
// USD is only the payment presentation of that AED total, converted HERE on
// the server with the approved rate (api/_lib/currency.js). A client never
// supplies an amount; it only names the currency.
import { AED_EXCHANGE_RATES } from './currency.js';

export const PAYMENT_CURRENCIES = Object.freeze(['aed', 'usd']);
export const DEFAULT_PAYMENT_CURRENCY = 'aed';

// The approved AED -> USD rate (0.2723), as an exact integer ratio so the
// conversion is exact integer arithmetic plus one rounding step.
export const AED_TO_USD_RATE = AED_EXCHANGE_RATES.USD;
const RATE_SCALE = 10000;
const RATE_UNITS = Math.round(AED_TO_USD_RATE * RATE_SCALE);

export class PaymentCurrencyError extends Error {}

// undefined / '' -> the default (AED). Anything other than aed/usd is refused
// rather than silently charged in AED, so a client can never get a currency
// it did not see.
export const parsePaymentCurrency = (value) => {
  if (value === undefined || value === null || value === '') return DEFAULT_PAYMENT_CURRENCY;
  const currency = String(value).trim().toLowerCase();
  if (!PAYMENT_CURRENCIES.includes(currency)) throw new PaymentCurrencyError('عملة الدفع غير مدعومة');
  return currency;
};

// AED fils -> USD cents, rounded half-up to the cent.
export const aedFilsToUsdCents = (fils) => {
  const amount = Number(fils);
  if (!Number.isInteger(amount) || amount < 0) throw new PaymentCurrencyError('Invalid AED amount');
  return Math.floor((amount * RATE_UNITS + RATE_SCALE / 2) / RATE_SCALE);
};

// The exact amounts to charge for an order, in the chosen currency. The USD
// TOTAL is converted from the AED total (never the sum of separately rounded
// lines), and the product line takes the remainder, so the lines always add
// up to exactly the converted total.
export const paymentAmounts = ({ productAmountFils, shippingAmountFils, currency = DEFAULT_PAYMENT_CURRENCY }) => {
  const canonicalTotalAed = Number(productAmountFils) + Number(shippingAmountFils);
  if (currency === 'aed') {
    return { currency, product: Number(productAmountFils), shipping: Number(shippingAmountFils), total: canonicalTotalAed, canonicalTotalAed, fxRate: 1 };
  }
  const total = aedFilsToUsdCents(canonicalTotalAed);
  const shipping = aedFilsToUsdCents(Number(shippingAmountFils));
  return { currency, product: total - shipping, shipping, total, canonicalTotalAed, fxRate: AED_TO_USD_RATE };
};

// Both options for display: what the customer would be charged in each.
export const paymentOptions = (totalFils) => ({
  aed: { currency: 'aed', amount: Number(totalFils) },
  usd: { currency: 'usd', amount: aedFilsToUsdCents(totalFils) },
  fxRate: AED_TO_USD_RATE
});
