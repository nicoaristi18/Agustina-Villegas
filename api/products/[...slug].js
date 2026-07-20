// Catch-all dispatcher para /api/products/*
//
// PÚBLICOS:
//   GET  /api/products                    → lista productos activos (sin pdfData)
//   GET  /api/products/by-slug/:slug      → un producto por slug (sin pdfData)
//   GET  /api/products/by-category/:cat   → productos activos de una categoría
//
// ADMIN (requieren cookie ag_admin):
//   GET  /api/products/admin               → lista completa (con pdfData, incluso inactivos)
//   GET  /api/products/admin/:slug         → un producto completo (con pdfData)
//   POST /api/products/admin               body { product } → crea o actualiza (upsert por slug)
//   DELETE /api/products/admin?slug=...    → elimina

import {
  getProducts, saveProducts, getProductBySlug, scrubProductForPublic,
  getAdminFromRequest, readJsonBody,
  getGuidePurchases, saveGuidePurchases,
  generateGuideDownloadToken, verifyGuideDownloadToken,
  sendGuideDeliveryEmail
} from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  let path = '';
  const slug = req.query?.slug;
  if (slug) {
    path = Array.isArray(slug) ? slug.join('/') : String(slug);
  } else if (req.url) {
    const u = new URL(req.url, 'http://x');
    path = u.pathname.replace(/^\/api\/products\/?/, '').replace(/\/$/, '');
  }
  const method = req.method;
  console.log('[products dispatcher]', method, 'path:', path);

  try {
    // === PUBLIC ===
    if (path === '' && method === 'GET') {
      const products = await getProducts();
      const active = products.filter(p => p.active).map(scrubProductForPublic);
      return res.status(200).json({ products: active });
    }

    if (path.startsWith('by-slug/') && method === 'GET') {
      const productSlug = path.replace('by-slug/', '');
      const product = await getProductBySlug(productSlug);
      if (!product || !product.active) return res.status(404).json({ error: 'Producto no encontrado' });
      return res.status(200).json({ product: scrubProductForPublic(product) });
    }

    if (path.startsWith('by-category/') && method === 'GET') {
      const category = path.replace('by-category/', '');
      const products = await getProducts();
      const filtered = products.filter(p => p.active && p.category === category).map(scrubProductForPublic);
      return res.status(200).json({ products: filtered });
    }

    // === SEED (one-shot, idempotente) ===
    // GET /api/products/seed → crea el producto runner-principiantes si no existe.
    // Es público a propósito porque solo agrega un producto base, no modifica nada existente.
    if (path === 'seed' && method === 'GET') {
      const products = await getProducts();
      const exists = products.find(p => p.slug === 'runner-principiantes');
      if (exists) return res.status(200).json({ status: 'already_seeded', product: scrubProductForPublic(exists) });
      const now = new Date().toISOString();
      const seed = {
        id: 'runner-principiantes',
        slug: 'runner-principiantes',
        category: 'runners',
        title: 'Plan de Nutrición para Runners Principiantes',
        tagline: 'Tu guía completa para comenzar a correr sin frustrarte por la comida. Aprendé qué comer antes, durante y después del entrenamiento, cómo prepararte para tu primera carrera y mejorar tu rendimiento.',
        price: 1500,
        currency: 'UYU',
        active: true,
        pdfData: { pages: [] }, // se llena desde el generador en Fase 2
        createdAt: now,
        updatedAt: now
      };
      products.push(seed);
      await saveProducts(products);
      return res.status(200).json({ status: 'seeded', product: scrubProductForPublic(seed) });
    }

    // === PUBLIC PURCHASE (sin MercadoPago por ahora) ===
    // POST /api/products/purchase  body { name, email, slug }
    // Crea registro de compra, genera token JWT, manda email con link de descarga.
    if (path === 'purchase' && method === 'POST') {
      const body = await readJsonBody(req) || {};
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const slug = String(body.slug || 'runner-principiantes').trim();
      if (!name || !email) return res.status(400).json({ error: 'Faltan name/email' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });

      let product = await getProductBySlug(slug);
      // Auto-seed si no existe (para que el flujo funcione sin depender de
      // que Agustina haya guardado desde el generador previamente).
      if (!product && slug === 'runner-principiantes') {
        const now = new Date().toISOString();
        product = {
          id: 'runner-principiantes',
          slug: 'runner-principiantes',
          category: 'runners',
          title: 'Plan de Nutrición para Runners Principiantes',
          tagline: 'Tu guía completa para comenzar a correr sin frustrarte por la comida.',
          price: 1500,
          currency: 'UYU',
          active: true,
          pdfData: {}, // sin guiaRunning aún — la página de descarga mostrará mensaje pidiendo que Agustina publique
          createdAt: now,
          updatedAt: now
        };
        const arr = await getProducts();
        arr.push(product);
        await saveProducts(arr);
      }
      if (!product || !product.active) return res.status(404).json({ error: 'Producto no encontrado' });

      const now = new Date().toISOString();
      const purchaseId = 'pur_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const token = generateGuideDownloadToken({ slug, email });

      // Guardar registro (para que Agustina vea las compras)
      const purchases = await getGuidePurchases();
      purchases.unshift({ id: purchaseId, slug, name, email, ts: now, source: 'web' });
      // Limitar a últimas 500 compras
      if (purchases.length > 500) purchases.length = 500;
      await saveGuidePurchases(purchases);

      // Armar URL absoluta
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const downloadUrl = `${proto}://${host}/descarga-guia.html?token=${encodeURIComponent(token)}`;

      // Enviar email (no bloquea si falla — dejamos el registro igual)
      const emailResult = await sendGuideDeliveryEmail({
        name, email, downloadUrl, productTitle: product.title
      });
      if (!emailResult.ok) {
        console.error('[purchase] email fail', emailResult.error);
        // Igual devolvemos ok=true porque la compra queda registrada.
        // Agustina puede reenviar manualmente.
      }

      return res.status(200).json({
        ok: true,
        purchaseId,
        emailSent: emailResult.ok,
        downloadUrl // para debug/desarrollo, útil en tests
      });
    }

    // GET /api/products/download?token=xxx
    // Valida token JWT y devuelve el producto completo (con pdfData) para renderizar.
    if (path === 'download' && method === 'GET') {
      const token = String(req.query.token || '');
      const payload = verifyGuideDownloadToken(token);
      if (!payload) return res.status(401).json({ error: 'Token inválido o expirado' });
      const product = await getProductBySlug(payload.slug);
      if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
      return res.status(200).json({ product, email: payload.email });
    }

    // === ADMIN ===
    if (path.startsWith('admin')) {
      const session = getAdminFromRequest(req);
      if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });

      // GET /api/products/admin → lista completa
      if (path === 'admin' && method === 'GET') {
        const products = await getProducts();
        return res.status(200).json({ products });
      }

      // GET /api/products/admin/:slug → producto completo
      if (path.startsWith('admin/') && method === 'GET') {
        const productSlug = path.replace('admin/', '');
        const product = await getProductBySlug(productSlug);
        if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
        return res.status(200).json({ product });
      }

      // POST /api/products/admin → upsert
      if (path === 'admin' && method === 'POST') {
        const body = await readJsonBody(req);
        if (!body?.product || !body.product.slug) return res.status(400).json({ error: 'Falta product.slug' });
        const products = await getProducts();
        const idx = products.findIndex(p => p.slug === body.product.slug);
        const now = new Date().toISOString();
        if (idx >= 0) {
          // update
          products[idx] = { ...products[idx], ...body.product, updatedAt: now };
        } else {
          // create
          products.push({
            ...body.product,
            id: body.product.id || body.product.slug,
            createdAt: now,
            updatedAt: now
          });
        }
        await saveProducts(products);
        return res.status(200).json({ product: products.find(p => p.slug === body.product.slug) });
      }

      // GET /api/products/admin/purchases → lista de compras de guías
      if (path === 'admin/purchases' && method === 'GET') {
        const purchases = await getGuidePurchases();
        return res.status(200).json({ purchases });
      }

      // DELETE /api/products/admin?slug=...
      if (path === 'admin' && method === 'DELETE') {
        const delSlug = String(req.query.deleteSlug || req.query.s || '').trim();
        if (!delSlug) return res.status(400).json({ error: 'Falta query ?deleteSlug=... o ?s=...' });
        const products = await getProducts();
        const next = products.filter(p => p.slug !== delSlug);
        if (next.length === products.length) return res.status(404).json({ error: 'Producto no encontrado' });
        await saveProducts(next);
        return res.status(200).json({ ok: true });
      }
    }

    return res.status(404).json({ error: 'Endpoint no encontrado', path, method });
  } catch (err) {
    console.error('[products dispatcher]', path, err);
    return res.status(500).json({ error: 'Error de servidor' });
  }
}
