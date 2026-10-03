// Helpers de cupones — mismo formato y misma clave KV (ag:coupons, hash) que ya
// usa el admin (ver admin.html → saveCupon()). Se escriben acá para que el cron
// de seguimiento pueda generar cupones únicos de un solo uso sin pasar por el
// endpoint público /api/kv.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const COUPONS_KEY = 'ag:coupons';

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

// Genera y guarda un cupón de un solo uso. Devuelve el código creado.
export async function createOneTimeCoupon({ prefix = 'VOLVE', type = 'percent', value = 15, expiresInDays = 14 }) {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const code = `${prefix}${value}-${suffix}`;
  const expires = new Date(Date.now() + expiresInDays * 86400000).toISOString().slice(0, 10);
  const cup = { code, type, value, uses_max: 1, uses_current: 0, expires, active: true };
  await upstash('HSET', COUPONS_KEY, code, JSON.stringify(cup));
  return code;
}
