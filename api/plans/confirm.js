// GET /api/plans/confirm?payment_id=XXX
// Verifica con MP que el pago fue aprobado y activa créditos en KV.
// Idempotente: no duplica créditos si se llama 2 veces con el mismo payment_id.

import { getUserFromRequest, getUsers, saveUsers, scrubUser } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = getUserFromRequest(req);
  if (!session?.email) return res.status(401).json({ error: 'No autenticado' });

  const paymentId = req.query.payment_id;
  if (!paymentId) return res.status(400).json({ error: 'Falta payment_id' });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) return res.status(500).json({ error: 'MercadoPago no configurado' });

  try {
    // 1. Consultar el pago en MP
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` }
    });
    const payment = await mpRes.json();
    if (!mpRes.ok) {
      console.error('[plans/confirm] MP error:', payment);
      return res.status(502).json({ error: 'Error consultando MercadoPago', detail: payment });
    }

    // 2. Solo procesamos pagos aprobados
    if (payment.status !== 'approved') {
      return res.status(200).json({
        status: payment.status,
        status_detail: payment.status_detail,
        message: `Pago en estado: ${payment.status}`
      });
    }

    // 3. Parsear external_reference
    let ref;
    try { ref = JSON.parse(payment.external_reference || '{}'); }
    catch { return res.status(400).json({ error: 'external_reference inválido' }); }
    if (ref.type !== 'plan') return res.status(400).json({ error: 'El pago no es de un plan' });

    // 4. Seguridad: el pago debe corresponder al usuario logueado
    if (String(ref.email).toLowerCase() !== String(session.email).toLowerCase()) {
      return res.status(403).json({ error: 'El pago no corresponde a tu cuenta' });
    }

    // 5. Activar créditos (idempotente)
    const users = await getUsers();
    const user = users[ref.email];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    user.paidPayments = user.paidPayments || [];
    if (user.paidPayments.includes(String(paymentId))) {
      // Ya procesado — devolvemos el estado actual sin sumar créditos
      return res.status(200).json({
        status: 'already_processed',
        user: scrubUser(user)
      });
    }

    const creditsToAdd = Number(ref.credits) || 0;
    user.credits = (user.credits || 0) + creditsToAdd;
    user.plan = ref.plan;
    user.pendingPlan = null;
    user.paidPayments.push(String(paymentId));
    await saveUsers(users);

    return res.status(200).json({
      status: 'activated',
      added_credits: creditsToAdd,
      user: scrubUser(user)
    });
  } catch (err) {
    console.error('[plans/confirm]', err);
    return res.status(500).json({ error: err.message });
  }
}
