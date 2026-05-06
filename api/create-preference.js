// Vercel serverless function — crea preferencia de MercadoPago
// Node.js 18+ tiene fetch nativo, no necesita npm

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const IS_TEST  = process.env.MP_TEST === 'true';
  const SITE_URL = (process.env.SITE_URL || 'https://nutricionistaagustinavillegas.com').replace(/\/$/, '');

  if (!MP_TOKEN) return res.status(500).json({ error: 'MP_ACCESS_TOKEN no configurado' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Body inválido' }); }

  const { title, amount, name, email, bookingRef } = body || {};
  if (!title || !amount || !name || !email) {
    return res.status(400).json({ error: 'Faltan campos: title, amount, name, email' });
  }

  const preference = {
    items: [{
      id: bookingRef || 'turno',
      title: title,
      quantity: 1,
      unit_price: parseFloat(amount),
      currency_id: 'UYU'
    }],
    payer: { name, email },
    back_urls: {
      success: `${SITE_URL}/reservar?payment=success`,
      failure: `${SITE_URL}/reservar?payment=failure`,
      pending: `${SITE_URL}/reservar?payment=pending`
    },
    auto_return: 'approved',
    external_reference: bookingRef || new Date().toISOString(),
    statement_descriptor: 'Agustina Villegas',
    expires: true,
    expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  };

  try {
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
      console.error('MP error:', JSON.stringify(data));
      return res.status(mpRes.status).json({ error: data.message || 'Error en MercadoPago', detail: data });
    }

    // En modo test usamos sandbox_init_point, en producción init_point
    const checkoutUrl = IS_TEST ? data.sandbox_init_point : data.init_point;

    return res.status(200).json({
      id: data.id,
      init_point: checkoutUrl,
      sandbox_init_point: data.sandbox_init_point,
      production_init_point: data.init_point
    });

  } catch (err) {
    console.error('Fetch error:', err);
    return res.status(500).json({ error: err.message });
  }
}
