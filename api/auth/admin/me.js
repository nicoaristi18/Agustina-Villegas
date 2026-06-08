// GET /api/auth/admin/me — confirma si la cookie ag_admin es válida

import { getAdminFromRequest } from '../../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const session = getAdminFromRequest(req);
  if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });
  return res.status(200).json({ ok: true, user: session.user });
}
