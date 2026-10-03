// Cron diario (ver vercel.json) — secuencia post-consulta:
//   día +2  (nutrición + masaje): pedir reseña en Google
//   día +7  (solo masaje):        check-in + invitar a reagendar
//   día +30 (solo masaje):        cupón de reactivación de un solo uso,
//                                  únicamente si no volvió a reservar
// Protegido por CRON_SECRET: Vercel manda automáticamente
// "Authorization: Bearer $CRON_SECRET" en cada invocación programada.

import { getBookings, saveBookings, sendBookingEmail } from '../../lib/auth.js';
import { createOneTimeCoupon } from '../../lib/coupons.js';

const DISCOUNT_VALUE = 15; // % del cupón de reactivación

function daysSince(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr + 'T00:00:00Z').getTime();
  if (Number.isNaN(then)) return null;
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((todayUTC - then) / 86400000);
}

// ¿Esta paciente (por email) ya tiene otra reserva con fecha posterior a `afterDateStr`?
function hasLaterBooking(bookings, email, afterDateStr) {
  for (const slots of Object.values(bookings)) {
    for (const b of Object.values(slots)) {
      if (b && b.email === email && b.dateStr && b.dateStr > afterDateStr) return true;
    }
  }
  return false;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'No autorizado' });
  }

  const reviewUrl = process.env.GOOGLE_REVIEW_URL || null;
  const bookings = await getBookings();
  const counts = { review: 0, checkin: 0, discount: 0, discountSkipped: 0 };
  const errors = [];

  for (const slots of Object.values(bookings)) {
    for (const b of Object.values(slots)) {
      if (!b || !b.paid || b.status !== 'confirmed' || !b.email || !b.dateStr) continue;
      const d = daysSince(b.dateStr);
      if (d === null) continue;

      try {
        // Día +2 — pedir reseña (nutrición + masaje)
        if (d === 2 && !b.reviewRequestSent && reviewUrl) {
          const r = await sendBookingEmail({
            kind: 'review_request',
            patient_name: b.name,
            patient_email: b.email,
            service: b.svc,
            reviewUrl
          });
          if (r.ok) { b.reviewRequestSent = true; counts.review++; }
          else errors.push({ bookingId: b.bookingId, step: 'review', error: r.error });
        }

        if (b.type === 'masaje') {
          // Día +7 — check-in + invitar a reagendar
          if (d === 7 && !b.massageCheckinSent) {
            const r = await sendBookingEmail({
              kind: 'massage_checkin',
              patient_name: b.name,
              patient_email: b.email
            });
            if (r.ok) { b.massageCheckinSent = true; counts.checkin++; }
            else errors.push({ bookingId: b.bookingId, step: 'checkin', error: r.error });
          }

          // Día +30 — cupón de reactivación, solo si no volvió a reservar
          if (d === 30 && !b.massageDiscountSent) {
            if (hasLaterBooking(bookings, b.email, b.dateStr)) {
              b.massageDiscountSent = true;
              b.massageDiscountSkipped = true;
              counts.discountSkipped++;
            } else {
              const couponCode = await createOneTimeCoupon({ value: DISCOUNT_VALUE, expiresInDays: 14 });
              const r = await sendBookingEmail({
                kind: 'massage_discount',
                patient_name: b.name,
                patient_email: b.email,
                couponCode,
                discountValue: DISCOUNT_VALUE
              });
              if (r.ok) { b.massageDiscountSent = true; b.massageDiscountCoupon = couponCode; counts.discount++; }
              else errors.push({ bookingId: b.bookingId, step: 'discount', error: r.error });
            }
          }
        }
      } catch (err) {
        errors.push({ bookingId: b.bookingId, error: err.message });
      }
    }
  }

  await saveBookings(bookings);
  return res.status(200).json({ ok: true, reviewUrlConfigured: !!reviewUrl, counts, errors });
}
