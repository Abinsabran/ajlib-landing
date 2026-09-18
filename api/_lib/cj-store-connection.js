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
// api/_lib/cj-variant-map.js's confirmed, non-guessed data.

import { CJ_VARIANT_MAP, CJ_PRODUCT_FAMILY_PID, isFullyMapped } from './cj-variant-map.js';
import { colorCodeFromNameAr } from './catalog.js';

export const AJLIB_PLATFORM_PRODUCT_ID = 'ajlib-ice-silk-boxer-briefs';

// Confirmed via GET /shop/getShops (read-only): two "api"-type shops exist
// on this account. { id: "2609160939212912600", name: "AJLIB" } is a clean,
// exact-match name with no anomalies — matches "AJLIB — Default store"
// literally. { id: "2609160936272908900", name: "ِajlib" } carries a
// stray leading Arabic diacritic character (U+0650, kasra) before "ajlib" —
// consistent with a manually-typed entry, i.e. "ajlib — Manually added
// store". CJ's API has no isDefault/shopSource field to confirm this more
// directly (checked: not documented in shop.html) — this is the strongest
// evidence available from the API; cross-check the id against the CJ
// dashboard before using it in a live write.
export const AJLIB_DEFAULT_SHOP_ID = '2609160939212912600';

export const platformVariantId = (entry) => `ajlib-${colorCodeFromNameAr(entry.color)}-${entry.size}`;

// ---- 1. Save Product ------------------------------------------------------
// shopId is a top-level, optional-per-schema field — CJ support instructed
// passing it explicitly rather than relying on the account-level fallback.
export const buildSaveProductPayload = ({ image, priceMin, priceMax, priceCurrency = 'AED', shopId = AJLIB_DEFAULT_SHOP_ID } = {}) => ({
  id: AJLIB_PLATFORM_PRODUCT_ID,
  shopId,
  title: 'AJLIB Ice Silk Long Boxer Briefs',
  image, // required, max 400 chars — must be a public absolute image URL
  description: 'Breathable ice-silk fabric with durable stitching for everyday wear.',
  priceMin,
  priceMax,
  priceCurrency
});

// ---- 2. Save Variant Batch -------------------------------------------------
// shopId is documented as a batch-level field (top-level of the request,
// not per-variant) — same explicit-shopId instruction from CJ support.
export const buildSaveVariantBatchPayload = ({ imageFor, shopPrice, shopPriceCurrency = 'AED', weightKg = 0.18, shopId = AJLIB_DEFAULT_SHOP_ID } = {}) => ({
  shopId,
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
// logistics: two methods were initially found common to all 8 destinations
// at qty=1 — "CJPacket Postal" (cheap, slow) and "DHL Official" (fast,
// expensive). A follow-up round tested REAL AJLIB order quantities
// (5/10/15/20/50, matching the site's actual pack sizes) via live
// freightCalculate across all 8 destinations: CJPacket Postal is available
// ONLY at qty 5-10 and disappears at qty>=15 for every single destination,
// including a 15-piece order — a real, common AJLIB pack size. DHL Official
// remained available at every quantity tested, everywhere. This is why
// DHL_OFFICIAL is exported below as the evidence-backed recommendation
// rather than presenting both as equally viable — CJPacket Postal is not a
// realistic connection-level default given AJLIB's actual order sizes.
//
// Confirmed independently via CJ's official createOrder docs
// (developers.cjdropshipping.com/en/api/api2/api/shopping.html): every
// order specifies its own required `logisticName` field, with no documented
// inheritance from the Connection's `logistics` value — so this choice does
// NOT lock real customer orders to one method; it's what CJ suggests as a
// starting default. No `shopMethod` field exists anywhere in CJ's
// documented Save Product / Save Variant Batch / Connection schemas.
export const LOGISTICS_METHODS_COMMON_TO_ALL_SUPPORTED_DESTINATIONS = Object.freeze(['CJPacket Postal', 'DHL Official']);
export const RECOMMENDED_DEFAULT_LOGISTICS = 'DHL Official';

// sourceCountryCode/sourceCountry default to CN/China: live GET
// /product/stock/queryByVid confirmed this product's stock exists in the
// China warehouse only (areaId 1), so this reflects the real, confirmed
// fulfillment origin rather than an assumption.
//
// targetCountryCode/targetCountry: CJ's schema marks both optional and
// nothing in the documented schema restricts them to single-market stores —
// CJ support advised setting a main target market on the connection, and
// AJLIB's primary market (AE) is used here per that guidance. This does not
// restrict fulfillment to AE: confirmed separately (createOrder docs) that
// every real order supplies its own destination independently, and
// freightCalculate already proved valid routes exist to all 8 supported
// markets for this same vid — targetCountry is a declared primary market,
// not an enforced shipping restriction.
//
// shopId: explicit per CJ support's instruction, not relying on the
// account-level fallback. See AJLIB_DEFAULT_SHOP_ID above for how it was
// resolved and the evidence it's the Default store, not the manually added
// one.
export const buildCreateConnectionPayload = ({
  defaultArea, logistics, sourceCountryCode = 'CN', sourceCountry = 'China',
  targetCountryCode = 'AE', targetCountry = 'United Arab Emirates',
  shopId = AJLIB_DEFAULT_SHOP_ID, ignoreCheckInventory
} = {}) => {
  if (!isFullyMapped()) {
    throw new Error('Refusing to build a connection payload: not all 16 AJLIB variants are mapped');
  }
  return {
    shopId,
    defaultArea,
    logistics,
    cjProductId: CJ_PRODUCT_FAMILY_PID,
    platformProductId: AJLIB_PLATFORM_PRODUCT_ID,
    sourceCountryCode,
    sourceCountry,
    targetCountryCode,
    targetCountry,
    variantList: CJ_VARIANT_MAP.map(entry => ({
      cjVariantId: entry.cjVariantId,
      platformVariantId: platformVariantId(entry)
    })),
    ...(ignoreCheckInventory !== undefined ? { ignoreCheckInventory } : {})
  };
};
