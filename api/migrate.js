// Migración one-shot: Edge Config → Vercel KV
// Llamar UNA SOLA VEZ desde admin: GET /api/migrate
// Solo lectura de Edge Config, escritura en KV — no modifica Edge Config
//
// Mapeo de claves:
//   agustina_blocked_slots  → ag:blocked_slots
//   agustina_bookings_v2    → ag:bookings
//   agustina_users          → ag:users
//   agustina_content        → ag:content
//   habito_orders           → ag:habito_orders

const KEY_MAP = {
  'agustina_blocked_slots': 'ag:blocked_slots',
  'agustina_bookings_v2':   'ag:bookings',
  'agustina_users':         'ag:users',
  'agustina_content':       'ag:content',
  'habito_orders':          'ag:habito_orders',
};

async function upstash(url, token, ...cmd) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const EC_TOKEN = process.env.VERCEL_API_TOKEN;
  const ECFG     = process.env.EDGE_CONFIG_ID;
  const TEAM     = process.env.VERCEL_TEAM_ID;
  const KV_URL   = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  if (!EC_TOKEN || !ECFG)  return res.status(500).json({ error: 'Edge Config no configurado (VERCEL_API_TOKEN / EDGE_CONFIG_ID faltantes)' });
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'KV no configurado. Crear KV database en Vercel Storage y conectar al proyecto.' });

  const teamParam = TEAM ? `?teamId=${TEAM}` : '';
  const results = {};

  for (const [oldKey, newKey] of Object.entries(KEY_MAP)) {
    try {
      // 1. Leer de Edge Config
      const r = await fetch(
        `https://api.vercel.com/v1/edge-config/${ECFG}/item/${oldKey}${teamParam}`,
        { headers: { Authorization: `Bearer ${EC_TOKEN}` } }
      );
      if (r.status === 404) {
        results[newKey] = 'skipped (no existía en Edge Config)';
        continue;
      }
      const d = await r.json();
      if (!r.ok) {
        results[newKey] = `error_edge_config: ${d.error?.message || r.status}`;
        continue;
      }

      const value = typeof d.value === 'string' ? d.value : JSON.stringify(d.value);

      // 2. Escribir en Vercel KV
      await upstash(KV_URL, KV_TOKEN, 'SET', newKey, value);
      results[newKey] = `ok (${value.length} bytes)`;
    } catch (e) {
      results[newKey] = `exception: ${e.message}`;
    }
  }

  const ok = Object.values(results).filter(v => v.startsWith('ok')).length;
  return res.status(200).json({ migrated: ok, total: Object.keys(KEY_MAP).length, results });
}
