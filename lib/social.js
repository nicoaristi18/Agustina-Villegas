// Tracker manual de redes sin API disponible (TikTok: su API de analítica orgánica
// requiere revisión de negocio, no es viable para esta cuenta). Agustina carga los
// números una vez por semana desde el admin y quedan guardados acá, junto al resto
// del dashboard — en vez de una planilla aparte.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KEY = 'ag:social_tiktok';

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

export async function getTiktokEntries() {
  const raw = await upstash('GET', KEY);
  if (!raw) return [];
  try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(v) ? v : []; }
  catch { return []; }
}

export async function addTiktokEntry(entry) {
  const entries = await getTiktokEntries();
  const clean = {
    id: 'tt_' + Date.now(),
    weekOf: String(entry.weekOf || '').slice(0, 10),
    reach: Number(entry.reach) || 0,
    newFollowers: Number(entry.newFollowers) || 0,
    topVideo: String(entry.topVideo || '').slice(0, 200),
    topVideoViews: Number(entry.topVideoViews) || 0,
    createdAt: new Date().toISOString()
  };
  entries.push(clean);
  entries.sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  await upstash('SET', KEY, JSON.stringify(entries));
  return clean;
}

export async function deleteTiktokEntry(id) {
  const entries = (await getTiktokEntries()).filter(e => e.id !== id);
  await upstash('SET', KEY, JSON.stringify(entries));
}
