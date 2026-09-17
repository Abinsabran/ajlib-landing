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
// defaultArea/logistics are REQUIRED by CJ's schema but their valid values
// (area codes, logistics method names) were not looked up in this phase —
// they must come from CJ's Logistics API docs, not be guessed. Passed in by
// the caller so this function never fabricates them.
export const buildCreateConnectionPayload = ({ defaultArea, logistics, ignoreCheckInventory } = {}) => {
  if (!isFullyMapped()) {
    throw new Error('Refusing to build a connection payload: not all 16 AJLIB variants are mapped');
  }
  return {
    defaultArea,
    logistics,
    cjProductId: CJ_PRODUCT_FAMILY_PID,
    platformProductId: AJLIB_PLATFORM_PRODUCT_ID,
    variantList: CJ_VARIANT_MAP.map(entry => ({
      cjVariantId: entry.cjVariantId,
      platformVariantId: platformVariantId(entry)
    })),
    ...(ignoreCheckInventory !== undefined ? { ignoreCheckInventory } : {})
  };
};
