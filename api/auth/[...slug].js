// Catch-all dispatcher para /api/auth/*
// Vercel Hobby tiene límite de 12 serverless functions → consolidamos.
// El frontend sigue llamando a /api/auth/login, /api/auth/me, /api/auth/admin/users, etc.

import {
  getUsers, saveUsers, getUserByEmail, hashPassword, verifyPassword,
  isLegacyHash, signSessionToken, setUserCookie, clearUserCookie,
  setAdminCookie, clearAdminCookie, getUserFromRequest, getAdminFromRequest,
  verifyAdminCredentials, scrubUser, readJsonBody
} from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Extraer el path después de /api/auth/ — primero del slug query (Vercel dynamic route),
  // sino parseamos req.url directamente (fallback robusto)
  let path = '';
  const slug = req.query?.slug;
  if (slug) {
    path = Array.isArray(slug) ? slug.join('/') : String(slug);
  } else if (req.url) {
    const u = new URL(req.url, 'http://x');
    path = u.pathname.replace(/^\/api\/auth\/?/, '').replace(/\/$/, '');
  }
  const method = req.method;
  console.log('[auth dispatcher]', method, 'path:', path, 'slug:', slug, 'url:', req.url);

  try {
    // ==== USER ENDPOINTS ====
    if (path === 'register' && method === 'POST')  return await handleRegister(req, res);
    if (path === 'login'    && method === 'POST')  return await handleLogin(req, res);
    if (path === 'me'       && method === 'GET')   return await handleMe(req, res);
    if (path === 'logout'   && method === 'POST')  return await handleLogout(req, res);

    // ==== ADMIN ENDPOINTS ====
    if (path === 'admin/login'  && method === 'POST') return await handleAdminLogin(req, res);
    if (path === 'admin/me'     && method === 'GET')  return await handleAdminMe(req, res);
    if (path === 'admin/logout' && method === 'POST') return await handleAdminLogout(req, res);
    if (path === 'admin/users') {
      if (method === 'GET')    return await handleAdminUsersList(req, res);
      if (method === 'POST')   return await handleAdminUsersUpdate(req, res);
      if (method === 'DELETE') return await handleAdminUsersDelete(req, res);
    }

    return res.status(404).json({ error: 'Endpoint no encontrado', path, method, slug, url: req.url });
  } catch (err) {
    console.error('[auth dispatcher]', path, err);
    return res.status(500).json({ error: 'Error de servidor' });
  }
}

// ============================================================
// USER HANDLERS
// ============================================================

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'Body inválido' });
  const { name, email, phone, pass, plan } = body;
  if (!name || !email || !pass) return res.status(400).json({ error: 'Faltan campos obligatorios (name, email, pass).' });
  if (typeof pass !== 'string' || pass.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  const emailLower = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) return res.status(400).json({ error: 'Email inválido.' });

  const users = await getUsers();
  if (users[emailLower]) return res.status(409).json({ error: 'Ya existe una cuenta con ese email.' });
  const passHash = await hashPassword(pass);
  const newUser = {
    name: String(name).trim(),
    email: emailLower,
    phone: phone ? String(phone).trim() : '',
    pass: passHash,
    plan: null, // solo se setea al pagar
    credits: 0,
    pendingPlan: plan && plan.name ? {
      name: plan.name,
      credits: Number(plan.credits) || 0,
      price: Number(plan.price) || 0
    } : null,
    bookings: [],
    paidPayments: [],
    createdAt: new Date().toISOString()
  };
  users[emailLower] = newUser;
  await saveUsers(users);
  const token = signSessionToken({ email: emailLower });
  setUserCookie(res, token);
  return res.status(200).json({ user: scrubUser(newUser) });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'Body inválido' });
  const { email, pass } = body;
  if (!email || !pass) return res.status(400).json({ error: 'Completá email y contraseña.' });
  const emailLower = String(email).trim().toLowerCase();
  const users = await getUsers();
  const user = users[emailLower];
  if (!user) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
  const ok = await verifyPassword(pass, user.pass);
  if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
  if (isLegacyHash(user.pass)) {
    user.pass = await hashPassword(pass);
    users[emailLower] = user;
    await saveUsers(users);
  }
  const token = signSessionToken({ email: emailLower });
  setUserCookie(res, token);
  return res.status(200).json({ user: scrubUser(user) });
}

async function handleMe(req, res) {
  const session = getUserFromRequest(req);
  if (!session?.email) return res.status(401).json({ error: 'No autenticado' });
  const user = await getUserByEmail(session.email);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  return res.status(200).json({ user: scrubUser(user) });
}

async function handleLogout(req, res) {
  clearUserCookie(res);
  return res.status(200).json({ ok: true });
}

// ============================================================
// ADMIN HANDLERS
// ============================================================

async function handleAdminLogin(req, res) {
  const body = await readJsonBody(req);
  if (!body) {
    console.error('[admin/login] body es null. req.body:', req.body, 'typeof:', typeof req.body);
    return res.status(400).json({ error: 'Body inválido', _debug: { body: req.body, type: typeof req.body } });
  }
  const { user, pass } = body;
  const ok = await verifyAdminCredentials(user, pass);
  if (!ok) {
    // Debug temporal (no leakea valores, solo metadatos para diagnostico)
    const debug = {
      receivedUserType: typeof user,
      receivedUserEmpty: !user,
      receivedPassType: typeof pass,
      receivedPassLength: typeof pass === 'string' ? pass.length : null,
      expectedUserLower: (process.env.ADMIN_USERNAME || 'agustina').toLowerCase(),
      hasAdminPasswordHashEnv: !!process.env.ADMIN_PASSWORD_HASH,
      hasAdminPasswordPlainEnv: !!process.env.ADMIN_PASSWORD_PLAIN,
      adminPasswordPlainLength: process.env.ADMIN_PASSWORD_PLAIN ? process.env.ADMIN_PASSWORD_PLAIN.length : null,
      userMatchesExpected: typeof user === 'string' && user.toLowerCase() === (process.env.ADMIN_USERNAME || 'agustina').toLowerCase()
    };
    console.error('[admin/login] failed', debug);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos', _debug: debug });
  }
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
