// Helpers para leer datos de Google Analytics 4 (GA4 Data API v1beta) desde el servidor.
// Requiere las env vars GA4_SA_CLIENT_EMAIL + GA4_SA_PRIVATE_KEY (de un service account de
// Google Cloud con rol Viewer en la propiedad GA4) + GA4_PROPERTY_ID (Vercel → Settings →
// Environment Variables). GA4_SA_PRIVATE_KEY lleva los saltos de línea como \n literales.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const TREND_DAYS = 7;   // ventana para los KPI con comparación vs. período anterior
const WEEKLY_DAYS = 90; // ventana para las series semanales (usuarios, reservas, compras)

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

function rowsToSeries(report) {
  if (!report?.rows) return [];
  return report.rows.map(row => ({
    dims: row.dimensionValues.map(d => d.value),
    metrics: row.metricValues.map(m => Number(m.value))
  }));
}

// Reporte con dos dateRanges → separa filas de "date_range_0" (actual) y "date_range_1" (anterior),
// sumando sus métricas para devolver {current, previous} por cada métrica pedida.
function splitComparison(report, metricCount) {
  const totals = { current: new Array(metricCount).fill(0), previous: new Array(metricCount).fill(0) };
  (report?.rows || []).forEach(row => {
    const which = row.dimensionValues[row.dimensionValues.length - 1].value === 'date_range_0' ? 'current' : 'previous';
    row.metricValues.forEach((m, i) => { totals[which][i] += Number(m.value); });
  });
  return totals;
}

function pctChange(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export async function getDashboardData() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const token = await getAccessToken();

  const trendRanges = [
    { startDate: `${TREND_DAYS}daysAgo`, endDate: 'today' },
    { startDate: `${TREND_DAYS * 2}daysAgo`, endDate: `${TREND_DAYS + 1}daysAgo` }
  ];
  const weeklyRange = [{ startDate: `${WEEKLY_DAYS}daysAgo`, endDate: 'today' }];

  const [
    usersSessionsTrend, reservasTrend, purchasesTrend,
    usersByWeek, sessionsByChannel, deviceCategory,
    reservaConfirmada, purchases, topPages
  ] = await Promise.all([
    runReport(token, propertyId, {
      dateRanges: trendRanges,
      dimensions: [],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }]
    }),
    runReport(token, propertyId, {
      dateRanges: trendRanges,
      dimensions: [],
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'reserva_confirmada' } } },
      metrics: [{ name: 'eventCount' }]
    }),
    runReport(token, propertyId, {
      dateRanges: trendRanges,
      dimensions: [],
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'purchase' } } },
      metrics: [{ name: 'eventCount' }, { name: 'eventValue' }]
    }),
    runReport(token, propertyId, {
      dateRanges: weeklyRange,
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
      dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'deviceCategory' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }]
    }),
    runReport(token, propertyId, {
      dateRanges: weeklyRange,
      dimensions: [{ name: 'year' }, { name: 'week' }],
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'reserva_confirmada' } } },
      metrics: [{ name: 'eventCount' }],
      orderBys: [{ dimension: { dimensionName: 'year' } }, { dimension: { dimensionName: 'week' } }]
    }),
    runReport(token, propertyId, {
      dateRanges: weeklyRange,
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

  const usTrend = splitComparison(usersSessionsTrend, 2);
  const resTrend = splitComparison(reservasTrend, 1);
  const purTrend = splitComparison(purchasesTrend, 2);

  function kpi(current, previous) {
    return { current, previous, pct: pctChange(current, previous) };
  }

  const sessionsTotal = kpi(usTrend.current[1], usTrend.previous[1]);
  const reservasTotal = kpi(resTrend.current[0], resTrend.previous[0]);
  const purchasesTotal = kpi(purTrend.current[0], purTrend.previous[0]);

  return {
    kpis: {
      activeUsers: kpi(usTrend.current[0], usTrend.previous[0]),
      sessions: sessionsTotal,
      reservaConfirmada: reservasTotal,
      purchases: purchasesTotal,
      revenue: kpi(purTrend.current[1], purTrend.previous[1])
    },
    funnel: {
      sessions: sessionsTotal.current,
      reservaConfirmada: reservasTotal.current,
      purchases: purchasesTotal.current
    },
    usersByWeek: rowsToSeries(usersByWeek),
    sessionsByChannel: rowsToSeries(sessionsByChannel),
    deviceCategory: rowsToSeries(deviceCategory),
    reservaConfirmada: rowsToSeries(reservaConfirmada),
    purchases: rowsToSeries(purchases),
    topPages: rowsToSeries(topPages),
    trendDays: TREND_DAYS,
    weeklyDays: WEEKLY_DAYS,
    generatedAt: new Date().toISOString()
  };
}
