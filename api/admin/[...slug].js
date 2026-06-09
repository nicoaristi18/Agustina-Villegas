// Catch-all dispatcher para /api/admin/*
// Separado de /api/auth/ porque Vercel no rutea sub-paths anidados al
// catch-all del padre. Tener admin como top-level garantiza el ruteo.

import {
  getUsers, saveUsers, signSessionToken, setAdminCookie, clearAdminCookie,
  getAdminFromRequest, verifyAdminCredentials, scrubUser, readJsonBody
} from '../../lib/auth.js';

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
