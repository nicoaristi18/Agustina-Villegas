// Catch-all dispatcher para /api/admin/*
// Separado de /api/auth/ porque Vercel no rutea sub-paths anidados al
// catch-all del padre. Tener admin como top-level garantiza el ruteo.

import {
  getUsers, saveUsers, signSessionToken, setAdminCookie, clearAdminCookie,
  getAdminFromRequest, verifyAdminCredentials, scrubUser, readJsonBody,
  sendSurveyEmail
} from '../../lib/auth.js';
import { getDashboardData, ga4Configured } from '../../lib/ga4.js';
import { getInstagramDashboardData, instagramConfigured } from '../../lib/instagram.js';
import { getTiktokEntries, addTiktokEntry, deleteTiktokEntry } from '../../lib/social.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Extraer el path después de /api/admin/
  let path = '';
  const slug = req.query?.slug;
  if (slug) {
    path = Array.isArray(slug) ? slug.join('/') : String(slug);
  } else if (req.url) {
    const u = new URL(req.url, 'http://x');
    path = u.pathname.replace(/^\/api\/admin\/?/, '').replace(/\/$/, '');
  }
  const method = req.method;
  console.log('[admin dispatcher]', method, 'path:', path);

  try {
    if (path === 'login'  && method === 'POST') return await handleAdminLogin(req, res);
    if (path === 'me'     && method === 'GET')  return await handleAdminMe(req, res);
    if (path === 'logout' && method === 'POST') return await handleAdminLogout(req, res);
    if (path === 'users') {
      if (method === 'GET')    return await handleAdminUsersList(req, res);
      if (method === 'POST')   return await handleAdminUsersUpdate(req, res);
      if (method === 'DELETE') return await handleAdminUsersDelete(req, res);
    }
    if (path === 'send-survey' && method === 'POST') return await handleSendSurvey(req, res);
    if (path === 'analytics' && method === 'GET') return await handleAnalytics(req, res);
    if (path === 'social-tiktok') {
      if (method === 'GET')    return await handleTiktokList(req, res);
      if (method === 'POST')   return await handleTiktokAdd(req, res);
      if (method === 'DELETE') return await handleTiktokDelete(req, res);
    }
    return res.status(404).json({ error: 'Endpoint no encontrado', path, method });
  } catch (err) {
    console.error('[admin dispatcher]', path, err);
    return res.status(500).json({ error: 'Error de servidor' });
  }
}

async function handleAdminLogin(req, res) {
  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'Body inválido' });
  const { user, pass } = body;
  const ok = await verifyAdminCredentials(user, pass);
  if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const token = signSessionToken({ admin: true, user: String(user).toLowerCase() });
  setAdminCookie(res, token);
  return res.status(200).json({ ok: true });
}

async function handleAdminMe(req, res) {
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });
  return res.status(200).json({ ok: true, user: session.user });
}

async function handleAdminLogout(req, res) {
  clearAdminCookie(res);
  return res.status(200).json({ ok: true });
}

async function handleAdminUsersList(req, res) {
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });
  const users = await getUsers();
  const scrubbed = {};
  Object.keys(users).forEach(k => { scrubbed[k] = scrubUser(users[k]); });
  return res.status(200).json({ users: scrubbed });
}

async function handleAdminUsersUpdate(req, res) {
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });
  const body = await readJsonBody(req);
  if (!body?.email || !body?.patch) return res.status(400).json({ error: 'Faltan email o patch' });
  const emailLower = String(body.email).toLowerCase();
  const users = await getUsers();
  if (!users[emailLower]) return res.status(404).json({ error: 'Usuario no encontrado' });
  const ALLOWED = ['credits','plan','phone','name','pendingPlan','bookings'];
  const patch = {};
  Object.keys(body.patch).forEach(k => { if (ALLOWED.includes(k)) patch[k] = body.patch[k]; });
  users[emailLower] = { ...users[emailLower], ...patch };
  await saveUsers(users);
  return res.status(200).json({ user: scrubUser(users[emailLower]) });
}

async function handleAdminUsersDelete(req, res) {
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });
  const email = String(req.query.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'Falta email' });
  const users = await getUsers();
  if (!users[email]) return res.status(404).json({ error: 'Usuario no encontrado' });
  delete users[email];
  await saveUsers(users);
  return res.status(200).json({ ok: true });
}

async function handleAnalytics(req, res) {
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });
  if (!ga4Configured()) return res.status(503).json({ error: 'GA4 no configurado' });
  try {
    const data = await getDashboardData();
    // Instagram es un agregado opcional — si falla (token vencido, no configurado),
    // no tiene que tirar abajo el resto del dashboard de GA4.
    if (instagramConfigured()) {
      try {
        data.instagram = await getInstagramDashboardData();
      } catch (igErr) {
        console.error('[admin analytics] instagram', igErr);
        data.instagramError = igErr.message || 'Error consultando Instagram';
      }
    }
    return res.status(200).json(data);
  } catch (err) {
    console.error('[admin analytics]', err);
    return res.status(500).json({ error: err.message || 'Error consultando GA4' });
  }
}

async function handleTiktokList(req, res) {
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });
  const entries = await getTiktokEntries();
  return res.status(200).json({ entries });
}

async function handleTiktokAdd(req, res) {
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });
  const body = await readJsonBody(req);
  if (!body?.weekOf) return res.status(400).json({ error: 'Falta la semana (weekOf)' });
  const entry = await addTiktokEntry(body);
  return res.status(200).json({ entry });
}

async function handleTiktokDelete(req, res) {
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Falta id' });
  await deleteTiktokEntry(id);
  return res.status(200).json({ ok: true });
}

// Envía la encuesta inicial (Google Form) a una paciente nueva.
// La URL del form se puede cambiar via env var SURVEY_URL.
async function handleSendSurvey(req, res) {
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });
  const body = await readJsonBody(req);
  if (!body?.email) return res.status(400).json({ error: 'Falta email' });
  const surveyUrl = process.env.SURVEY_URL || 'https://docs.google.com/forms/d/e/1FAIpQLSe8yCzzrWHLlZ-vWB0ktdj2VMhh-ouPBQp6had-84pieNbrRA/viewform?usp=dialog';
  const result = await sendSurveyEmail({
    name: body.name || '',
    email: body.email,
    surveyUrl
  });
  if (!result.ok) return res.status(500).json({ error: result.error });
  return res.status(200).json({ ok: true });
}
