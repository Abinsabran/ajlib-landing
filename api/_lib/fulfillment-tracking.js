// Read-only CJ tracking sync for one submitted order (polling only — the CJ
// webhook is not registered). Reads CJ's order detail and, once a tracking
// number exists, CJ's official tracking information; stores CJ's raw status,
// tracking number, carrier, tracking URL and sync time internally; and moves
// the customer-facing order.status forward only along AJLIB's own ladder
// (paid -> processing -> packed -> shipped -> delivered), so customers only
// ever see the five customer statuses — never CJ's vocabulary or ids.

import { getOrderDetail, getTrackInfo, isCjErrorBody } from './cj-client.js';
import { nextInternalStatusFromCjStatus, serializeOrderForCustomer } from './fulfillment-status.js';
import { patchOrder } from './fulfillment-runner.js';

// CJ reports "UNSHIPPED" with subStatus PENDING or PROCESSING; the sub-status
// is the meaningful one for AJLIB's ladder.
export const effectiveCjStatus = (detail) => {
  const status = String(detail?.orderStatus || '').toUpperCase();
  const sub = String(detail?.subStatus || '').toUpperCase();
  if (status === 'UNSHIPPED' && ['PENDING', 'PROCESSING'].includes(sub)) return sub;
  return status || null;
};

// Pure: turns CJ's detail + tracking into the patch for the order row.
export const buildTrackingPatch = (orderRow, detail, track, now = new Date().toISOString()) => {
  const cjStatus = effectiveCjStatus(detail);
  const trackNumber = detail?.trackNumber || track?.trackingNumber || null;
  const carrier = track?.lastMileCarrier || detail?.trackingProvider || track?.logisticName || detail?.logisticName || null;
  const patch = {
    fulfillment_last_sync_at: now,
    ...(cjStatus ? { fulfillment_status: cjStatus } : {}),
    ...(trackNumber ? { fulfillment_tracking_number: trackNumber } : {}),
    ...(carrier ? { fulfillment_carrier: carrier } : {}),
    ...(detail?.trackingUrl ? { fulfillment_tracking_url: detail.trackingUrl } : {})
  };

  const next = cjStatus ? nextInternalStatusFromCjStatus(orderRow.status, cjStatus) : null;
  if (next === 'cancelled') {
    // A CJ-side cancellation is an operations problem, not a customer
    // outcome: the customer paid AJLIB. Flag it; never cancel automatically.
    patch.fulfillment_error = 'CJ_ORDER_CANCELLED';
  } else if (next && next !== orderRow.status) {
    patch.status = next;
  }

  // Customer-visible tracking appears only once shipped, and never
  // overwrites details an admin entered by hand.
  const shipped = ['shipped', 'delivered'].includes(patch.status || orderRow.status);
  if (shipped) {
    const customerNumber = track?.lastTrackNumber || trackNumber;
    const customerCarrier = track?.lastMileCarrier || detail?.trackingProvider || null;
    if (customerNumber && !orderRow.tracking_number) patch.tracking_number = customerNumber;
    if (customerCarrier && !orderRow.shipping_company) patch.shipping_company = customerCarrier;
  }
  return { cjStatus, patch };
};

export const syncTracking = async (orderRow) => {
  const cjOrderId = orderRow?.fulfillment_external_order_id;
  if (!cjOrderId) return { synced: false, reason: 'NOT_SUBMITTED' };

  const detailResponse = await getOrderDetail(cjOrderId);
  if (isCjErrorBody(detailResponse.body) || !detailResponse.body?.data) {
    // Nothing is written on a failed read: "unknown" must never look like progress.
    return { synced: false, reason: 'CJ_ORDER_DETAIL_ERROR', code: detailResponse.body?.code ?? null };
  }
  const detail = detailResponse.body.data;

  let track = null;
  if (detail.trackNumber) {
    const trackResponse = await getTrackInfo(detail.trackNumber);
    if (!isCjErrorBody(trackResponse.body) && Array.isArray(trackResponse.body?.data)) {
      track = trackResponse.body.data.find(row => row.trackingNumber === detail.trackNumber) || trackResponse.body.data[0] || null;
    }
  }

  const { cjStatus, patch } = buildTrackingPatch(orderRow, detail, track);
  const saved = await patchOrder(orderRow.id, patch);
  return {
    synced: saved === true,
    cjStatus,
    trackingStatus: track?.trackingStatus ?? null,
    tracking: {
      number: patch.fulfillment_tracking_number ?? orderRow.fulfillment_tracking_number ?? null,
      carrier: patch.fulfillment_carrier ?? null,
      url: patch.fulfillment_tracking_url ?? null
    },
    // Exactly what the customer would see after this sync.
    customer: serializeOrderForCustomer({ ...orderRow, ...patch })
  };
};
