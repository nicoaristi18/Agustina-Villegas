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
  getGuidePurchases, verifyGuideDownloadToken,
  getCoupons, applyCoupon
} from '../../lib/auth.js';
import { createPaypalOrder, capturePaypalOrder } from '../../lib/paypal.js';
import {
  siteUrl, fetchMpPayment, listMpGuidePayments, deliverGuide, deliverGuideFromMpPayment
} from '../../lib/guide-sales.js';
import { getPrices, guidePrice } from '../../lib/pricing.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  let path = '';
  // __p viene de la reescritura de vercel.json (rutas de 2+ niveles)
  const slug = req.query?.__p || req.query?.slug;
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
      const pub = scrubProductForPublic(product);
      if (pub.slug === 'runner-principiantes') pub.price = await guidePrice(pub.price);
      return res.status(200).json({ product: pub });
    }

    if (path.startsWith('by-category/') && method === 'GET') {
      const category = path.replace('by-category/', '');
      const products = await getProducts();
      const filtered = products.filter(p => p.active && p.category === category).map(scrubProductForPublic);
      return res.status(200).json({ products: filtered });
    }

    // GET /api/products/prices → precios vigentes (públicos) del catálogo
    if (path === 'prices' && method === 'GET') {
      return res.status(200).json({ prices: await getPrices() });
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

    // Registra la compra + manda el email de entrega (ver lib/guide-sales.js).
    // Idempotente por paymentId; el uso del cupón se cuenta adentro.
    async function finalizePurchase({ product, name, email, source, paymentId, coupon, amount, currency }) {
      return deliverGuide({
        slug: product.slug, name, email, source, paymentId,
        coupon: coupon || null, amount: amount ?? null, currency: currency || product.currency || 'UYU'
      });
    }

    // === VALIDAR CUPÓN ===
    // POST /api/products/validate-coupon  body { code, slug }
    if (path === 'validate-coupon' && method === 'POST') {
      const body = await readJsonBody(req) || {};
      const code = String(body.code || '').trim().toUpperCase();
      const slug = String(body.slug || 'runner-principiantes').trim();
      if (!code) return res.status(400).json({ error: 'Falta code' });
      const product = await ensureProduct(slug);
      if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
      const basePrice = product.slug === 'runner-principiantes' ? await guidePrice(product.price) : (Number(product.price) || 0);
      const all = await getCoupons();
      const coupon = all[code];
      const result = applyCoupon(coupon, basePrice);
      if (!result.ok) return res.status(200).json({ valid: false, error: result.error });
      return res.status(200).json({
        valid: true,
        code,
        type: coupon.type,
        basePrice,
        finalPrice: result.finalPrice,
        discountAmount: result.discountAmount,
        isFree: result.finalPrice === 0
      });
    }

    // === MERCADOPAGO CHECKOUT ===
    // POST /api/products/checkout  body { name, email, slug, couponCode? }
    // Crea preferencia MP y devuelve init_point. Si el cupón es 'free' (100% off),
    // salta MP y entrega el producto directo por email.
    if (path === 'checkout' && method === 'POST') {
      const body = await readJsonBody(req) || {};
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const slug = String(body.slug || 'runner-principiantes').trim();
      const couponCode = body.couponCode ? String(body.couponCode).trim().toUpperCase() : '';
      if (!name || !email) return res.status(400).json({ error: 'Faltan name/email' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });

      const product = await ensureProduct(slug);
      if (!product || !product.active) return res.status(404).json({ error: 'Producto no encontrado' });

      const basePrice = product.slug === 'runner-principiantes' ? await guidePrice(product.price) : (Number(product.price) || 0);
      if (basePrice <= 0) return res.status(400).json({ error: 'Precio del producto inválido' });

      // Validar cupón si se envió
      let finalPrice = basePrice;
      let appliedCoupon = null;
      if (couponCode) {
        const all = await getCoupons();
        const coupon = all[couponCode];
        const cResult = applyCoupon(coupon, basePrice);
        if (!cResult.ok) return res.status(400).json({ error: 'Cupón inválido: ' + cResult.error });
        finalPrice = cResult.finalPrice;
        appliedCoupon = couponCode;
      }

      // Cupón 100% descuento → entregar directamente sin pasar por MP
      if (finalPrice === 0) {
        const result = await finalizePurchase({
          product, name, email, source: 'coupon:' + couponCode, paymentId: null, coupon: appliedCoupon, amount: 0
        });
        return res.status(200).json({ freeCoupon: true, ...result });
      }

      const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
      const IS_TEST = process.env.MP_TEST === 'true';
      const SITE_URL = siteUrl();
      if (!MP_TOKEN) return res.status(500).json({ error: 'MercadoPago no configurado' });

      const externalRef = JSON.stringify({
        type: 'guide', slug: product.slug, email, name,
        coupon: appliedCoupon
      });

      const preference = {
        items: [{
          id: 'guide_' + product.slug,
          title: product.title + (appliedCoupon ? ' (cupón ' + appliedCoupon + ')' : ''),
          description: product.tagline || 'Guía digital descargable en PDF',
          quantity: 1,
          unit_price: finalPrice,
          currency_id: product.currency || 'UYU'
        }],
        payer: { name, email },
        back_urls: {
          success: `${SITE_URL}/comprado.html`,
          failure: `${SITE_URL}/comprado.html`,
          pending: `${SITE_URL}/comprado.html`
        },
        auto_return: 'approved',
        // Sin esto la entrega dependía de que el comprador volviera a comprado.html.
        notification_url: `${SITE_URL}/api/products/webhook?source_news=webhooks`,
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
      return res.status(200).json({ id: data.id, init_point: initPoint, finalPrice, basePrice, discount: basePrice - finalPrice });
    }

    // POST /api/products/checkout-paypal  body { name, email, slug, couponCode }
    // Crea una orden de PayPal (alternativa a Mercado Pago para tarjetas del exterior).
    if (path === 'checkout-paypal' && method === 'POST') {
      const body = await readJsonBody(req) || {};
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const slug = String(body.slug || 'runner-principiantes').trim();
      const couponCode = body.couponCode ? String(body.couponCode).trim().toUpperCase() : '';
      if (!name || !email) return res.status(400).json({ error: 'Faltan name/email' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });

      const product = await ensureProduct(slug);
      if (!product || !product.active) return res.status(404).json({ error: 'Producto no encontrado' });

      const basePrice = product.slug === 'runner-principiantes' ? await guidePrice(product.price) : (Number(product.price) || 0);
      if (basePrice <= 0) return res.status(400).json({ error: 'Precio del producto inválido' });

      let finalPrice = basePrice;
      let appliedCoupon = null;
      if (couponCode) {
        const all = await getCoupons();
        const coupon = all[couponCode];
        const cResult = applyCoupon(coupon, basePrice);
        if (!cResult.ok) return res.status(400).json({ error: 'Cupón inválido: ' + cResult.error });
        finalPrice = cResult.finalPrice;
        appliedCoupon = couponCode;
      }

      if (finalPrice === 0) {
        const result = await finalizePurchase({ product, name, email, source: 'coupon:' + couponCode, paymentId: null, coupon: appliedCoupon, amount: 0 });
        return res.status(200).json({ freeCoupon: true, ...result });
      }

      try {
        const referenceId = JSON.stringify({ type: 'guide', slug: product.slug, email, name, coupon: appliedCoupon }).slice(0, 255);
        const { orderId, amountUsd } = await createPaypalOrder({
          amountUyu: finalPrice,
          description: product.title,
          referenceId
        });
        return res.status(200).json({ orderId, amountUsd });
      } catch (err) {
        console.error('[products/checkout-paypal]', err);
        return res.status(500).json({ error: err.message });
      }
    }

    // POST /api/products/capture-paypal  body { orderId }
    // Captura el pago de PayPal y entrega la guía (misma lógica que confirm, vía finalizePurchase).
    if (path === 'capture-paypal' && method === 'POST') {
      const body = await readJsonBody(req) || {};
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return res.status(400).json({ error: 'Falta orderId' });

      try {
        const capture = await capturePaypalOrder(orderId);
        if (capture.status !== 'COMPLETED') {
          return res.status(200).json({ status: capture.status, message: `Pago en estado: ${capture.status}` });
        }
        const unit = capture.purchase_units?.[0];
        let ref = {};
        try { ref = JSON.parse(unit?.reference_id || '{}'); } catch {}
        if (ref.type !== 'guide' || !ref.slug || !ref.email) {
          return res.status(400).json({ error: 'reference_id inválido' });
        }
        const product = await ensureProduct(ref.slug);
        if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

        const captureId = unit?.payments?.captures?.[0]?.id || orderId;
        const capAmount = unit?.payments?.captures?.[0]?.amount;
        const result = await finalizePurchase({
          product, name: ref.name || 'Runner', email: ref.email,
          source: 'paypal', paymentId: 'pp_' + captureId, coupon: ref.coupon,
          amount: Number(capAmount?.value) || null, currency: capAmount?.currency_code || 'USD'
        });
        return res.status(200).json({
          status: 'approved',
          purchaseId: result.purchaseId,
          emailSent: result.emailSent,
          alreadyProcessed: !!result.alreadyProcessed,
          amount: Number(unit?.payments?.captures?.[0]?.amount?.value) || 0,
          currency: unit?.payments?.captures?.[0]?.amount?.currency_code || 'USD',
          productName: product.title
        });
      } catch (err) {
        console.error('[products/capture-paypal]', err);
        return res.status(500).json({ error: err.message });
      }
    }

    // GET /api/products/confirm?payment_id=xxx
    // Consulta el pago en MP y si está aprobado registra la compra + manda email.
    if (path === 'confirm' && method === 'GET') {
      const paymentId = req.query.payment_id;
      if (!paymentId) return res.status(400).json({ error: 'Falta payment_id' });

      let payment;
      try { payment = await fetchMpPayment(paymentId); }
      catch (err) { return res.status(502).json({ error: 'Error consultando MercadoPago', detail: err.message }); }
      if (payment.status !== 'approved') {
        return res.status(200).json({ status: payment.status, status_detail: payment.status_detail, message: `Pago en estado: ${payment.status}` });
      }

      const result = await deliverGuideFromMpPayment(payment, { source: 'mercadopago' });
      if (result.notGuide) return res.status(400).json({ error: 'El pago no corresponde a una guía' });
      const product = await ensureProduct(result.ref.slug);

      return res.status(200).json({
        status: 'approved',
        purchaseId: result.purchaseId,
        emailSent: result.emailSent,
        alreadyProcessed: !!result.alreadyProcessed,
        amount: Number(payment.transaction_amount) || Number(product?.price) || 0,
        currency: payment.currency_id || product?.currency || 'UYU',
        productName: product?.title || result.ref.slug
      });
    }

    // POST|GET /api/products/webhook — notificación de MercadoPago.
    // No se confía en el body: se re-consulta el pago en MP con nuestro token.
    if (path === 'webhook' && (method === 'POST' || method === 'GET')) {
      let body = null;
      if (method === 'POST') { try { body = await readJsonBody(req); } catch {} }
      const topic = req.query.topic || req.query.type || body?.type || body?.topic;
      const paymentId = req.query['data.id'] || body?.data?.id || (topic === 'payment' ? req.query.id : null);
      console.log('[products/webhook] topic:', topic, 'paymentId:', paymentId);
      if (!paymentId || (topic && topic !== 'payment')) {
        return res.status(200).json({ ok: true, message: 'Notif ignorada' });
      }
      try {
        const payment = await fetchMpPayment(paymentId);
        const r = await deliverGuideFromMpPayment(payment, { source: 'mercadopago:webhook' });
        console.log('[products/webhook] resultado', paymentId, JSON.stringify(r));
        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error('[products/webhook]', paymentId, err);
        // 500 → MP reintenta más tarde (útil si KV/Resend estaban caídos).
        return res.status(500).json({ error: err.message });
      }
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

      // GET /api/products/admin/purchases → lista de compras de guías
      // (antes quedaba tapada por admin/:slug y nunca respondía)
      if (path === 'admin/purchases' && method === 'GET') {
        const purchases = await getGuidePurchases();
        return res.status(200).json({ purchases });
      }

      // GET /api/products/admin/sales?days=60 → ventas registradas + pagos de
      // guía en MP que NO tienen entrega registrada (los "perdidos").
      if (path === 'admin/sales' && method === 'GET') {
        const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 60));
        const purchases = await getGuidePurchases();
        let mpPayments = [];
        let mpError = null;
        try { mpPayments = await listMpGuidePayments(days); }
        catch (err) { mpError = err.message; }
        const byPaymentId = new Set(purchases.map(p => p.paymentId).filter(Boolean));
        const missing = mpPayments
          .filter(({ payment }) => !byPaymentId.has(String(payment.id)))
          .map(({ payment, ref }) => ({
            paymentId: String(payment.id),
            status: payment.status,
            statusDetail: payment.status_detail,
            ts: payment.date_approved || payment.date_created,
            name: ref.name || '',
            email: ref.email,
            slug: ref.slug,
            amount: Number(payment.transaction_amount) || 0,
            currency: payment.currency_id || 'UYU',
            payerEmail: payment.payer?.email || null
          }));
        return res.status(200).json({ purchases, missing, mpError, days });
      }

      // POST /api/products/admin/sales/send
      //   body { purchaseId } → reenvía una venta registrada
      //   body { paymentId }  → entrega un pago de MP (aunque no esté registrado)
      //   body { name, email } (sin ids) → venta manual (transferencia, etc.)
      //   opcional { toEmail } → mandar a otro email (si el comprador lo escribió mal)
      if (path === 'admin/sales/send' && method === 'POST') {
        const body = await readJsonBody(req) || {};
        const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const toEmail = body.toEmail ? String(body.toEmail).trim().toLowerCase() : null;
        if (toEmail && !EMAIL_RE.test(toEmail)) return res.status(400).json({ error: 'Email inválido' });

        if (body.paymentId) {
          const payment = await fetchMpPayment(String(body.paymentId));
          if (payment.status !== 'approved') return res.status(400).json({ error: 'El pago no está aprobado en MP (estado: ' + payment.status + ')' });
          const r = await deliverGuideFromMpPayment(payment, { source: 'mercadopago:admin', force: true, toEmail });
          if (r.notGuide) return res.status(400).json({ error: 'El pago no corresponde a una guía' });
          return res.status(200).json(r);
        }
        if (body.purchaseId) {
          const purchases = await getGuidePurchases();
          const rec = purchases.find(p => p.id === body.purchaseId);
          if (!rec) return res.status(404).json({ error: 'Venta no encontrada' });
          const r = await deliverGuide({ ...rec, purchaseId: rec.id, force: true, toEmail });
          return res.status(200).json(r);
        }
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Faltan nombre y email válidos' });
        const product = await ensureProduct(String(body.slug || 'runner-principiantes'));
        const r = await deliverGuide({
          slug: product.slug, name, email, source: 'manual',
          amount: Number(body.amount) || null, currency: product.currency || 'UYU'
        });
        return res.status(200).json(r);
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
