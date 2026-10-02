// Helpers para leer datos de Google Analytics 4 (GA4 Data API v1beta) desde el servidor.
// Requiere las env vars GA4_SA_CLIENT_EMAIL + GA4_SA_PRIVATE_KEY (de un service account de
// Google Cloud con rol Viewer en la propiedad GA4) + GA4_PROPERTY_ID (Vercel → Settings →
// Environment Variables). GA4_SA_PRIVATE_KEY lleva los saltos de línea como \n literales.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

export function ga4Configured() {
  return !!(process.env.GA4_SA_CLIENT_EMAIL && process.env.GA4_SA_PRIVATE_KEY && process.env.GA4_PROPERTY_ID);
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const clientEmail = process.env.GA4_SA_CLIENT_EMAIL;
  const privateKey = (process.env.GA4_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) throw new Error('GA4 no configurado (faltan GA4_SA_CLIENT_EMAIL / GA4_SA_PRIVATE_KEY)');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;

  const { createSign } = await import('node:crypto');
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('No se pudo autenticar con GA4: ' + JSON.stringify(data));
  return data.access_token;
}

async function runReport(token, propertyId, body) {
  const r = await fetch(`${DATA_API}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || 'Error consultando GA4');
  return data;
}

function rowsToSeries(report, dimCount = 2) {
  if (!report?.rows) return [];
  return report.rows.map(row => ({
    dims: row.dimensionValues.map(d => d.value),
    metrics: row.metricValues.map(m => Number(m.value))
  }));
}

export async function getDashboardData() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const token = await getAccessToken();

  const [usersByWeek, sessionsByChannel, reservaConfirmada, purchases, topPages] = await Promise.all([
    runReport(token, propertyId, {
      dateRanges: [{ startDate: '56daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'year' }, { name: 'week' }],
      metrics: [{ name: 'activeUsers' }],
      orderBys: [{ dimension: { dimensionName: 'year' } }, { dimension: { dimensionName: 'week' } }]
    }),
    runReport(token, propertyId, {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }]
    }),
    runReport(token, propertyId, {
      dateRanges: [{ startDate: '56daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'year' }, { name: 'week' }],
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'reserva_confirmada' } } },
      metrics: [{ name: 'eventCount' }],
      orderBys: [{ dimension: { dimensionName: 'year' } }, { dimension: { dimensionName: 'week' } }]
    }),
    runReport(token, propertyId, {
      dateRanges: [{ startDate: '56daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'year' }, { name: 'week' }],
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'purchase' } } },
      metrics: [{ name: 'eventCount' }, { name: 'eventValue' }],
      orderBys: [{ dimension: { dimensionName: 'year' } }, { dimension: { dimensionName: 'week' } }]
    }),
    runReport(token, propertyId, {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 10
    })
  ]);

  return {
    usersByWeek: rowsToSeries(usersByWeek),
    sessionsByChannel: rowsToSeries(sessionsByChannel),
    reservaConfirmada: rowsToSeries(reservaConfirmada),
    purchases: rowsToSeries(purchases),
    topPages: rowsToSeries(topPages),
    generatedAt: new Date().toISOString()
  };
}
