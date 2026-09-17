// Phase 3 — CJ API Store connection payload preparation ONLY.
//
// Nothing in this file makes a network call. It builds the exact request
// bodies for the three official CJ API-store endpoints (confirmed against
// CJ's live docs, developers.cjdropshipping.com/en/api/api2/api/shop.html —
// not guessed), so they can be reviewed before anything is ever sent.
//
//   1. POST /api2.0/v1/store/product/saveProduct        (write — not called)
//   2. POST /api2.0/v1/store/product/saveVariantBatch    (write — not called)
//   3. POST /api2.0/v1/product/conn/connection            (write — not called)
//
// A read counterpart of #3, GET /api2.0/v1/product/conn/connection ("Query
// Product Connection List"), was used read-only during Phase 3 discovery
// and confirmed: no AJLIB store product exists yet (shop/product/queryPage
// -> total:0) and no connection exists yet (-> total:0).
//
// AJLIB-side identifiers below (id/platformProductId/platformVariantId) are
// ones WE choose — they are not CJ identifiers and are safe to define here.
// CJ-side identifiers (cjProductId/cjVariantId) come only from
// lib/cj-variant-map.js's confirmed, non-guessed data.

import { CJ_VARIANT_MAP, CJ_PRODUCT_FAMILY_PID, isFullyMapped } from './cj-variant-map.js';
import { colorCodeFromNameAr } from './catalog.js';

export const AJLIB_PLATFORM_PRODUCT_ID = 'ajlib-ice-silk-boxer-briefs';

export const platformVariantId = (entry) => `ajlib-${colorCodeFromNameAr(entry.color)}-${entry.size}`;

// ---- 1. Save Product ------------------------------------------------------
export const buildSaveProductPayload = ({ image, priceMin, priceMax, priceCurrency = 'AED' } = {}) => ({
  id: AJLIB_PLATFORM_PRODUCT_ID,
  title: 'AJLIB Ice Silk Long Boxer Briefs',
  image, // required, max 400 chars — must be a public absolute image URL
  description: 'Breathable ice-silk fabric with durable stitching for everyday wear.',
  priceMin,
  priceMax,
  priceCurrency
});

// ---- 2. Save Variant Batch -------------------------------------------------
export const buildSaveVariantBatchPayload = ({ imageFor, shopPrice, shopPriceCurrency = 'AED', weightKg = 0.18 } = {}) => ({
  variants: CJ_VARIANT_MAP.map(entry => ({
    id: platformVariantId(entry),
    productId: AJLIB_PLATFORM_PRODUCT_ID,
    title: `AJLIB Ice Silk Boxer Briefs — ${entry.color} ${entry.size}`,
    sku: `AJLIB-${colorCodeFromNameAr(entry.color).toUpperCase()}-${entry.size}`,
    image: imageFor ? imageFor(entry) : undefined, // required, max 500 chars
    shopPrice,
    shopPriceCurrency,
    weight: weightKg,
    weightUnit: 'kg'
  }))
});

// ---- 3. Create Product Connection ------------------------------------------
//
// defaultArea: CONFIRMED = 1. Live GET /product/globalWarehouseList matches
// CJ's docs (areaId 1 = China, countryCode CN); live GET
// /product/stock/queryByVid for our variants shows stock in ONLY areaId 1 —
// no other warehouse is listed for this product at all, so 1 is not just
// valid but the only option.
//
// logistics: NOT unilaterally resolved — this is a real cost/speed
// trade-off, which is a commercial decision, not a technical one this file
// should make. Live POST /logistic/freightCalculate (products:[{vid,
// quantity}]) across all 8 supported destinations (AE, SA, KW, QA, BH, OM,
// US, AU) with a real confirmed vid found the sets of available logistics
// methods DIFFER per destination (3 methods for KW, 29 for US, etc). Exactly
// two methods are common to ALL 8: "CJPacket Postal" (cheapest, slowest —
// 12-50 days) and "DHL Official" (fastest, most expensive — $118-150 vs
// $10-40 for the others). Confirm which of these two — or whether the
// business already has a preference from the existing CJ fulfillment
// arrangement — before calling this. No `shopMethod` field exists anywhere
// in CJ's documented Save Product / Save Variant Batch / Connection schemas,
// so that option doesn't apply here.
export const LOGISTICS_METHODS_COMMON_TO_ALL_SUPPORTED_DESTINATIONS = Object.freeze(['CJPacket Postal', 'DHL Official']);

// sourceCountryCode/sourceCountry default to CN/China: live GET
// /product/stock/queryByVid confirmed this product's stock exists in the
// China warehouse only (areaId 1), so this reflects the real, confirmed
// fulfillment origin rather than an assumption.
//
// targetCountryCode/targetCountry are intentionally never set — CJ's schema
// marks them optional, and AJLIB ships to 8 markets (AE, SA, KW, QA, BH, OM,
// US, AU) from this same connection, confirmed by freightCalculate
// returning valid routes to all 8 for the same vid. Locking the connection
// to one target country would misrepresent that.
export const buildCreateConnectionPayload = ({ defaultArea, logistics, sourceCountryCode = 'CN', sourceCountry = 'China', ignoreCheckInventory } = {}) => {
  if (!isFullyMapped()) {
    throw new Error('Refusing to build a connection payload: not all 16 AJLIB variants are mapped');
  }
  return {
    defaultArea,
    logistics,
    cjProductId: CJ_PRODUCT_FAMILY_PID,
    platformProductId: AJLIB_PLATFORM_PRODUCT_ID,
    sourceCountryCode,
    sourceCountry,
    variantList: CJ_VARIANT_MAP.map(entry => ({
      cjVariantId: entry.cjVariantId,
      platformVariantId: platformVariantId(entry)
    })),
    ...(ignoreCheckInventory !== undefined ? { ignoreCheckInventory } : {})
  };
};
