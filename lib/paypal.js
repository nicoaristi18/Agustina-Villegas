// Helpers para integrar PayPal — alternativa a Mercado Pago para pagos desde el exterior.
// Requiere las env vars PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET (Vercel → Settings →
// Environment Variables). PAYPAL_ENV='live' usa el entorno real; cualquier otro valor
// (o ausente) usa el sandbox de pruebas de PayPal.

const PAYPAL_BASE = process.env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

export function paypalConfigured() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

// Config pública — el Client ID NO es secreto, se expone al frontend para cargar el SDK.
// El Secret nunca sale de este archivo.
export function getPaypalPublicConfig() {
  return { clientId: process.env.PAYPAL_CLIENT_ID || null };
}

async function getPaypalAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal no configurado (faltan PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || 'Error de autenticación con PayPal');
  return data.access_token;
}

// Conversión aproximada UYU → USD para mostrar el precio en PayPal (no opera en pesos
// uruguayos). No consulta una cotización en vivo — ajustar USD_UYU_RATE en las env vars
// de Vercel cuando el tipo de cambio se mueva. Default conservador: 40.
export function uyuToUsd(uyuAmount) {
  const rate = Number(process.env.USD_UYU_RATE) || 40;
  return Math.round((Number(uyuAmount) / rate) * 100) / 100;
}

export async function createPaypalOrder({ amountUyu, description, referenceId }) {
  const token = await getPaypalAccessToken();
  const amountUsd = uyuToUsd(amountUyu);
  const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: referenceId,
        description: String(description || '').slice(0, 127),
        amount: { currency_code: 'USD', value: amountUsd.toFixed(2) }
      }]
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || 'Error creando la orden de PayPal');
  return { orderId: data.id, amountUsd };
}

export async function capturePaypalOrder(orderId) {
  const token = await getPaypalAccessToken();
  const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || 'Error capturando el pago de PayPal');
  return data;
}
