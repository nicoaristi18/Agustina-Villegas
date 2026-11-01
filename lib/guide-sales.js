// Ventas de guías digitales: entrega por email, webhook de MercadoPago y
// conciliación contra los pagos reales de MP.
//
// Antes la entrega dependía SOLO de que el comprador volviera a comprado.html
// después de pagar. Si pagaba desde la app de MP, cerraba la pestaña o el pago
// quedaba "en proceso", la guía nunca se mandaba. Ahora hay tres caminos que
// terminan en deliverGuide(), que es idempotente:
//   1. comprado.html → /api/products/confirm   (el comprador vuelve)
//   2. MP → /api/products/webhook               (notificación server-to-server)
//   3. cron diario + admin "Ventas guía"        (conciliación con pagos de MP)

import {
  getGuidePurchases, saveGuidePurchases, getProductBySlug,
  generateGuideDownloadToken, sendGuideDeliveryEmail, incrementCouponUse
} from './auth.js';
import { createOneTimeCoupon } from './coupons.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function upstash(...cmd) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV no configurado');
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

// URL pública del sitio. Siempre con www: vercel.json redirige el dominio sin
// www con un 308, y MercadoPago NO sigue redirects en las notificaciones.
export function siteUrl() {
  const raw = (process.env.SITE_URL || 'https://www.nutricionistaagustinavillegas.com').replace(/\/$/, '');
  return raw.replace('://nutricionistaagustinavillegas.com', '://www.nutricionistaagustinavillegas.com');
}

// external_reference de una guía: JSON { type:'guide', slug, email, name, coupon }
export function parseGuideRef(str) {
  if (!str || typeof str !== 'string' || str[0] !== '{') return null;
  try {
    const ref = JSON.parse(str);
    return ref && ref.type === 'guide' && ref.slug && ref.email ? ref : null;
  } catch { return null; }
}

export async function fetchMpPayment(paymentId) {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) throw new Error('MercadoPago no configurado');
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${MP_TOKEN}` }
  });
  const payment = await r.json();
  if (!r.ok) throw new Error('MP ' + r.status + ': ' + (payment.message || 'error consultando el pago'));
  return payment;
}

// Pagos de guías en MP de los últimos `days` días (cualquier estado).
export async function listMpGuidePayments(days = 60) {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) throw new Error('MercadoPago no configurado');
  const out = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const qs = new URLSearchParams({
      sort: 'date_created', criteria: 'desc', limit: '100', offset: String(offset),
      range: 'date_created', begin_date: `NOW-${days}DAYS`, end_date: 'NOW'
    });
    const r = await fetch('https://api.mercadopago.com/v1/payments/search?' + qs, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` }
    });
    const d = await r.json();
    if (!r.ok) throw new Error('MP search ' + r.status + ': ' + (d.message || ''));
    const results = d.results || [];
    for (const p of results) {
      const ref = parseGuideRef(p.external_reference);
      if (ref) out.push({ payment: p, ref });
    }
    if (results.length < 100) break;
  }
  return out;
}

// Lock corto en KV para que confirm y webhook (que pueden llegar a la vez)
// no manden dos emails por el mismo pago.
async function acquireLock(key) {
  const r = await upstash('SET', 'ag:lock:' + key, '1', 'NX', 'EX', 60);
  return r === 'OK';
}
async function releaseLock(key) {
  try { await upstash('DEL', 'ag:lock:' + key); } catch {}
}

// Registra la compra (si no existe) y manda el email con el link de descarga.
// - Idempotente por paymentId: si ya se entregó, no reenvía.
// - Si existe pero el email había fallado, lo reintenta.
// - force=true reenvía siempre (botón del admin). toEmail permite corregir el
//   destinatario si el comprador escribió mal su email.
export async function deliverGuide({
  slug, name, email, source, paymentId = null, amount = null, currency = null,
  coupon = null, force = false, purchaseId = null, toEmail = null
}) {
  const pid = paymentId ? String(paymentId) : null;
  const lockKey = 'guide:' + (pid || purchaseId || email);
  if (!(await acquireLock(lockKey))) {
    return { ok: true, inProgress: true };
  }
  try {
    const purchases = await getGuidePurchases();
    let rec = null;
    if (purchaseId) rec = purchases.find(p => p.id === purchaseId) || null;
    if (!rec && pid) rec = purchases.find(p => p.paymentId === pid) || null;

    // Registros viejos no tienen emailSent: se asume que sí salió.
    if (rec && rec.emailSent !== false && !force) {
      return { ok: true, purchaseId: rec.id, emailSent: true, alreadyProcessed: true };
    }

    const isNew = !rec;
    if (isNew) {
      rec = {
        id: 'pur_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        slug, name: name || 'Runner', email: String(email || '').toLowerCase(),
        ts: new Date().toISOString(), source, paymentId: pid,
        amount, currency, coupon: coupon || null,
        emailSent: false, sendCount: 0
      };
    }
    if (toEmail) rec.email = String(toEmail).trim().toLowerCase();

    const product = await getProductBySlug(rec.slug);
    const productTitle = product?.title || 'Guía para runners';

    // Regalo: cupón de 15% para un plan de seguimiento (uno por compra).
    if (!rec.giftCouponCode) {
      try {
        rec.giftCouponCode = await createOneTimeCoupon({ prefix: 'GUIA', type: 'percent', value: 15, expiresInDays: 30 });
      } catch (err) {
        console.error('[deliverGuide] no se pudo generar el cupón de regalo', err);
      }
    }

    const token = generateGuideDownloadToken({ slug: rec.slug, email: rec.email });
    const downloadUrl = `${siteUrl()}/descarga-guia.html?token=${encodeURIComponent(token)}`;
    const emailResult = await sendGuideDeliveryEmail({
      name: rec.name, email: rec.email, downloadUrl, productTitle, giftCouponCode: rec.giftCouponCode
    });

    rec.sendCount = (rec.sendCount || 0) + 1;
    rec.lastSendAt = new Date().toISOString();
    if (emailResult.ok) {
      rec.emailSent = true;
      rec.emailSentAt = rec.lastSendAt;
      rec.emailError = null;
    } else {
      rec.emailSent = rec.emailSent === true; // un reenvío fallido no borra un envío previo OK
      rec.emailError = emailResult.error || 'error desconocido';
      console.error('[deliverGuide] email fail', rec.id, rec.emailError);
    }

    // Re-leer antes de guardar para no pisar compras que entraron en paralelo.
    const fresh = await getGuidePurchases();
    const idx = fresh.findIndex(p => p.id === rec.id);
    if (idx >= 0) fresh[idx] = rec; else fresh.unshift(rec);
    if (fresh.length > 500) fresh.length = 500;
    await saveGuidePurchases(fresh);

    if (isNew && rec.coupon) {
      try { await incrementCouponUse(rec.coupon); } catch (e) { console.warn('[deliverGuide] coupon use', e); }
    }

    return {
      ok: true, purchaseId: rec.id, emailSent: emailResult.ok, emailError: emailResult.ok ? null : rec.emailError,
      alreadyProcessed: false, productTitle
    };
  } finally {
    await releaseLock(lockKey);
  }
}

// Procesa un pago de MP: si es de una guía y está aprobado, la entrega.
export async function deliverGuideFromMpPayment(payment, opts = {}) {
  const ref = parseGuideRef(payment?.external_reference);
  if (!ref) return { ok: false, notGuide: true };
  if (payment.status !== 'approved') return { ok: true, status: payment.status, delivered: false };
  const r = await deliverGuide({
    slug: ref.slug, name: ref.name, email: ref.email, coupon: ref.coupon,
    source: opts.source || 'mercadopago', paymentId: payment.id,
    amount: Number(payment.transaction_amount) || null, currency: payment.currency_id || 'UYU',
    force: !!opts.force, toEmail: opts.toEmail || null
  });
  return { ...r, status: 'approved', ref };
}

// Conciliación: cualquier pago aprobado de guía en MP que no tenga un envío OK
// registrado se entrega. La usa el cron diario.
export async function reconcileGuideSales(days = 30) {
  const mp = await listMpGuidePayments(days);
  const purchases = await getGuidePurchases();
  const delivered = new Set(purchases.filter(p => p.paymentId && p.emailSent !== false).map(p => p.paymentId));
  const results = [];
  for (const { payment } of mp) {
    if (payment.status !== 'approved' || delivered.has(String(payment.id))) continue;
    try {
      const r = await deliverGuideFromMpPayment(payment, { source: 'mercadopago:conciliacion' });
      results.push({ paymentId: payment.id, emailSent: r.emailSent, error: r.emailError || null });
    } catch (err) {
      results.push({ paymentId: payment.id, error: err.message });
    }
  }
  return results;
}
