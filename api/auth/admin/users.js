// GET    /api/auth/admin/users           → lista todos los usuarios (sin password)
// POST   /api/auth/admin/users           Body { email, patch:{credits,plan,phone,name,pendingPlan,bookings} } → actualiza
// DELETE /api/auth/admin/users?email=... → elimina un usuario

import {
  getAdminFromRequest, getUsers, saveUsers, scrubUser, readJsonBody
} from '../../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });

  try {
    if (req.method === 'GET') {
      const users = await getUsers();
      const scrubbed = {};
      Object.keys(users).forEach(k => { scrubbed[k] = scrubUser(users[k]); });
      return res.status(200).json({ users: scrubbed });
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body?.email || !body?.patch) return res.status(400).json({ error: 'Faltan email o patch' });
      const emailLower = String(body.email).toLowerCase();
      const users = await getUsers();
      if (!users[emailLower]) return res.status(404).json({ error: 'Usuario no encontrado' });
      // Whitelist de campos que admin puede modificar (NUNCA pass)
      const ALLOWED = ['credits','plan','phone','name','pendingPlan','bookings'];
      const patch = {};
      Object.keys(body.patch).forEach(k => { if (ALLOWED.includes(k)) patch[k] = body.patch[k]; });
      users[emailLower] = { ...users[emailLower], ...patch };
      await saveUsers(users);
      return res.status(200).json({ user: scrubUser(users[emailLower]) });
    }

    if (req.method === 'DELETE') {
      const email = String(req.query.email || '').toLowerCase();
      if (!email) return res.status(400).json({ error: 'Falta email' });
      const users = await getUsers();
      if (!users[email]) return res.status(404).json({ error: 'Usuario no encontrado' });
      delete users[email];
      await saveUsers(users);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin/users]', err);
    return res.status(500).json({ error: 'Error de servidor' });
  }
}
