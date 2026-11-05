// Catálogo de precios del lado del servidor.
//
// Antes, reservas y combos de la guía cobraban el monto que mandaba el navegador
// (o el que venía en el link ?price=), así que se podía pagar $1 por cualquier cosa.
// Ahora el servidor calcula siempre el precio con esta tabla: los valores por
// defecto salen de _Contexto/negocio.md y los que se guardan en la solapa
// "Precios" del admin (KV ag:prices) los pisan.

import { getCoupons, applyCoupon } from './auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export const DEFAULT_PRICES = {
  // Nutrición
  consulta: 1500, control: 800, plan: 2800, isak: 1500,
  // Masajes
  cuerpo: 1100, descontrac: 890, relajante: 800, drenaje: 750, deportivo: 890, embarazo: 800,
  // Planes de seguimiento
  plan2: 4100, plan3: 5300, plan6: 9700,
  // Guía runners
  guia: 1500, guia_consulta: 2000, guia_plan4: 6000
};

// Nombre del servicio tal como lo manda reservar.html (sel.svc) → clave de precio
export const SERVICE_KEYS = {
  'Plan de alimentación': 'plan',
  'Primera consulta nutricional': 'consulta',
  'Consulta de control': 'control',
  'Medición ISAK': 'isak',
  'Masaje cuerpo completo': 'cuerpo',
  'Masaje descontracturante': 'descontrac',
  'Masaje relajante': 'relajante',
  'Drenaje linfático piernas': 'drenaje',
  'Masaje deportivo': 'deportivo',
  'Masaje para embarazadas': 'embarazo'
};

// Planes que se compran desde mi-cuenta.html?plan=... (planes.html y combos de
// runners.html). Los créditos también los fija el servidor, no el link.
export const PLAN_OFFERS = {
  'Plan 2 meses': { priceKey: 'plan2', credits: 3 },
  'Plan 4 meses': { priceKey: 'plan3', credits: 5 },
  'Plan 3 meses': { priceKey: 'plan3', credits: 5 }, // nombre anterior del de 4 meses
  'Plan 6 meses': { priceKey: 'plan6', credits: 8 },
  'Guía + Consulta de control': { priceKey: 'guia_consulta', credits: 1 },
  'Guía + Plan 4 meses': { priceKey: 'guia_plan4', credits: 5 }
};

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['GET', key])
  });
  const d = await r.json();
  return d.result ?? null;
}

// Precios vigentes: defaults + lo guardado en el admin (solo números > 0).
export async function getPrices() {
  const prices = { ...DEFAULT_PRICES };
  try {
    const raw = await kvGet('ag:prices');
    const saved = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    for (const [k, v] of Object.entries(saved)) {
      const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
      if (n > 0) prices[k] = n;
    }
  } catch (err) {
    console.error('[pricing] no se pudieron leer los precios guardados, uso los por defecto', err);
  }
  return prices;
}

// Cupones: el admin los guarda en KV (hash ag:coupons) y en Edge Config.
// Se busca primero en KV y, si no está, en Edge Config.
async function findCoupon(code) {
  if (!code) return null;
  const all = await getCoupons();
  if (all[code]) return all[code];
  const ECFG = process.env.EDGE_CONFIG_ID;
  const TOKEN = process.env.VERCEL_API_TOKEN;
  if (!ECFG || !TOKEN) return null;
  try {
    const team = process.env.VERCEL_TEAM_ID ? `?teamId=${process.env.VERCEL_TEAM_ID}` : '';
    const r = await fetch(`https://api.vercel.com/v1/edge-config/${ECFG}/item/agustina_coupons${team}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (!r.ok) return null;
    const item = await r.json();
    const map = typeof item.value === 'string' ? JSON.parse(item.value) : (item.value || {});
    return map[code] || null;
  } catch { return null; }
}

// Precio final de un servicio de reservar.html, con cupón opcional.
// Devuelve { ok, price, basePrice, coupon } o { ok:false, error }.
export async function quoteService(svc, couponCode) {
  const key = SERVICE_KEYS[svc];
  if (!key) return { ok: false, error: 'Servicio desconocido: ' + svc };
  const prices = await getPrices();
  const basePrice = prices[key];
  const code = couponCode ? String(couponCode).trim().toUpperCase() : '';
  if (!code) return { ok: true, price: basePrice, basePrice, coupon: null };
  const result = applyCoupon(await findCoupon(code), basePrice);
  if (!result.ok) return { ok: false, error: 'Cupón inválido: ' + result.error };
  return { ok: true, price: result.finalPrice, basePrice, coupon: code };
}

// Plan pendiente comprado por link: precio y créditos según el catálogo.
export async function quotePlanOffer(name) {
  const offer = PLAN_OFFERS[name];
  if (!offer) return null;
  const prices = await getPrices();
  return { name, credits: offer.credits, price: prices[offer.priceKey] };
}

export async function guidePrice(fallback) {
  const prices = await getPrices();
  return prices.guia || Number(fallback) || DEFAULT_PRICES.guia;
}
