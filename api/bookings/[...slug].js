// Dispatcher para /api/bookings/*
//
// PÚBLICOS (paciente):
//   POST /api/bookings/checkout            → crea booking pendiente en KV + preferencia MP
//   GET  /api/bookings/confirm?payment_id  → verifica con MP, marca paid, envía emails
//
// WEBHOOK (MercadoPago):
//   POST /api/bookings/webhook             → MP notifica cambios de estado del pago
//
// ADMIN (cookie ag_admin) — paths de un solo nivel porque Vercel no
// rutea sub-paths anidados al catch-all [...slug]:
//   POST   /api/bookings/admin-create     → crear booking manual (recovery, agendado por teléfono, etc.)
//   POST   /api/bookings/admin-confirm    → marcar booking como confirmed manualmente
//   POST   /api/bookings/admin-resend     → reenviar emails de una reserva
//   DELETE /api/bookings/admin-delete?date=X&time=Y → cancelar booking
//   GET    /api/bookings/admin-pending    → listar pendientes de pago

import {
  getBookings, saveBookings, generateBookingId, sendBookingEmail,
  getAdminFromRequest, readJsonBody, getUsers, saveUsers
} from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  let path = '';
  const slug = req.query?.slug;
  if (slug) {
    path = Array.isArray(slug) ? slug.join('/') : String(slug);
  } else if (req.url) {
    const u = new URL(req.url, 'http://x');
    path = u.pathname.replace(/^\/api\/bookings\/?/, '').replace(/\/$/, '');
  }
  const method = req.method;
  console.log('[bookings dispatcher]', method, 'path:', path);

  try {
    // === PÚBLICOS (paciente) ===
    if (path === 'checkout' && method === 'POST') return await handleCheckout(req, res);
    if (path === 'confirm'  && method === 'GET')  return await handleConfirm(req, res);

    // === WEBHOOK MP ===
    if (path === 'webhook' && (method === 'POST' || method === 'GET')) return await handleWebhook(req, res);

    // === ADMIN (paths planos porque Vercel no rutea sub-paths anidados al catch-all) ===
    if (path.startsWith('admin-')) {
      const session = getAdminFromRequest(req);
      if (!session?.admin) return res.status(401).json({ error: 'No autenticado' });

      if (path === 'admin-create'  && method === 'POST')   return await handleAdminCreate(req, res);
      if (path === 'admin-confirm' && method === 'POST')   return await handleAdminConfirm(req, res);
      if (path === 'admin-resend'  && method === 'POST')   return await handleAdminResend(req, res);
      if (path === 'admin-pending' && method === 'GET')    return await handleAdminPending(req, res);
      if (path === 'admin-delete'  && method === 'DELETE') return await handleAdminDelete(req, res);
    }

    return res.status(404).json({ error: 'Endpoint no encontrado', path, method });
  } catch (err) {
    console.error('[bookings dispatcher]', path, err);
    return res.status(500).json({ error: 'Error de servidor', detail: err.message });
  }
}

// === HANDLERS ===

async function handleCheckout(req, res) {
  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'Body inválido' });

  const { dateKey, time, dateStr, svc, dur, type, modality, name, email, phone, notes, amount } = body;
  if (!dateKey || !time || !svc || !name || !email || !amount) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }

  // 1. Verificar que el slot esté libre
  const bookings = await getBookings();
  if (bookings[dateKey] && bookings[dateKey][time]) {
    return res.status(409).json({ error: 'Ese horario ya fue reservado por otro paciente.' });
  }

  // 2. Crear booking pendiente en KV (APARTAR el slot)
  if (!bookings[dateKey]) bookings[dateKey] = {};
  const bookingId = generateBookingId();
  const modLabel = type === 'masaje' ? 'Presencial' : (modality === 'online' ? 'Online (videollamada)' : 'Presencial');
  bookings[dateKey][time] = {
    bookingId,
    dur: Number(dur) || 60,
    svc,
    name,
    email,
    phone: phone || '',
    notes: notes || '',
    modality: modLabel,
    paid: false,
    status: 'pending_payment',
    paymentAmount: Number(amount),
    paymentId: null,
    emailsSent: false,
    createdAt: new Date().toISOString(),
    paidAt: null,
    source: 'web',
    dateStr: dateStr || dateKey
  };
  await saveBookings(bookings);

  // 3. Crear preferencia de MercadoPago
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const IS_TEST  = process.env.MP_TEST === 'true';
  const SITE_URL = (process.env.SITE_URL || 'https://nutricionistaagustinavillegas.com').replace(/\/$/, '');
  if (!MP_TOKEN) return res.status(500).json({ error: 'MP no configurado' });

  const preference = {
    items: [{
      id: bookingId,
      title: `${svc} — ${modLabel} · ${dateStr || dateKey} ${time}`,
      quantity: 1,
      unit_price: Number(amount),
      currency_id: 'UYU'
    }],
    payer: { name, email },
    back_urls: {
      success: `${SITE_URL}/reservar?payment=success&bid=${bookingId}`,
      failure: `${SITE_URL}/reservar?payment=failure&bid=${bookingId}`,
      pending: `${SITE_URL}/reservar?payment=pending&bid=${bookingId}`
    },
    auto_return: 'approved',
    external_reference: bookingId,
    notification_url: `${SITE_URL}/api/bookings/webhook`,
    statement_descriptor: 'Agustina Villegas',
    expires: true,
    expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    payment_methods: {
      excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }]
    }
  };

  try {
    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MP_TOKEN}` },
      body: JSON.stringify(preference)
    });
    const data = await mpRes.json();
    if (!mpRes.ok) {
      // Liberar el slot si MP falló
      delete bookings[dateKey][time];
      if (Object.keys(bookings[dateKey]).length === 0) delete bookings[dateKey];
      await saveBookings(bookings);
      console.error('[checkout] MP error:', data);
      return res.status(mpRes.status).json({ error: data.message || 'Error en MercadoPago' });
    }
    const checkoutUrl = IS_TEST ? data.sandbox_init_point : data.init_point;
    return res.status(200).json({ id: data.id, init_point: checkoutUrl, bookingId });
  } catch (err) {
    delete bookings[dateKey][time];
    if (Object.keys(bookings[dateKey]).length === 0) delete bookings[dateKey];
    await saveBookings(bookings);
    return res.status(500).json({ error: err.message });
  }
}

// Confirma un pago: consulta MP, marca booking como paid, envía emails.
// Idempotente: si ya fue procesado, devuelve el estado actual sin duplicar emails.
async function handleConfirm(req, res) {
  const paymentId = req.query.payment_id;
  const bookingIdHint = req.query.bid; // hint opcional
  if (!paymentId) return res.status(400).json({ error: 'Falta payment_id' });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) return res.status(500).json({ error: 'MP no configurado' });

  // Consultar pago en MP
  const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${MP_TOKEN}` }
  });
  const payment = await mpRes.json();
  if (!mpRes.ok) return res.status(502).json({ error: 'Error consultando MP', detail: payment });

  const bookingId = payment.external_reference || bookingIdHint;
  if (!bookingId) return res.status(400).json({ error: 'No se pudo identificar la reserva' });

  // Buscar booking por bookingId
  const bookings = await getBookings();
  let foundDate = null, foundTime = null, foundBooking = null;
  for (const [d, slots] of Object.entries(bookings)) {
    for (const [t, b] of Object.entries(slots)) {
      if (b && b.bookingId === bookingId) {
        foundDate = d; foundTime = t; foundBooking = b;
        break;
      }
    }
    if (foundBooking) break;
  }
  if (!foundBooking) return res.status(404).json({ error: 'Booking no encontrado' });

  // Si ya está paid + emails enviados → devolver estado actual (idempotencia)
  if (foundBooking.paid && foundBooking.emailsSent) {
    return res.status(200).json({ status: 'already_processed', booking: foundBooking });
  }

  if (payment.status !== 'approved') {
    return res.status(200).json({ status: payment.status, message: `Pago en estado: ${payment.status}` });
  }

  // Marcar como paid
  foundBooking.paid = true;
  foundBooking.status = 'confirmed';
  foundBooking.paymentId = String(paymentId);
  foundBooking.paidAt = new Date().toISOString();

  // Enviar emails (si no se mandaron antes)
  let emailResult = { ok: false };
  if (!foundBooking.emailsSent) {
    emailResult = await sendBookingEmail({
      patient_name: foundBooking.name,
      patient_email: foundBooking.email,
      patient_phone: foundBooking.phone || 'No proporcionado',
      service: foundBooking.svc,
      date: foundBooking.dateStr,
      time: foundBooking.time || foundTime,
      modality: foundBooking.modality,
      payment_type: 'Pago vía MercadoPago',
      notes: foundBooking.notes || 'Sin notas adicionales'
    });
    if (emailResult.ok) foundBooking.emailsSent = true;
  }

  bookings[foundDate][foundTime] = foundBooking;
  await saveBookings(bookings);

  return res.status(200).json({
    status: 'confirmed',
    emails_sent: foundBooking.emailsSent,
    booking: foundBooking
  });
}

// Webhook de MercadoPago — se llama cuando hay actualización de pago
async function handleWebhook(req, res) {
  // MP manda info por query o body
  const topic = req.query.topic || req.query.type;
  const id = req.query.id || req.query['data.id'];
  let body = null;
  if (req.method === 'POST') {
    try { body = await readJsonBody(req); } catch {}
  }
  const paymentId = id || body?.data?.id;
  console.log('[webhook] topic:', topic, 'paymentId:', paymentId, 'body:', body);

  if (!paymentId || (topic && topic !== 'payment' && topic !== 'merchant_order')) {
    return res.status(200).json({ ok: true, message: 'Notif ignorada' });
  }

  // Reutilizar la lógica de confirm
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) return res.status(500).end();

  try {
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` }
    });
    const payment = await mpRes.json();
    if (!mpRes.ok || !payment.external_reference) {
      console.warn('[webhook] no se pudo verificar el pago', payment);
      return res.status(200).json({ ok: true, message: 'Pago no verificable' });
    }

    if (payment.status !== 'approved') {
      console.log('[webhook] pago no aprobado, estado:', payment.status);
      return res.status(200).json({ ok: true, status: payment.status });
    }

    const bookingId = payment.external_reference;
    const bookings = await getBookings();
    let found = null, foundDate = null, foundTime = null;
    for (const [d, slots] of Object.entries(bookings)) {
      for (const [t, b] of Object.entries(slots)) {
        if (b && b.bookingId === bookingId) { found = b; foundDate = d; foundTime = t; break; }
      }
      if (found) break;
    }
    if (!found) {
      console.warn('[webhook] booking no encontrado para id:', bookingId);
      return res.status(200).json({ ok: true, message: 'Booking no encontrado' });
    }

    if (found.paid && found.emailsSent) {
      return res.status(200).json({ ok: true, status: 'already_processed' });
    }

    found.paid = true;
    found.status = 'confirmed';
    found.paymentId = String(paymentId);
    found.paidAt = new Date().toISOString();

    if (!found.emailsSent) {
      const emailRes = await sendBookingEmail({
        patient_name: found.name,
        patient_email: found.email,
        patient_phone: found.phone || 'No proporcionado',
        service: found.svc,
        date: found.dateStr,
        time: found.time || foundTime,
        modality: found.modality,
        payment_type: 'Pago vía MercadoPago (webhook)',
        notes: found.notes || 'Sin notas adicionales'
      });
      if (emailRes.ok) found.emailsSent = true;
    }

    bookings[foundDate][foundTime] = found;
    await saveBookings(bookings);
    return res.status(200).json({ ok: true, status: 'confirmed' });
  } catch (err) {
    console.error('[webhook]', err);
    return res.status(200).json({ ok: true, message: 'Error pero ignorado para no retrasar reintentos MP' });
  }
}

// === ADMIN ===

async function handleAdminCreate(req, res) {
  const body = await readJsonBody(req);
  if (!body?.dateKey || !body?.time || !body?.booking) {
    return res.status(400).json({ error: 'Faltan dateKey, time o booking' });
  }
  const { dateKey, time, booking, sendEmails, useCredit } = body;
  const bookings = await getBookings();
  if (!bookings[dateKey]) bookings[dateKey] = {};
  if (bookings[dateKey][time]) {
    return res.status(409).json({ error: 'Ese slot ya tiene reserva. Borrá la existente primero.' });
  }

  // === CONSUMIR CREDITO si admin lo pidio ===
  let creditConsumed = false;
  let remainingCredits = null;
  if (useCredit) {
    const emailLower = String(booking.email || '').trim().toLowerCase();
    if (!emailLower) {
      return res.status(400).json({ error: 'Para descontar crédito hace falta el email del paciente.' });
    }
    const users = await getUsers();
    const user = users[emailLower];
    if (!user) {
      return res.status(404).json({ error: `No hay un paciente registrado con el email ${emailLower}. La paciente debe crear su cuenta primero, o desmarcá "descontar crédito".` });
    }
    if ((user.credits || 0) <= 0) {
      return res.status(403).json({ error: `${user.name || 'El paciente'} no tiene créditos disponibles. Desmarcá "descontar crédito" o activale créditos primero.` });
    }
    // Descontar 1 credito + agregar al historial del paciente
    user.credits = (user.credits || 0) - 1;
    user.bookings = user.bookings || [];
    user.bookings.push({
      service: booking.svc || 'Consulta',
      date: booking.dateStr || dateKey,
      time,
      status: 'upcoming',
      modality: booking.modality || 'Presencial',
      createdAt: new Date().toISOString()
    });
    users[emailLower] = user;
    await saveUsers(users);
    creditConsumed = true;
    remainingCredits = user.credits;
  }

  const bookingId = booking.bookingId || generateBookingId();
  const fullBooking = {
    bookingId,
    dur: Number(booking.dur) || 60,
    svc: booking.svc || 'Consulta',
    name: booking.name || '',
    email: booking.email || '',
    phone: booking.phone || '',
    notes: booking.notes || '',
    modality: booking.modality || 'Presencial',
    paid: creditConsumed ? true : (booking.paid === true),
    status: (creditConsumed || booking.paid) ? 'confirmed' : 'pending_payment',
    paymentAmount: Number(booking.paymentAmount) || 0,
    paymentId: booking.paymentId || null,
    paidWithCredit: creditConsumed,
    emailsSent: false,
    createdAt: booking.createdAt || new Date().toISOString(),
    paidAt: (creditConsumed || booking.paid) ? (booking.paidAt || new Date().toISOString()) : null,
    source: booking.source || 'admin',
    dateStr: booking.dateStr || dateKey
  };
  bookings[dateKey][time] = fullBooking;

  let emailResult = null;
  if (sendEmails) {
    emailResult = await sendBookingEmail({
      patient_name: fullBooking.name,
      patient_email: fullBooking.email,
      patient_phone: fullBooking.phone || 'No proporcionado',
      service: fullBooking.svc,
      date: fullBooking.dateStr,
      time: time,
      modality: fullBooking.modality,
      payment_type: creditConsumed
        ? `Crédito de plan (1 consumido, le quedan ${remainingCredits})`
        : (fullBooking.paid ? 'Pago confirmado (registrado manualmente)' : 'Reserva sin pago'),
      notes: fullBooking.notes || 'Sin notas adicionales'
    });
    if (emailResult.ok) fullBooking.emailsSent = true;
  }

  await saveBookings(bookings);
  return res.status(200).json({
    ok: true,
    booking: fullBooking,
    emailResult,
    creditConsumed,
    remainingCredits
  });
}

async function handleAdminConfirm(req, res) {
  const body = await readJsonBody(req);
  if (!body?.dateKey || !body?.time) return res.status(400).json({ error: 'Faltan dateKey y time' });
  const bookings = await getBookings();
  const b = bookings[body.dateKey]?.[body.time];
  if (!b) return res.status(404).json({ error: 'Booking no encontrado' });
  b.paid = true;
  b.status = 'confirmed';
  b.paidAt = b.paidAt || new Date().toISOString();
  bookings[body.dateKey][body.time] = b;
  await saveBookings(bookings);
  return res.status(200).json({ ok: true, booking: b });
}

async function handleAdminResend(req, res) {
  const body = await readJsonBody(req);
  if (!body?.dateKey || !body?.time) return res.status(400).json({ error: 'Faltan dateKey y time' });
  const bookings = await getBookings();
  const b = bookings[body.dateKey]?.[body.time];
  if (!b) return res.status(404).json({ error: 'Booking no encontrado' });
  const emailRes = await sendBookingEmail({
    patient_name: b.name,
    patient_email: b.email,
    patient_phone: b.phone || 'No proporcionado',
    service: b.svc,
    date: b.dateStr || body.dateKey,
    time: body.time,
    modality: b.modality,
    payment_type: b.paid ? 'Reenvío — pago confirmado' : 'Reenvío — pendiente de pago',
    notes: b.notes || 'Sin notas adicionales'
  });
  if (emailRes.ok) {
    b.emailsSent = true;
    bookings[body.dateKey][body.time] = b;
    await saveBookings(bookings);
  }
  return res.status(emailRes.ok ? 200 : 500).json({ ok: emailRes.ok, error: emailRes.error });
}

async function handleAdminPending(req, res) {
  const bookings = await getBookings();
  const pending = [];
  for (const [d, slots] of Object.entries(bookings)) {
    for (const [t, b] of Object.entries(slots)) {
      if (b && b.status === 'pending_payment') {
        pending.push({ dateKey: d, time: t, ...b });
      }
    }
  }
  pending.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return res.status(200).json({ pending });
}

async function handleAdminDelete(req, res) {
  const dateKey = req.query.date;
  const time = req.query.time;
  if (!dateKey || !time) return res.status(400).json({ error: 'Faltan ?date y ?time' });
  const bookings = await getBookings();
  if (!bookings[dateKey]?.[time]) return res.status(404).json({ error: 'No encontrado' });
  delete bookings[dateKey][time];
  if (Object.keys(bookings[dateKey]).length === 0) delete bookings[dateKey];
  await saveBookings(bookings);
  return res.status(200).json({ ok: true });
}
