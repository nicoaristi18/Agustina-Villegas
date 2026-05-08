// Vercel serverless: lectura/escritura compartida entre dispositivos vía Edge Config
// GET  /api/data?key=KEY        → devuelve { value }
// POST /api/data  body:{key,value} → guarda
// Solo claves whitelisted: agustina_blocked_slots, agustina_bookings_v2, agustina_users

const ALLOWED = new Set([
  'agustina_blocked_slots',
  'agustina_bookings_v2',
  'agustina_users',
  'agustina_content',
  'habito_orders',
  'agustina_prices'
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN  = process.env.VERCEL_API_TOKEN;
  const ECFG   = process.env.EDGE_CONFIG_ID;
  const TEAM   = process.env.VERCEL_TEAM_ID;
  if (!TOKEN || !ECFG) return res.status(500).json({ error: 'Backend no configurado' });

  const teamParam = TEAM ? `?teamId=${TEAM}` : '';

  // GET → leer un item del Edge Config
  if (req.method === 'GET') {
    const key = req.query.key;
    if (!key || !ALLOWED.has(key)) return res.status(400).json({ error: 'Clave inválida' });
    try {
      const r = await fetch(`https://api.vercel.com/v1/edge-config/${ECFG}/item/${key}${teamParam}`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      if (r.status === 404) return res.status(200).json({ value: null });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Error de lectura' });
      // El valor en Edge Config es un string JSON
      return res.status(200).json({ value: data.value });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST → escribir un item
  if (req.method === 'POST') {
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { return res.status(400).json({ error: 'Body inválido' }); }
    const { key, value } = body || {};
    if (!key || !ALLOWED.has(key)) return res.status(400).json({ error: 'Clave inválida' });

    try {
      const r = await fetch(`https://api.vercel.com/v1/edge-config/${ECFG}/items${teamParam}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ operation: 'upsert', key, value: typeof value === 'string' ? value : JSON.stringify(value) }]
        })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Error de escritura', detail: data });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
