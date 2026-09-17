// Server-side AJLIB variant -> CJdropshipping variant mapping.
//
// Populated ONLY from confirmed CJ API responses (via the read-only
// diagnostic in api/commerce.js, resource=cj-diagnostic) — never guessed.
// Ambiguous or unavailable data is left out and reported, not fabricated.
//
// AJLIB_VARIANT_KEY uses the same color/size vocabulary as the rest of the
// codebase: the Arabic color name already used by inventory/orders (see
// lib/catalog.js colorNameAr, api/inventory.js) plus the size string.
// CJ identifiers are internal only — see lib/fulfillment-status.js and the
// customer-safe serializer for where the boundary is enforced; nothing here
// is ever exported to a customer-facing API.

export const AJLIB_VARIANT_KEYS = Object.freeze([
  'أسود-M', 'أسود-L', 'أسود-XL', 'أسود-XXL',
  'كحلي-M', 'كحلي-L', 'كحلي-XL', 'كحلي-XXL',
  'رمادي-M', 'رمادي-L', 'رمادي-XL', 'رمادي-XXL',
  'أبيض-M', 'أبيض-L', 'أبيض-XL', 'أبيض-XXL'
]);

export const CJ_PRODUCT_FAMILY_PID = 'CJYD1589152';

// {
//   ajlibKey: 'أسود-L',
//   color: 'أسود', size: 'L',
//   cjVariantId: '<raw CJ vid>',
//   cjVariantSku: '<raw CJ variantSku>',
//   cjRawColor: '<raw CJ color name>',   // documented as returned, unnormalized
//   cjRawSize: '<raw CJ size name>',
//   pid: CJ_PRODUCT_FAMILY_PID
// }
export const CJ_VARIANT_MAP = Object.freeze([]);

export const isFullyMapped = () => {
  const mappedKeys = new Set(CJ_VARIANT_MAP.map(v => v.ajlibKey));
  return AJLIB_VARIANT_KEYS.every(key => mappedKeys.has(key));
};

export const missingVariants = () => {
  const mappedKeys = new Set(CJ_VARIANT_MAP.map(v => v.ajlibKey));
  return AJLIB_VARIANT_KEYS.filter(key => !mappedKeys.has(key));
};

export const cjVariantFor = (ajlibKey) => CJ_VARIANT_MAP.find(v => v.ajlibKey === ajlibKey) || null;
