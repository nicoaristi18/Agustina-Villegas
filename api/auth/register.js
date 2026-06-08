// POST /api/auth/register
// Body: { name, email, phone, pass, plan? }
// Crea un usuario nuevo, hashea la contraseña con bcrypt, setea cookie de sesión.

import {
  getUsers, saveUsers, hashPassword,
  signSessionToken, setUserCookie, scrubUser, readJsonBody
} from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'Body inválido' });

  const { name, email, phone, pass, plan } = body;
  if (!name || !email || !pass) {
    return res.status(400).json({ error: 'Faltan campos obligatorios (name, email, pass).' });
  }
  if (typeof pass !== 'string' || pass.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  const emailLower = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
    return res.status(400).json({ error: 'Email inválido.' });
  }

  try {
    const users = await getUsers();
    if (users[emailLower]) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email.' });
    }
    const passHash = await hashPassword(pass);
    const newUser = {
      name: String(name).trim(),
      email: emailLower,
      phone: phone ? String(phone).trim() : '',
      pass: passHash,
      plan: plan?.name || null,
      credits: 0,
      pendingPlan: plan && plan.name ? {
        name: plan.name,
        credits: Number(plan.credits) || 0,
        price: Number(plan.price) || 0
      } : null,
      bookings: [],
      createdAt: new Date().toISOString()
    };
    users[emailLower] = newUser;
    await saveUsers(users);

    const token = signSessionToken({ email: emailLower });
    setUserCookie(res, token);
    return res.status(200).json({ user: scrubUser(newUser) });
  } catch (err) {
    console.error('[register]', err);
    return res.status(500).json({ error: 'Error al registrar.' });
  }
}
