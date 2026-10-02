// GET /api/paypal-config → { clientId } o { clientId: null } si todavía no está configurado.
// Público a propósito: el Client ID de PayPal no es secreto, lo necesita el frontend para
// cargar el SDK de PayPal. El Client Secret nunca se expone acá.
import { getPaypalPublicConfig } from '../lib/paypal.js';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return res.status(200).json(getPaypalPublicConfig());
}
