// Catch-all dispatcher para /api/plans/*
// Maneja /api/plans/checkout (POST) y /api/plans/confirm (GET).

import {
  getUserFromRequest, getUserByEmail, getUsers, saveUsers, scrubUser,
  getProductBySlug, getGuidePurchases, saveGuidePurchases,
  generateGuideDownloadToken, sendGuideDeliveryEmail
} from '../../lib/auth.js';

// Cualquier plan cuyo nombre empiece así es un combo "guía + algo" (ver
// botones en runners.html) — además de activar los créditos, se entrega
// la guía por mail. Prefijo, no nombre exacto, para no tocar este archivo
// cada vez que se agregue un combo nuevo.
const COMBO_GUIDE_PREFIX = 'Guía + ';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  let path = '';
  const slug = req.query?.slug;
  if (slug) {
    path = Array.isArray(slug) ? slug.join('/') : String(slug);
  } else if (req.url) {
    const u = new URL(req.url, 'http://x');
    path = u.pathname.replace(/^\/api\/plans\/?/, '').replace(/\/$/, '');
  }
  console.log('[plans dispatcher]', req.method, 'path:', path, 'slug:', slug);

  try {
    if (path === 'checkout' && req.method === 'POST') return await handleCheckout(req, res);
    if (path === 'confirm'  && req.method === 'GET')  return await handleConfirm(req, res);
    return res.status(404).json({ error: 'Endpoint no encontrado', path, method: req.method, slug, url: req.url });
  } catch (err) {
    console.error('[plans dispatcher]', path, err);
    return res.status(500).json({ error: 'Error de servidor' });
  }
}

async function handleCheckout(req, res) {
  const session = getUserFromRequest(req);
  if (!session?.email) return res.status(401).json({ error: 'No autenticado' });

  const user = await getUserByEmail(session.email);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (!user.pendingPlan?.name) return res.status(400).json({ error: 'No tenés un plan pendiente para pagar' });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const IS_TEST  = process.env.MP_TEST === 'true';
  const SITE_URL = (process.env.SITE_URL || 'https://nutricionistaagustinavillegas.com').replace(/\/$/, '');
  if (!MP_TOKEN) return res.status(500).json({ error: 'MercadoPago no configurado' });

  const plan = user.pendingPlan;
  const price = Number(plan.price) || 0;
  if (price <= 0) return res.status(400).json({ error: 'Precio del plan inválido' });

  const externalRef = JSON.stringify({
    type: 'plan',
    email: user.email,
    plan: plan.name,
    credits: Number(plan.credits) || 0,
    price: price
  });

  const preference = {
    items: [{
      id: 'plan_' + String(plan.name).replace(/\s+/g, '_').toLowerCase(),
      title: `${plan.name} — ${plan.credits} consultas`,
      quantity: 1,
      unit_price: price,
      currency_id: 'UYU'
    }],
    payer: { name: user.name, email: user.email },
    back_urls: {
      success: `${SITE_URL}/mi-cuenta?plan_payment=success`,
      failure: `${SITE_URL}/mi-cuenta?plan_payment=failure`,
      pending: `${SITE_URL}/mi-cuenta?plan_payment=pending`
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
    console.error('[plans/checkout] MP error:', data);
    return res.status(mpRes.status).json({ error: data.message || 'Error en MercadoPago', detail: data });
  }
  const checkoutUrl = IS_TEST ? data.sandbox_init_point : data.init_point;
  return res.status(200).json({ id: data.id, init_point: checkoutUrl });
}

async function handleConfirm(req, res) {
  const session = getUserFromRequest(req);
  if (!session?.email) return res.status(401).json({ error: 'No autenticado' });

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
  if (ref.type !== 'plan') return res.status(400).json({ error: 'El pago no es de un plan' });
  if (String(ref.email).toLowerCase() !== String(session.email).toLowerCase()) {
    return res.status(403).json({ error: 'El pago no corresponde a tu cuenta' });
  }

  const users = await getUsers();
  const user = users[ref.email];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  user.paidPayments = user.paidPayments || [];
  if (user.paidPayments.includes(String(paymentId))) {
    return res.status(200).json({ status: 'already_processed', user: scrubUser(user) });
  }
  const creditsToAdd = Number(ref.credits) || 0;
  user.credits = (user.credits || 0) + creditsToAdd;
  user.plan = ref.plan;
  user.pendingPlan = null;
  user.paidPayments.push(String(paymentId));
  await saveUsers(users);

  // Combo guía + plan: además de los créditos, entregar la guía por mail.
  let guideDelivered = false;
  if (String(ref.plan || '').startsWith(COMBO_GUIDE_PREFIX)) {
    try {
      const product = await getProductBySlug('runner-principiantes');
      if (product) {
        const purchases = await getGuidePurchases();
        const purchaseId = 'pur_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const token = generateGuideDownloadToken({ slug: product.slug, email: user.email });
        purchases.unshift({
          id: purchaseId, slug: product.slug, name: user.name, email: user.email,
          ts: new Date().toISOString(), source: 'combo:plan', paymentId: String(paymentId)
        });
        if (purchases.length > 500) purchases.length = 500;
        await saveGuidePurchases(purchases);

        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const downloadUrl = `${proto}://${host}/descarga-guia.html?token=${encodeURIComponent(token)}`;
        const emailResult = await sendGuideDeliveryEmail({
          name: user.name, email: user.email, downloadUrl, productTitle: product.title
        });
        guideDelivered = !!emailResult.ok;
      }
    } catch (err) {
      console.error('[plans/confirm] no se pudo entregar la guía del combo', err);
    }
  }

  return res.status(200).json({ status: 'activated', added_credits: creditsToAdd, guideDelivered, user: scrubUser(user) });
}
