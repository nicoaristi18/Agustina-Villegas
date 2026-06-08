// POST /api/auth/admin/logout

import { clearAdminCookie } from '../../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  clearAdminCookie(res);
  return res.status(200).json({ ok: true });
}
