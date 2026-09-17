import { PRODUCTS } from '../lib/catalog.js';

// Read-only, public catalog feed. Additive only: nothing currently reads this
// (index.html still renders its own inline builder) — it exists so a second
// product, or the mobile app, can consume one shared definition instead of
// duplicating product copy/variants in multiple frontends.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  return res.status(200).json({ products: PRODUCTS.filter(p => p.active) });
}
