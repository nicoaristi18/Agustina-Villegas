// Vercel KV (Upstash Redis) — endpoint compartido para todo el sitio
// Requiere env vars: KV_REST_API_URL + KV_REST_API_TOKEN (auto-inyectadas por Vercel al conectar KV)
//
// GET  /api/kv?op=get&key=ag:KEY
// GET  /api/kv?op=lrange&key=ag:KEY&start=0&stop=-1
// GET  /api/kv?op=hget&key=ag:KEY&field=FIELD
// GET  /api/kv?op=hgetall&key=ag:KEY
// POST /api/kv  body:{op:'set'|'lpush'|'rpush'|'del'|'hset'|'hdel'|'hincrby', key, value?, field?, by?}
// Todas las claves DEBEN empezar con "ag:"

const ALLOWED_PREFIX = 'ag:';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KV_URL   = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({ error: 'KV no configurado. Ir a Vercel → proyecto → Storage → Create Database → KV Store y conectar al proyecto.' });
  }

  // ── GET ──
  if (req.method === 'GET') {
    const { op, key, start, stop, field } = req.query;
    if (!key || !key.startsWith(ALLOWED_PREFIX))
      return res.status(400).json({ error: 'Clave inválida (debe empezar con ag:)' });

    try {
      if (op === 'get') {
        const val = await upstash(KV_URL, KV_TOKEN, 'GET', key);
        return res.status(200).json({ value: val });
      }
      if (op === 'lrange') {
        const s = start ?? '0', e = stop ?? '-1';
        const list = await upstash(KV_URL, KV_TOKEN, 'LRANGE', key, String(s), String(e));
        return res.status(200).json({ value: list || [] });
      }
      if (op === 'hget') {
        if (!field) return res.status(400).json({ error: 'field requerido para hget' });
        const val = await upstash(KV_URL, KV_TOKEN, 'HGET', key, field);
        return res.status(200).json({ value: val });
      }
      if (op === 'hgetall') {
        const flat = await upstash(KV_URL, KV_TOKEN, 'HGETALL', key);
        // Upstash devuelve array plano [k,v,k,v,...] → convertir a objeto
        const obj = {};
        if (Array.isArray(flat)) {
          for (let i = 0; i < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
        }
        return res.status(200).json({ value: obj });
      }
      return res.status(400).json({ error: 'op inválida. Usar: get, lrange, hget, hgetall' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST ──
  if (req.method === 'POST') {
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { return res.status(400).json({ error: 'Body JSON inválido' }); }

    const { op, key, value, field, by } = body || {};
    if (!key || !key.startsWith(ALLOWED_PREFIX))
      return res.status(400).json({ error: 'Clave inválida (debe empezar con ag:)' });

    try {
      if (op === 'set') {
        const v = typeof value === 'string' ? value : JSON.stringify(value);
        await upstash(KV_URL, KV_TOKEN, 'SET', key, v);
        return res.status(200).json({ ok: true });
      }
      if (op === 'lpush') {
        const v = typeof value === 'string' ? value : JSON.stringify(value);
        const len = await upstash(KV_URL, KV_TOKEN, 'LPUSH', key, v);
        return res.status(200).json({ ok: true, length: len });
      }
      if (op === 'rpush') {
        const v = typeof value === 'string' ? value : JSON.stringify(value);
        const len = await upstash(KV_URL, KV_TOKEN, 'RPUSH', key, v);
        return res.status(200).json({ ok: true, length: len });
      }
      if (op === 'del') {
        await upstash(KV_URL, KV_TOKEN, 'DEL', key);
        return res.status(200).json({ ok: true });
      }
      if (op === 'hset') {
        if (!field) return res.status(400).json({ error: 'field requerido para hset' });
        const v = typeof value === 'string' ? value : JSON.stringify(value);
        await upstash(KV_URL, KV_TOKEN, 'HSET', key, field, v);
        return res.status(200).json({ ok: true });
      }
      if (op === 'hdel') {
        if (!field) return res.status(400).json({ error: 'field requerido para hdel' });
        await upstash(KV_URL, KV_TOKEN, 'HDEL', key, field);
        return res.status(200).json({ ok: true });
      }
      if (op === 'hincrby') {
        if (!field) return res.status(400).json({ error: 'field requerido para hincrby' });
        const newVal = await upstash(KV_URL, KV_TOKEN, 'HINCRBY', key, field, String(by ?? 1));
        return res.status(200).json({ ok: true, value: newVal });
      }
      return res.status(400).json({ error: 'op inválida. Usar: set, lpush, rpush, del, hset, hdel, hincrby' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
