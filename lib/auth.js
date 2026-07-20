// Helpers compartidos para autenticación
// - Lectura/escritura de usuarios contra Vercel KV server-side (token nunca expuesto al cliente)
// - Hash y verificación con bcrypt
// - JWT firmado con HS256 + secret de env
// - Cookies HttpOnly+Secure+SameSite=Strict
// - scrubUser() para eliminar el campo `pass` de cualquier objeto antes de devolverlo

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME_USER  = 'ag_session';
const COOKIE_NAME_ADMIN = 'ag_admin';
const SESSION_DAYS = 7;

function _ensureEnv() {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV no configurado');
  if (!JWT_SECRET) throw new Error('JWT_SECRET no configurado');
}

async function _upstash(...cmd) {
  _ensureEnv();
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

// === USUARIOS ===

const USERS_KEY = 'ag:users';

export async function getUsers() {
  const raw = await _upstash('GET', USERS_KEY);
  if (!raw) return {};
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return {}; }
}

export async function saveUsers(users) {
  await _upstash('SET', USERS_KEY, JSON.stringify(users));
}

export async function getUserByEmail(email) {
  const users = await getUsers();
  return users[email.toLowerCase()] || null;
}

// === BOOKINGS ===

const BOOKINGS_KEY = 'ag:bookings';

export async function getBookings() {
  const raw = await _upstash('GET', BOOKINGS_KEY);
  if (!raw) return {};
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return {}; }
}

export async function saveBookings(bookings) {
  await _upstash('SET', BOOKINGS_KEY, JSON.stringify(bookings));
}

// Generador de IDs únicos para tracking
export function generateBookingId() {
  return 'bk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// === EMAIL SERVER-SIDE via Resend ===
// Resend permite controlar 100% el HTML server-side y no tiene
// el límite de 2 templates que tenía EmailJS.
// Configurables via env vars:
//   RESEND_API_KEY      → API key (obligatoria)
//   RESEND_FROM_EMAIL   → from address (default: reservas@nutricionistaagustinavillegas.com)
//   RESEND_BCC_EMAIL    → BCC para que Agustina reciba copia de todo (opcional)
import {
  confirmationTemplate,
  reminderTemplate,
  manualTemplate,
  surveyTemplate,
  guideDeliveryTemplate
} from './email-templates.js';

const DEFAULT_FROM = 'Lic. Agustina Villegas <reservas@nutricionistaagustinavillegas.com>';

// Wrapper genérico para mandar cualquier email via Resend.
// Usado tanto por sendBookingEmail() como por código futuro (encuestas, recetas, etc.).
export async function sendEmail({ to, subject, html, replyTo, bcc }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[sendEmail] RESEND_API_KEY no configurada');
    return { ok: false, error: 'RESEND_API_KEY no configurada' };
  }
  if (!to || !subject || !html) {
    return { ok: false, error: 'Faltan to/subject/html' };
  }

  const from = process.env.RESEND_FROM_EMAIL || DEFAULT_FROM;
  const bccList = [];
  if (bcc) bccList.push(bcc);
  else if (process.env.RESEND_BCC_EMAIL) bccList.push(process.env.RESEND_BCC_EMAIL);

  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html
  };
  if (bccList.length) payload.bcc = bccList;
  if (replyTo) payload.reply_to = replyTo;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[sendEmail] Resend error', r.status, data);
      return { ok: false, error: data?.message || `Resend HTTP ${r.status}` };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[sendEmail]', err);
    return { ok: false, error: err.message };
  }
}

// Dispatcher de templates: según `kind` elige qué template renderizar.
// kind: 'confirmation' | 'reminder' | 'manual'
// params: { patient_name, patient_email, service, date, time, modality, notes,
//           payment_type, payment_link, amount }
export async function sendBookingEmail(params) {
  const {
    patient_name: name,
    patient_email: to,
    service, date, time, modality,
    notes, payment_type, payment_link, amount,
    kind = 'confirmation'
  } = params;

  if (!to) return { ok: false, error: 'Falta patient_email' };

  const isOnline = /online|videollamada/i.test(modality || '');
  let tpl;
  if (kind === 'reminder') {
    tpl = reminderTemplate({ name, service, date, time, modality, paymentLink: payment_link, amount });
  } else if (kind === 'manual') {
    tpl = manualTemplate({ name, service, date, time, modality, notes, isOnline });
  } else {
    tpl = confirmationTemplate({ name, service, date, time, modality, paymentType: payment_type, isOnline });
  }

  return sendEmail({ to, subject: tpl.subject, html: tpl.html });
}

// Envío del email de entrega de guía digital (Runner Principiantes, etc.).
// downloadUrl es un link único con token JWT que apunta a descarga-guia.html.
export async function sendGuideDeliveryEmail({ name, email, downloadUrl, productTitle }) {
  if (!email) return { ok: false, error: 'Falta email' };
  if (!downloadUrl) return { ok: false, error: 'Falta downloadUrl' };
  const tpl = guideDeliveryTemplate({ name, downloadUrl, productTitle });
  return sendEmail({ to: email, subject: tpl.subject, html: tpl.html });
}

// Envío de encuesta inicial (Google Form). La admin la dispara desde el panel.
export async function sendSurveyEmail({ name, email, surveyUrl }) {
  if (!email) return { ok: false, error: 'Falta email' };
  if (!surveyUrl) return { ok: false, error: 'Falta surveyUrl' };
  const tpl = surveyTemplate({ name, surveyUrl });
  return sendEmail({ to: email, subject: tpl.subject, html: tpl.html, replyTo: email });
}

// === PRODUCTOS DIGITALES (e-books, planes descargables) ===
// Arquitectura flexible: array de productos, cada uno con su category, content, price.
// Permite tener varios productos (Runners, Embarazo, Vegetariano, etc.) sin tocar código.

const PRODUCTS_KEY = 'ag:products';

export async function getProducts() {
  const raw = await _upstash('GET', PRODUCTS_KEY);
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function saveProducts(products) {
  await _upstash('SET', PRODUCTS_KEY, JSON.stringify(products));
}

export async function getProductBySlug(slug) {
  if (!slug) return null;
  const products = await getProducts();
  return products.find(p => p.slug === slug) || null;
}

// === COMPRAS DE GUÍAS DIGITALES ===
// Registro simple de compras (por ahora sin MercadoPago).
// Cada compra genera un token JWT con { slug, email, exp: nunca }
// que sirve de "acceso" al link de descarga.
const GUIDE_PURCHASES_KEY = 'ag:guide_purchases';

export async function getGuidePurchases() {
  const raw = await _upstash('GET', GUIDE_PURCHASES_KEY);
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function saveGuidePurchases(purchases) {
  await _upstash('SET', GUIDE_PURCHASES_KEY, JSON.stringify(purchases));
}

export function generateGuideDownloadToken({ slug, email }) {
  _ensureEnv();
  // Token largo (365 días). Es un "acceso perpetuo" al link.
  return jwt.sign({ slug, email, kind: 'guide_dl' }, JWT_SECRET, { expiresIn: '365d' });
}

export function verifyGuideDownloadToken(token) {
  if (!token) return null;
  try {
    _ensureEnv();
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.kind !== 'guide_dl') return null;
    return payload;
  } catch { return null; }
}

// Devuelve solo info pública (sin pdfData) para el cliente — pdfData puede ser pesado
export function scrubProductForPublic(product) {
  if (!product) return null;
  const { pdfData, ...publicData } = product;
  return publicData;
}

// === HASHING ===

const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, stored) {
  if (!stored) return false;
  // Migración: si el hash es del formato viejo (btoa), validar con el método viejo
  // El formato bcrypt empieza con $2a$, $2b$, o $2y$
  if (stored.startsWith('$2')) {
    return bcrypt.compare(plain, stored);
  }
  // Hash legacy = btoa(plain + '_agustina_salt')
  const legacy = Buffer.from(plain + '_agustina_salt').toString('base64');
  return legacy === stored;
}

export function isLegacyHash(stored) {
  return stored && !stored.startsWith('$2');
}

// === JWT ===

export function signSessionToken(payload) {
  _ensureEnv();
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}

export function verifySessionToken(token) {
  if (!token) return null;
  try {
    _ensureEnv();
    return jwt.verify(token, JWT_SECRET);
  } catch { return null; }
}

// === COOKIES ===

function _serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${value}`];
  parts.push('HttpOnly');
  parts.push('Secure');
  parts.push('SameSite=Strict');
  parts.push('Path=/');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

function _parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(p => {
    const [k, ...v] = p.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

export function setUserCookie(res, token) {
  res.setHeader('Set-Cookie', _serializeCookie(COOKIE_NAME_USER, token, { maxAge: SESSION_DAYS * 24 * 60 * 60 }));
}
export function setAdminCookie(res, token) {
  res.setHeader('Set-Cookie', _serializeCookie(COOKIE_NAME_ADMIN, token, { maxAge: SESSION_DAYS * 24 * 60 * 60 }));
}
export function clearUserCookie(res) {
  res.setHeader('Set-Cookie', _serializeCookie(COOKIE_NAME_USER, '', { maxAge: 0 }));
}
export function clearAdminCookie(res) {
  res.setHeader('Set-Cookie', _serializeCookie(COOKIE_NAME_ADMIN, '', { maxAge: 0 }));
}
export function getUserFromRequest(req) {
  const cookies = _parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME_USER]);
}
export function getAdminFromRequest(req) {
  const cookies = _parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME_ADMIN]);
}

// === SCRUB ===

export function scrubUser(user) {
  if (!user) return null;
  const { pass, ...safe } = user;
  // Flag útil para UI: ¿este usuario tiene password configurada?
  // (sin exponer ni el hash ni nada parecido)
  safe.hasPass = !!pass;
  return safe;
}

// === BODY PARSE ===

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
  });
}

// === ADMIN ===

const ADMIN_USER = (process.env.ADMIN_USERNAME || 'agustina').toLowerCase();

export async function verifyAdminCredentials(username, password) {
  if (!username || !password) return false;
  if (username.toLowerCase() !== ADMIN_USER) return false;
  const stored = process.env.ADMIN_PASSWORD_HASH;
  if (!stored) {
    // Fallback temporal — sólo si la env var no está configurada todavía
    // El env debería tener bcrypt hash de 'admin2026'. Mientras no esté, acepta plaintext.
    return password === (process.env.ADMIN_PASSWORD_PLAIN || 'admin2026');
  }
  return bcrypt.compare(password, stored);
}
