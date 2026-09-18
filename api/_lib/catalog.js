// Scalable product/variant data model shared by the website and any future
// consumer (the Expo app already fetches /api/inventory directly; this file
// gives that same shape a home so a second product can be added without a
// redesign). Nothing here changes what's rendered today — index.html keeps
// its own inline builder — this is the foundation for api/catalog.js and
// whatever the storefront/app migrate onto next.

export const COLORS = Object.freeze([
  { code: 'black', name_ar: 'أسود', name_en: 'Black', hex: '#1c1c1c' },
  { code: 'navy', name_ar: 'كحلي', name_en: 'Navy', hex: '#1f2a44' },
  { code: 'gray', name_ar: 'رمادي', name_en: 'Gray', hex: '#8a8a86' },
  { code: 'white', name_ar: 'أبيض', name_en: 'White', hex: '#f2efe6' }
]);

export const SIZES = Object.freeze(['M', 'L', 'XL', 'XXL']);

// Inventory/orders store the Arabic color name as the canonical key today
// (see api/inventory.js, api/checkout-session.js item grouping) — this map
// keeps the English catalog code in sync with that existing key instead of
// introducing a second, competing identifier.
export const colorNameAr = (code) => COLORS.find(c => c.code === code)?.name_ar || code;
export const colorCodeFromNameAr = (nameAr) => COLORS.find(c => c.name_ar === nameAr)?.code || nameAr;

export const PRODUCTS = Object.freeze([
  {
    sku: 'ajlib-ice-silk-boxer-briefs',
    name_ar: 'ملابس داخلية بوكسر AJLIB آيس سيلك',
    name_en: 'AJLIB Ice Silk Long Boxer Briefs',
    description_ar: 'خامة مريحة وقابلة للتنفس، خياطة متينة للاستخدام اليومي.',
    description_en: 'Breathable ice-silk fabric with durable stitching for everyday wear.',
    features_ar: ['قماش ناعم وخفيف', 'قابل للتنفس طوال اليوم', 'خياطة قوية تتحمل الغسل المتكرر'],
    features_en: ['Soft, lightweight fabric', 'Breathable all-day comfort', 'Reinforced stitching for repeated washing'],
    images: ['images/products/boxer-black.jpg', 'images/products/boxer-navy.jpg', 'images/products/boxer-gray.jpg', 'images/products/boxer-white.jpg'],
    colors: COLORS.map(c => c.code),
    sizes: [...SIZES],
    active: true
  }
]);

export const getProduct = (sku) => PRODUCTS.find(p => p.sku === sku) || null;

export const allVariants = (sku) => {
  const product = getProduct(sku);
  if (!product) return [];
  return product.colors.flatMap(color => product.sizes.map(size => ({ sku: product.sku, color, size })));
};
