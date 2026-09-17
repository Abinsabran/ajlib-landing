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

// Once a CJ (or other) fulfillment provider is wired up, its own status
// strings get mapped here first, then folded into INTERNAL_TO_CUSTOMER's
// keys so the customer-facing vocabulary never grows past the 5 statuses.
// Left empty on purpose: no provider is live yet, so nothing maps through
// this table today.
export const PROVIDER_STATUS_MAP = Object.freeze({});

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
