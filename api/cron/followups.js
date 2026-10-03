// Cron diario (ver vercel.json) — secuencia post-consulta de 2 mensajes:
//   día +2: check-in ("¿cómo te fue?")
//   día +7: pide feedback + invita a agendar el próximo control
// Protegido por CRON_SECRET: Vercel manda automáticamente
// "Authorization: Bearer $CRON_SECRET" en cada invocación programada.

import { getBookings, saveBookings, sendBookingEmail } from '../../lib/auth.js';

function daysSince(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr + 'T00:00:00Z').getTime();
  if (Number.isNaN(then)) return null;
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((todayUTC - then) / 86400000);
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'No autorizado' });
  }

  const bookings = await getBookings();
  let sent1 = 0, sent2 = 0, errors = [];

  for (const [date, slots] of Object.entries(bookings)) {
    for (const [time, b] of Object.entries(slots)) {
      if (!b || !b.paid || b.status !== 'confirmed' || !b.email) continue;
      const d = daysSince(b.dateStr || date);
      if (d === null) continue;

      try {
        if (d === 2 && !b.followup1Sent) {
          const r = await sendBookingEmail({
            kind: 'followup1',
            patient_name: b.name,
            patient_email: b.email,
            service: b.svc
          });
          if (r.ok) { b.followup1Sent = true; sent1++; }
          else errors.push({ bookingId: b.bookingId, step: 1, error: r.error });
        }
        if (d === 7 && !b.followup2Sent) {
          const r = await sendBookingEmail({
            kind: 'followup2',
            patient_name: b.name,
            patient_email: b.email
          });
          if (r.ok) { b.followup2Sent = true; sent2++; }
          else errors.push({ bookingId: b.bookingId, step: 2, error: r.error });
        }
      } catch (err) {
        errors.push({ bookingId: b.bookingId, error: err.message });
      }
    }
  }

  await saveBookings(bookings);
  return res.status(200).json({ ok: true, sent1, sent2, errors });
}
