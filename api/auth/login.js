// POST /api/auth/login
// Body: { email, pass }
// Verifica la contraseña, migra hash legacy a bcrypt si corresponde, setea cookie.

import {
  getUsers, saveUsers, verifyPassword, hashPassword, isLegacyHash,
  signSessionToken, setUserCookie, scrubUser, readJsonBody
} from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'Body inválido' });

  const { email, pass } = body;
  if (!email || !pass) return res.status(400).json({ error: 'Completá email y contraseña.' });
  const emailLower = String(email).trim().toLowerCase();

  try {
    const users = await getUsers();
    const user = users[emailLower];
    if (!user) {
      // Mismo mensaje genérico para no revelar si el email existe
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }
    const ok = await verifyPassword(pass, user.pass);
    if (!ok) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }
    // Migración transparente: si el hash es legacy, re-hashear con bcrypt
    if (isLegacyHash(user.pass)) {
      user.pass = await hashPassword(pass);
      users[emailLower] = user;
      await saveUsers(users);
    }
    const token = signSessionToken({ email: emailLower });
    setUserCookie(res, token);
    return res.status(200).json({ user: scrubUser(user) });
  } catch (err) {
    console.error('[login]', err);
    return res.status(500).json({ error: 'Error de servidor.' });
  }
}
