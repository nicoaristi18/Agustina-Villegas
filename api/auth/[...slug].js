// Catch-all dispatcher para /api/auth/* (solo endpoints de paciente).
// Admin se separó a /api/admin/* porque Vercel no rutea sub-paths anidados al catch-all.

import {
  getUsers, saveUsers, getUserByEmail, hashPassword, verifyPassword,
  isLegacyHash, signSessionToken, setUserCookie, clearUserCookie,
  getUserFromRequest, scrubUser, readJsonBody,
  getBookings, saveBookings
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
    if (path === 'register'         && method === 'POST') return await handleRegister(req, res);
    if (path === 'login'            && method === 'POST') return await handleLogin(req, res);
    if (path === 'me'               && method === 'GET')  return await handleMe(req, res);
    if (path === 'logout'           && method === 'POST') return await handleLogout(req, res);
    if (path === 'book-with-credit' && method === 'POST') return await handleBookWithCredit(req, res);
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

// === BOOK WITH CREDIT ===
// POST /api/auth/book-with-credit
// Body: { dateKey, time, dateStr, svc, dur, type, modality, name, email, phone, notes }
// Requiere sesión activa. Descuenta 1 crédito y registra la reserva.
async function handleBookWithCredit(req, res) {
  const session = getUserFromRequest(req);
  if (!session?.email) return res.status(401).json({ error: 'Tenés que iniciar sesión para usar créditos.' });

  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'Body inválido' });

  const { dateKey, time, dateStr, svc, dur, type, modality, name, email, phone, notes } = body;
  if (!dateKey || !time || !svc || !name || !email) {
    return res.status(400).json({ error: 'Faltan datos del turno (fecha, hora, servicio, nombre, email).' });
  }

  // Cargar el usuario y verificar créditos
  const users = await getUsers();
  const user = users[session.email];
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  if ((user.credits || 0) <= 0) {
    return res.status(403).json({ error: 'No tenés créditos disponibles. Comprá un plan para reservar consultas.' });
  }

  // Cargar bookings y verificar que el slot no esté tomado
  const bookings = await getBookings();
  if (bookings[dateKey] && bookings[dateKey][time]) {
    return res.status(409).json({ error: 'Ese horario ya fue reservado por otro paciente. Elegí otro.' });
  }

  // Crear la reserva
  if (!bookings[dateKey]) bookings[dateKey] = {};
  const modLabel = type === 'masaje' ? 'Presencial' : (modality === 'online' ? 'Online (videollamada)' : 'Presencial');
  bookings[dateKey][time] = {
    dur, svc, name, email, phone: phone || '', notes: notes || '',
    modality: modLabel, paid: true, paidWithCredit: true
  };

  // Descontar crédito + agregar al historial del paciente
  user.credits = (user.credits || 0) - 1;
  user.bookings = user.bookings || [];
  user.bookings.push({
    service: svc,
    date: dateStr || dateKey,
    time,
    status: 'upcoming',
    modality: modLabel,
    createdAt: new Date().toISOString()
  });
  users[session.email] = user;

  // Guardar ambos
  await Promise.all([saveBookings(bookings), saveUsers(users)]);

  return res.status(200).json({
    ok: true,
    remainingCredits: user.credits,
    booking: { dateKey, time, svc, modality: modLabel }
  });
}
