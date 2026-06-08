// POST /api/auth/admin/login
// Body: { user, pass }
// Verifica credenciales del admin contra env vars y setea cookie ag_admin.

import {
  verifyAdminCredentials, signSessionToken, setAdminCookie, readJsonBody
} from '../../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'Body inválido' });

  const { user, pass } = body;
  try {
    const ok = await verifyAdminCredentials(user, pass);
    if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const token = signSessionToken({ admin: true, user: String(user).toLowerCase() });
    setAdminCookie(res, token);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[admin/login]', err);
    return res.status(500).json({ error: 'Error de servidor' });
  }
}
