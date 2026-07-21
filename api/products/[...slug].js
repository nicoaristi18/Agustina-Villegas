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

    // === HELPERS PARA COMPRA ===
    // Auto-seed del producto runner-principiantes si no existe.
    async function ensureProduct(slug) {
      let product = await getProductBySlug(slug);
      if (!product && slug === 'runner-principiantes') {
        const now = new Date().toISOString();
        product = {
          id: 'runner-principiantes', slug: 'runner-principiantes', category: 'runners',
          title: 'Plan de Nutrición para Runners Principiantes',
          tagline: 'Tu guía completa para comenzar a correr sin frustrarte por la comida.',
          price: 1500, currency: 'UYU', active: true, pdfData: {},
          createdAt: now, updatedAt: now
        };
        const arr = await getProducts();
        arr.push(product);
        await saveProducts(arr);
      }
      return product;
    }

    // Registra la compra en KV + genera token + manda email de entrega.
    // Idempotente por paymentId (si ya se procesó, no reenvía).
    async function finalizePurchase({ product, name, email, source, paymentId }) {
      const purchases = await getGuidePurchases();
      if (paymentId) {
        const already = purchases.find(p => p.paymentId === String(paymentId));
        if (already) return { ok: true, purchaseId: already.id, alreadyProcessed: true };
      }
      const now = new Date().toISOString();
      const purchaseId = 'pur_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const token = generateGuideDownloadToken({ slug: product.slug, email });
      purchases.unshift({ id: purchaseId, slug: product.slug, name, email, ts: now, source, paymentId: paymentId || null });
      if (purchases.length > 500) purchases.length = 500;
      await saveGuidePurchases(purchases);

      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const downloadUrl = `${proto}://${host}/descarga-guia.html?token=${encodeURIComponent(token)}`;

      const emailResult = await sendGuideDeliveryEmail({
        name, email, downloadUrl, productTitle: product.title
      });
      if (!emailResult.ok) console.error('[finalizePurchase] email fail', emailResult.error);
      return { ok: true, purchaseId, emailSent: emailResult.ok, downloadUrl };
    }

    // === MERCADOPAGO CHECKOUT ===
    // POST /api/products/checkout  body { name, email, slug }
    // Crea preferencia MP y devuelve init_point para redirect.
    if (path === 'checkout' && method === 'POST') {
      const body = await readJsonBody(req) || {};
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const slug = String(body.slug || 'runner-principiantes').trim();
      if (!name || !email) return res.status(400).json({ error: 'Faltan name/email' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });

      const product = await ensureProduct(slug);
      if (!product || !product.active) return res.status(404).json({ error: 'Producto no encontrado' });

      const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
      const IS_TEST = process.env.MP_TEST === 'true';
      const SITE_URL = (process.env.SITE_URL || 'https://nutricionistaagustinavillegas.com').replace(/\/$/, '');
      if (!MP_TOKEN) return res.status(500).json({ error: 'MercadoPago no configurado' });

      const price = Number(product.price) || 0;
      if (price <= 0) return res.status(400).json({ error: 'Precio del producto inválido' });

      const externalRef = JSON.stringify({ type: 'guide', slug: product.slug, email, name });

      const preference = {
        items: [{
          id: 'guide_' + product.slug,
          title: product.title,
          description: product.tagline || 'Guía digital descargable en PDF',
          quantity: 1,
          unit_price: price,
          currency_id: product.currency || 'UYU'
        }],
        payer: { name, email },
        back_urls: {
          success: `${SITE_URL}/comprado.html`,
          failure: `${SITE_URL}/comprado.html`,
          pending: `${SITE_URL}/comprado.html`
        },
        auto_return: 'approved',
        external_reference: externalRef,
        statement_descriptor: 'Agustina Villegas',
        expires: true,
        expiration_date_to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] }
      };

      const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MP_TOKEN}` },
        body: JSON.stringify(preference)
      });
      const data = await mpRes.json();
      if (!mpRes.ok) {
        console.error('[products/checkout] MP error:', data);
        return res.status(mpRes.status).json({ error: data.message || 'Error en MercadoPago', detail: data });
      }
      const initPoint = IS_TEST ? data.sandbox_init_point : data.init_point;
      return res.status(200).json({ id: data.id, init_point: initPoint });
    }

    // GET /api/products/confirm?payment_id=xxx
    // Consulta el pago en MP y si está aprobado registra la compra + manda email.
    if (path === 'confirm' && method === 'GET') {
      const paymentId = req.query.payment_id;
      if (!paymentId) return res.status(400).json({ error: 'Falta payment_id' });

      const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
      if (!MP_TOKEN) return res.status(500).json({ error: 'MercadoPago no configurado' });

      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Bearer ${MP_TOKEN}` }
      });
      const payment = await mpRes.json();
      if (!mpRes.ok) return res.status(502).json({ error: 'Error consultando MercadoPago', detail: payment });
      if (payment.status !== 'approved') {
        return res.status(200).json({ status: payment.status, status_detail: payment.status_detail, message: `Pago en estado: ${payment.status}` });
      }

      let ref;
      try { ref = JSON.parse(payment.external_reference || '{}'); }
      catch { return res.status(400).json({ error: 'external_reference inválido' }); }
      if (ref.type !== 'guide' || !ref.slug || !ref.email) {
        return res.status(400).json({ error: 'El pago no corresponde a una guía' });
      }

      const product = await ensureProduct(ref.slug);
      if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

      const result = await finalizePurchase({
        product, name: ref.name || 'Runner', email: ref.email,
        source: 'mercadopago', paymentId: String(paymentId)
      });

      return res.status(200).json({
        status: 'approved',
        purchaseId: result.purchaseId,
        emailSent: result.emailSent,
        alreadyProcessed: !!result.alreadyProcessed
      });
    }

    // === PURCHASE DIRECTA (sin pago — para tests o entrega manual futura) ===
    // POST /api/products/purchase  body { name, email, slug }
    if (path === 'purchase' && method === 'POST') {
      const body = await readJsonBody(req) || {};
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const slug = String(body.slug || 'runner-principiantes').trim();
      if (!name || !email) return res.status(400).json({ error: 'Faltan name/email' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });

      const product = await ensureProduct(slug);
      if (!product || !product.active) return res.status(404).json({ error: 'Producto no encontrado' });

      const result = await finalizePurchase({ product, name, email, source: 'direct', paymentId: null });
      return res.status(200).json(result);
    }

    // GET /api/products/download?token=xxx
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
