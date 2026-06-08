// GET /api/auth/me
// Devuelve datos del usuario logueado (sin password). 401 si no hay sesión.

import { getUserFromRequest, getUserByEmail, scrubUser } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = getUserFromRequest(req);
  if (!session?.email) return res.status(401).json({ error: 'No autenticado' });
  try {
    const user = await getUserByEmail(session.email);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
    return res.status(200).json({ user: scrubUser(user) });
  } catch (err) {
    console.error('[me]', err);
    return res.status(500).json({ error: 'Error de servidor' });
  }
}
