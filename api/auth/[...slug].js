// Catch-all dispatcher para /api/auth/* (solo endpoints de paciente).
// Admin se separó a /api/admin/* porque Vercel no rutea sub-paths anidados al catch-all.

import {
  getUsers, saveUsers, getUserByEmail, hashPassword, verifyPassword,
  isLegacyHash, signSessionToken, setUserCookie, clearUserCookie,
  getUserFromRequest, scrubUser, readJsonBody
} from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  let path = '';
  const slug = req.query?.slug;
  if (slug) {
    path = Array.isArray(slug) ? slug.join('/') : String(slug);
  } else if (req.url) {
    const u = new URL(req.url, 'http://x');
    path = u.pathname.replace(/^\/api\/auth\/?/, '').replace(/\/$/, '');
  }
  const method = req.method;
  console.log('[auth dispatcher]', method, 'path:', path);

  try {
    if (path === 'register' && method === 'POST')  return await handleRegister(req, res);
    if (path === 'login'    && method === 'POST')  return await handleLogin(req, res);
    if (path === 'me'       && method === 'GET')   return await handleMe(req, res);
    if (path === 'logout'   && method === 'POST')  return await handleLogout(req, res);
    return res.status(404).json({ error: 'Endpoint no encontrado', path, method });
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
