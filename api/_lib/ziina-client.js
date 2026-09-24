// Official Ziina Payment Intent API: https://docs.ziina.com/api-reference/payment-intent
// Hosted redirect only. Embedded checkout needs a separate domain approval.
const BASE_URL = 'https://api-v2.ziina.com/api';

export class ZiinaApiError extends Error {
  constructor(status) {
    super('Ziina request failed');
    this.status = status;
  }
}

const request = async (path, options = {}) => {
  if (!process.env.ZIINA_API_KEY) throw new ZiinaApiError(503);
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.ZIINA_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new ZiinaApiError(response.status);
  return response.json();
};

export const createZiinaIntent = ({ amount, currency, orderNumber, successUrl, cancelUrl, failureUrl }) => {
  if (!Number.isSafeInteger(amount) || amount <= 0 || !['AED', 'USD'].includes(currency)) throw new Error('Invalid payment amount or currency');
  return request('/payment_intent', {
    method: 'POST',
    body: JSON.stringify({
      amount,
      currency_code: currency,
      message: `AJLIB order ${orderNumber}`,
      success_url: successUrl,
      cancel_url: cancelUrl,
      failure_url: failureUrl,
      allow_tips: false,
      test: process.env.ZIINA_TEST_MODE === 'true'
    })
  });
};

export const getZiinaIntent = (id) => request(`/payment_intent/${encodeURIComponent(id)}`, { method: 'GET' });

export const ZIINA_COMPLETED_STATUS = 'completed';
export const ZIINA_TERMINAL_FAILURES = new Set(['failed', 'canceled']);
