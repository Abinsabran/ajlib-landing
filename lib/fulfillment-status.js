// Customer-safe fulfillment status mapping and serializer.
//
// The existing `orders.status` column (paid/processing/packed/shipped/
// delivered/cancelled/refunded — see supabase-schema.sql) and the admin
// update flow in api/update-order.js are UNCHANGED by this file. This is an
// additive translation layer: it maps that existing internal status to the
// 5 customer-facing statuses, and it is the single place that strips any
// future provider-internal fields (fulfillmentProvider,
// fulfillmentExternalOrderId, CJ order ids, warehouse/supplier data, etc.)
// before an order is ever returned to a customer-facing API or the app.

export const CUSTOMER_STATUS = Object.freeze({
  ORDER_RECEIVED: { ar: 'تم استلام الطلب', en: 'Order received' },
  PREPARING_ORDER: { ar: 'جاري تجهيز الطلب', en: 'Preparing your order' },
  PREPARING_SHIPMENT: { ar: 'جاري تجهيز الشحن', en: 'Preparing shipment' },
  SHIPPED: { ar: 'تم الشحن', en: 'Shipped' },
  DELIVERED: { ar: 'تم التوصيل', en: 'Delivered' },
  CANCELLED: { ar: 'تم إلغاء الطلب', en: 'Order cancelled' },
  REFUNDED: { ar: 'تم استرجاع المبلغ', en: 'Refunded' }
});

// Maps the existing internal order.status (used today by api/update-order.js
// and the admin console) to a customer-facing status key. This does not
// change what admins pick from — it only changes what a customer is shown.
const INTERNAL_TO_CUSTOMER = Object.freeze({
  paid: 'ORDER_RECEIVED',
  processing: 'PREPARING_ORDER',
  packed: 'PREPARING_SHIPMENT',
  shipped: 'SHIPPED',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
  refunded: 'REFUNDED'
});

// CJ's real, documented order status enum (confirmed via CJ's official docs,
// developers.cjdropshipping.com/en/api/api2/api/shopping.html — "Query
// Order" section — not guessed) mapped onto AJLIB's EXISTING internal
// admin-status vocabulary (paid/processing/packed/shipped/delivered/
// cancelled), so the customer-facing translation stays two-hop and never
// grows past the 5 statuses. UNPAID/CREATED/IN_CART reflect CJ's OWN
// settlement step (e.g. balance top-up), not whether the customer paid
// AJLIB — that's already verified server-side before fulfillment ever
// starts, so these still surface as "order received" to the customer.
export const PROVIDER_STATUS_MAP = Object.freeze({
  CREATED: 'paid',
  IN_CART: 'paid',
  UNPAID: 'paid',
  PENDING: 'processing',
  UNSHIPPED: 'processing', // generic parent of PENDING/PROCESSING if CJ returns it without a sub-status
  PROCESSING: 'packed',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled'
});

const STATUS_RANK = Object.freeze({ paid: 0, processing: 1, packed: 2, shipped: 3, delivered: 4 });

// Applies a CJ status update to the current internal status, refusing to
// regress (e.g. SHIPPED after DELIVERED must never move the order back) and
// refusing to guess at an unrecognized CJ status (returns null — caller
// should leave the order untouched and log for investigation, not fail
// loudly to the customer). CJ-side cancellation always surfaces immediately
// regardless of rank, since it isn't a shipping-progress regression.
export const nextInternalStatusFromCjStatus = (currentInternalStatus, cjStatus) => {
  const mapped = PROVIDER_STATUS_MAP[cjStatus];
  if (!mapped) return null;
  if (mapped === 'cancelled') return 'cancelled';
  const currentRank = STATUS_RANK[currentInternalStatus] ?? 0;
  const nextRank = STATUS_RANK[mapped] ?? 0;
  if (nextRank < currentRank) return null;
  return mapped;
};

export const customerStatusFor = (internalStatus) => INTERNAL_TO_CUSTOMER[internalStatus] || null;

// Strips every internal/provider field an order row might one day carry
// (fulfillmentProvider, fulfillmentExternalOrderId, fulfillmentLastSyncAt,
// fulfillmentError, any CJ/warehouse/supplier metadata) before the order is
// serialized for a customer-facing response. Tracking number is only
// surfaced once the order has actually shipped.
export const serializeOrderForCustomer = (order, language = 'ar') => {
  const statusKey = customerStatusFor(order.status);
  const hasShipped = ['shipped', 'delivered'].includes(order.status);
  return {
    order_number: order.order_number,
    status: statusKey,
    status_label: statusKey ? CUSTOMER_STATUS[statusKey][language] : order.status,
    amount_total: order.amount_total,
    currency: order.currency,
    items: order.items,
    shipping_company: hasShipped ? (order.shipping_company || null) : null,
    tracking_number: hasShipped ? (order.tracking_number || null) : null,
    created_at: order.created_at,
    updated_at: order.updated_at
  };
};
