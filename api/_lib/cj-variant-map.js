// Server-side AJLIB variant -> CJdropshipping variant mapping.
//
// Populated ONLY from confirmed CJ API responses (via the read-only
// diagnostic in api/commerce.js, resource=cj-diagnostic) — never guessed.
// Ambiguous or unavailable data is left out and reported, not fabricated.
//
// AJLIB_VARIANT_KEY uses the same color/size vocabulary as the rest of the
// codebase: the Arabic color name already used by inventory/orders (see
// api/_lib/catalog.js colorNameAr, api/inventory.js) plus the size string.
// CJ identifiers are internal only — see api/_lib/fulfillment-status.js and the
// customer-safe serializer for where the boundary is enforced; nothing here
// is ever exported to a customer-facing API.

export const AJLIB_VARIANT_KEYS = Object.freeze([
  'أسود-M', 'أسود-L', 'أسود-XL', 'أسود-XXL',
  'كحلي-M', 'كحلي-L', 'كحلي-XL', 'كحلي-XXL',
  'رمادي-M', 'رمادي-L', 'رمادي-XL', 'رمادي-XXL',
  'أبيض-M', 'أبيض-L', 'أبيض-XL', 'أبيض-XXL'
]);

export const CJ_PRODUCT_FAMILY_SKU = 'CJYD1589152';
// CJ's internal numeric product id (distinct from the display SKU above —
// querying /product/query?pid=CJYD1589152 fails with "Product not found";
// productSku is the correct lookup key, and this numeric value is what CJ
// returns as `pid` on the product and every variant record, and what the
// Create Product Connection request needs as `cjProductId`).
export const CJ_PRODUCT_FAMILY_PID = '1581871544228392960';

// Confirmed via GET /product/query?productSku=CJYD1589152 on 2026-09-17
// (read-only, api/commerce.js resource=cj-diagnostic — no order/connection
// write). CJ's internal numeric pid is 1581871544228392960; querying by the
// "pid" query param with the display SKU CJYD1589152 fails (CJ's `pid` means
// its own internal id, not this SKU) — productSku is the correct lookup key.
//
// Normalization notes (documented, not guessed):
// - CJ "Grey" -> AJLIB رمادي (Gray): spelling variant of the same word only.
// - CJ "2XL" -> AJLIB XXL: universally equivalent size label.
// - CJ "Blue" -> AJLIB كحلي (Navy): CJ's catalog has no variant literally
//   named "Navy" or "Navy Blue" for this product family — only "Blue". This
//   was NOT assumed from the name. It was confirmed by visually comparing
//   CJ's Blue variant photo (variantImage below) against AJLIB's own navy
//   product photography (images/products/boxer-navy.jpg) — identical
//   garment, stitching, and gray waistband. Re-verify if CJ ever adds a
//   distinct navy/blue variant to this product family.
// - CJ "Black" and "White" match AJLIB أسود/أبيض by name directly, no
//   normalization needed.
export const CJ_VARIANT_MAP = Object.freeze([
  { ajlibKey: 'أبيض-M', color: 'أبيض', size: 'M', cjVariantId: '1581871544312279040', cjVariantSku: 'CJYD158915201AZ', cjRawColor: 'White', cjRawSize: 'M', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'أبيض-L', color: 'أبيض', size: 'L', cjVariantId: '1581871544312279041', cjVariantSku: 'CJYD158915202BY', cjRawColor: 'White', cjRawSize: 'L', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'أبيض-XL', color: 'أبيض', size: 'XL', cjVariantId: '1581871544316473344', cjVariantSku: 'CJYD158915203CX', cjRawColor: 'White', cjRawSize: 'XL', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'أبيض-XXL', color: 'أبيض', size: 'XXL', cjVariantId: '1581871544320667648', cjVariantSku: 'CJYD158915204DW', cjRawColor: 'White', cjRawSize: '2XL', pid: CJ_PRODUCT_FAMILY_PID },

  { ajlibKey: 'أسود-M', color: 'أسود', size: 'M', cjVariantId: '1581871544320667649', cjVariantSku: 'CJYD158915205EV', cjRawColor: 'Black', cjRawSize: 'M', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'أسود-L', color: 'أسود', size: 'L', cjVariantId: '1581871544320667650', cjVariantSku: 'CJYD158915206FU', cjRawColor: 'Black', cjRawSize: 'L', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'أسود-XL', color: 'أسود', size: 'XL', cjVariantId: '1581871544324861952', cjVariantSku: 'CJYD158915207GT', cjRawColor: 'Black', cjRawSize: 'XL', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'أسود-XXL', color: 'أسود', size: 'XXL', cjVariantId: '1581871544324861953', cjVariantSku: 'CJYD158915208HS', cjRawColor: 'Black', cjRawSize: '2XL', pid: CJ_PRODUCT_FAMILY_PID },

  { ajlibKey: 'كحلي-M', color: 'كحلي', size: 'M', cjVariantId: '1581871544324861954', cjVariantSku: 'CJYD158915209IR', cjRawColor: 'Blue', cjRawSize: 'M', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'كحلي-L', color: 'كحلي', size: 'L', cjVariantId: '1581871544329056256', cjVariantSku: 'CJYD158915210JQ', cjRawColor: 'Blue', cjRawSize: 'L', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'كحلي-XL', color: 'كحلي', size: 'XL', cjVariantId: '1581871544329056257', cjVariantSku: 'CJYD158915211KP', cjRawColor: 'Blue', cjRawSize: 'XL', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'كحلي-XXL', color: 'كحلي', size: 'XXL', cjVariantId: '1581871544329056258', cjVariantSku: 'CJYD158915212LO', cjRawColor: 'Blue', cjRawSize: '2XL', pid: CJ_PRODUCT_FAMILY_PID },

  { ajlibKey: 'رمادي-M', color: 'رمادي', size: 'M', cjVariantId: '1581871544329056259', cjVariantSku: 'CJYD158915213MN', cjRawColor: 'Grey', cjRawSize: 'M', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'رمادي-L', color: 'رمادي', size: 'L', cjVariantId: '1581871544333250560', cjVariantSku: 'CJYD158915214NM', cjRawColor: 'Grey', cjRawSize: 'L', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'رمادي-XL', color: 'رمادي', size: 'XL', cjVariantId: '1581871544333250561', cjVariantSku: 'CJYD158915215OL', cjRawColor: 'Grey', cjRawSize: 'XL', pid: CJ_PRODUCT_FAMILY_PID },
  { ajlibKey: 'رمادي-XXL', color: 'رمادي', size: 'XXL', cjVariantId: '1581871544333250562', cjVariantSku: 'CJYD158915216PK', cjRawColor: 'Grey', cjRawSize: '2XL', pid: CJ_PRODUCT_FAMILY_PID }
]);

export const isFullyMapped = () => {
  const mappedKeys = new Set(CJ_VARIANT_MAP.map(v => v.ajlibKey));
  return AJLIB_VARIANT_KEYS.every(key => mappedKeys.has(key));
};

export const missingVariants = () => {
  const mappedKeys = new Set(CJ_VARIANT_MAP.map(v => v.ajlibKey));
  return AJLIB_VARIANT_KEYS.filter(key => !mappedKeys.has(key));
};

export const cjVariantFor = (ajlibKey) => CJ_VARIANT_MAP.find(v => v.ajlibKey === ajlibKey) || null;
