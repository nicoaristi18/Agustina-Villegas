// Helpers para leer datos de Instagram (Graph API) desde el servidor.
// Requiere las env vars INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_USER_ID (Vercel → Settings →
// Environment Variables). El token sale del panel de Meta for Developers (app con producto
// "Instagram API", cuenta agregada como tester, botón "Generar identificador").
// IMPORTANTE: este tipo de token vence — si el dashboard empieza a devolver error de
// autenticación, hay que regenerarlo desde developers.facebook.com y actualizar la env var.

const API = 'https://graph.instagram.com/v22.0';
const TREND_DAYS = 7;
const FOLLOWER_DAYS = 56; // ventana para el gráfico de seguidores por semana

export function instagramConfigured() {
  return !!(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_USER_ID);
}

async function igFetch(path, params) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const url = new URL(`${API}/${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', token);
  const r = await fetch(url);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || 'Error consultando Instagram');
  return data;
}

function unixDaysAgo(days) {
  return Math.floor((Date.now() - days * 86400000) / 1000);
}

function pctChange(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export async function getInstagramDashboardData() {
  const userId = process.env.INSTAGRAM_USER_ID;

  const [profile, trendCurrent, trendPrevious, followerSeries, media] = await Promise.all([
    igFetch(userId, { fields: 'username,followers_count,media_count' }),
    igFetch(`${userId}/insights`, {
      metric: 'reach,profile_views,accounts_engaged,website_clicks',
      period: 'day', metric_type: 'total_value',
      since: unixDaysAgo(TREND_DAYS), until: unixDaysAgo(0)
    }),
    igFetch(`${userId}/insights`, {
      metric: 'reach,profile_views,accounts_engaged,website_clicks',
      period: 'day', metric_type: 'total_value',
      since: unixDaysAgo(TREND_DAYS * 2), until: unixDaysAgo(TREND_DAYS)
    }),
    igFetch(`${userId}/insights`, {
      metric: 'follower_count', period: 'day',
      since: unixDaysAgo(FOLLOWER_DAYS), until: unixDaysAgo(0)
    }),
    igFetch(`${userId}/media`, {
      fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
      limit: 50
    })
  ]);

  function metricMap(report) {
    const map = {};
    (report.data || []).forEach(m => { map[m.name] = m.total_value?.value || 0; });
    return map;
  }
  const cur = metricMap(trendCurrent);
  const prev = metricMap(trendPrevious);
  function kpi(name) { return { current: cur[name] || 0, previous: prev[name] || 0, pct: pctChange(cur[name] || 0, prev[name] || 0) }; }

  // Agrupar el follower_count diario (delta neto) en semanas para graficar
  const dailyFollowers = (followerSeries.data?.[0]?.values || []).map(v => ({
    date: v.end_time.slice(0, 10), delta: v.value
  }));
  const weekMap = {};
  dailyFollowers.forEach(d => {
    const dt = new Date(d.date);
    const jan1 = new Date(dt.getFullYear(), 0, 1);
    const week = Math.ceil((((dt - jan1) / 86400000) + jan1.getDay() + 1) / 7);
    const key = `${dt.getFullYear()}-${String(week).padStart(2, '0')}`;
    weekMap[key] = (weekMap[key] || 0) + d.delta;
  });
  const followersByWeek = Object.keys(weekMap).sort().map(k => ({ week: k.split('-')[1], delta: weekMap[k] }));

  // Top publicaciones de los últimos 28 días por interacción (likes + comentarios)
  const cutoff = Date.now() - 28 * 86400000;
  const topMedia = (media.data || [])
    .filter(m => new Date(m.timestamp).getTime() >= cutoff)
    .map(m => ({ ...m, engagement: (m.like_count || 0) + (m.comments_count || 0) }))
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 5);

  return {
    profile: { username: profile.username, followersCount: profile.followers_count, mediaCount: profile.media_count },
    kpis: { reach: kpi('reach'), profileViews: kpi('profile_views'), accountsEngaged: kpi('accounts_engaged'), websiteClicks: kpi('website_clicks') },
    followersByWeek,
    topMedia,
    trendDays: TREND_DAYS,
    generatedAt: new Date().toISOString()
  };
}
