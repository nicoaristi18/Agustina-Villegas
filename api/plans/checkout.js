// POST /api/plans/checkout
// Crea una preferencia de MercadoPago para el pendingPlan del usuario logueado.
// Lee precio y créditos desde KV (no del request) → el cliente no puede manipular precios.

import { getUserFromRequest, getUserByEmail, readJsonBody } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = getUserFromRequest(req);
  if (!session?.email) return res.status(401).json({ error: 'No autenticado' });

  try {
    const user = await getUserByEmail(session.email);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!user.pendingPlan?.name) return res.status(400).json({ error: 'No tenés un plan pendiente para pagar' });

    const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
    const IS_TEST  = process.env.MP_TEST === 'true';
    const SITE_URL = (process.env.SITE_URL || 'https://nutricionistaagustinavillegas.com').replace(/\/$/, '');
    if (!MP_TOKEN) return res.status(500).json({ error: 'MercadoPago no configurado (falta MP_ACCESS_TOKEN)' });

    const plan = user.pendingPlan;
    const price = Number(plan.price) || 0;
    if (price <= 0) return res.status(400).json({ error: 'Precio del plan inválido' });

    // external_reference: JSON con info para el callback /api/plans/confirm
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
      payment_methods: {
        excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }]
      }
    };

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_TOKEN}`
      },
      body: JSON.stringify(preference)
    });
    const data = await mpRes.json();
    if (!mpRes.ok) {
      console.error('[plans/checkout] MP error:', data);
      return res.status(mpRes.status).json({ error: data.message || 'Error en MercadoPago', detail: data });
    }

    const checkoutUrl = IS_TEST ? data.sandbox_init_point : data.init_point;
    return res.status(200).json({ id: data.id, init_point: checkoutUrl });
  } catch (err) {
    console.error('[plans/checkout]', err);
    return res.status(500).json({ error: err.message });
  }
}
