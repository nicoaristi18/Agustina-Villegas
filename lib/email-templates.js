// Templates HTML para emails transaccionales (Resend).
// Tres variantes:
//   - confirmation: reserva pagada/confirmada
//   - reminder:     recordatorio de pago con link MP + datos bancarios
//   - manual:       reserva creada por admin (con o sin pago)
//
// Todos los templates inlinean CSS porque los clientes de email
// (Gmail, Outlook, Apple Mail) ignoran <style> externos / clases.

const BRAND_GOLD   = '#BA7517';
const BRAND_GREEN  = '#7A9E7E';
const BRAND_DARK   = '#3D2817';
const BRAND_CREAM  = '#FBF7F0';
const BORDER       = '#E8DDC9';
const TEXT_MUTED   = '#7A6B5C';
const WHATSAPP     = '+598 99 712 691';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Layout común: header con título + status badge, body, footer con contacto.
function baseLayout({ headerColor, badgeText, badgeEmoji, title, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#F5F0E6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND_DARK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F0E6;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(61,40,23,0.08);">
          <tr>
            <td style="background:${headerColor};padding:32px 32px 24px 32px;text-align:center;">
              <div style="color:#ffffff;font-size:13px;letter-spacing:2px;text-transform:uppercase;font-weight:600;opacity:0.85;margin-bottom:8px;">Lic. Agustina Villegas</div>
              <div style="color:#ffffff;font-size:11px;letter-spacing:1px;opacity:0.7;margin-bottom:20px;">Nutricionista</div>
              <div style="display:inline-block;background:rgba(255,255,255,0.18);padding:10px 20px;border-radius:24px;color:#ffffff;font-size:16px;font-weight:600;">
                ${badgeEmoji} ${escapeHtml(badgeText)}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="background:${BRAND_CREAM};padding:24px 32px;border-top:1px solid ${BORDER};text-align:center;">
              <div style="color:${TEXT_MUTED};font-size:13px;line-height:1.6;">
                ¿Tenés dudas o necesitás cambiar el horario?<br>
                Escribinos por WhatsApp:
                <a href="https://wa.me/59899712691" style="color:${BRAND_GOLD};font-weight:600;text-decoration:none;">${WHATSAPP}</a>
              </div>
              <div style="margin-top:16px;padding-top:16px;border-top:1px solid ${BORDER};color:${TEXT_MUTED};font-size:11px;">
                © Lic. Agustina Villegas — Nutricionista<br>
                <a href="https://nutricionistaagustinavillegas.com" style="color:${TEXT_MUTED};text-decoration:underline;">nutricionistaagustinavillegas.com</a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Bloque con los detalles de la reserva (servicio, fecha, hora, modalidad)
function reservationDetailsBlock({ service, date, time, modality }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND_CREAM};border-radius:8px;border:1px solid ${BORDER};margin:0 0 24px 0;">
      <tr>
        <td style="padding:20px 24px;">
          <div style="color:${TEXT_MUTED};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:600;margin-bottom:14px;">Detalles de la reserva</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding:6px 0;color:${TEXT_MUTED};font-size:13px;width:90px;">Servicio</td><td style="padding:6px 0;color:${BRAND_DARK};font-size:14px;font-weight:600;">${escapeHtml(service)}</td></tr>
            <tr><td style="padding:6px 0;color:${TEXT_MUTED};font-size:13px;">Fecha</td><td style="padding:6px 0;color:${BRAND_DARK};font-size:14px;font-weight:600;">${escapeHtml(date)}</td></tr>
            <tr><td style="padding:6px 0;color:${TEXT_MUTED};font-size:13px;">Hora</td><td style="padding:6px 0;color:${BRAND_DARK};font-size:14px;font-weight:600;">${escapeHtml(time)}</td></tr>
            <tr><td style="padding:6px 0;color:${TEXT_MUTED};font-size:13px;">Modalidad</td><td style="padding:6px 0;color:${BRAND_DARK};font-size:14px;font-weight:600;">${escapeHtml(modality)}</td></tr>
          </table>
        </td>
      </tr>
    </table>`;
}

// === CONFIRMATION ===
// Para reservas pagadas/confirmadas (vía MP, crédito, o manual con paid=true)
export function confirmationTemplate({ name, service, date, time, modality, paymentType, isOnline }) {
  const firstName = (name || '').trim().split(' ')[0] || 'paciente';
  const greeting = `¡Hola ${escapeHtml(firstName)}! 👋`;
  const onlineNote = isOnline
    ? `<p style="margin:0 0 16px 0;color:${BRAND_DARK};font-size:14px;line-height:1.6;background:#EEF7F0;padding:14px 16px;border-radius:8px;border-left:3px solid ${BRAND_GREEN};">📹 <strong>Consulta online:</strong> te vamos a enviar el link de la videollamada por WhatsApp unos minutos antes del horario.</p>`
    : `<p style="margin:0 0 16px 0;color:${BRAND_DARK};font-size:14px;line-height:1.6;background:${BRAND_CREAM};padding:14px 16px;border-radius:8px;border-left:3px solid ${BRAND_GOLD};">📍 <strong>Consulta presencial.</strong> Si necesitás la dirección, escribinos por WhatsApp.</p>`;

  const body = `
    <h1 style="margin:0 0 12px 0;color:${BRAND_DARK};font-size:22px;font-weight:600;">${greeting}</h1>
    <p style="margin:0 0 24px 0;color:${BRAND_DARK};font-size:15px;line-height:1.6;">Tu reserva quedó <strong style="color:${BRAND_GREEN};">confirmada</strong>. Te esperamos en el horario acordado.</p>
    ${reservationDetailsBlock({ service, date, time, modality })}
    ${onlineNote}
    ${paymentType ? `<p style="margin:0 0 8px 0;color:${TEXT_MUTED};font-size:12px;">Forma de pago: ${escapeHtml(paymentType)}</p>` : ''}
    <p style="margin:24px 0 0 0;color:${BRAND_DARK};font-size:14px;line-height:1.6;">¡Nos vemos pronto! 🌿</p>`;

  return {
    subject: `✅ Tu reserva está confirmada — ${date} ${time}`,
    html: baseLayout({
      headerColor: BRAND_GREEN,
      badgeText: 'Reserva confirmada',
      badgeEmoji: '✅',
      title: 'Tu reserva está confirmada',
      bodyHtml: body
    })
  };
}

// === REMINDER ===
// Recordatorio de pago. Incluye link MP + datos bancarios para transferencia.
export function reminderTemplate({ name, service, date, time, modality, paymentLink, amount }) {
  const firstName = (name || '').trim().split(' ')[0] || '';
  const greeting = firstName ? `¡Hola ${escapeHtml(firstName)}!` : '¡Hola!';
  const amountStr = amount ? `$${Number(amount).toLocaleString('es-UY')} UYU` : '';

  const body = `
    <h1 style="margin:0 0 12px 0;color:${BRAND_DARK};font-size:22px;font-weight:600;">${greeting}</h1>
    <p style="margin:0 0 16px 0;color:${BRAND_DARK};font-size:15px;line-height:1.6;">
      Vimos que estuviste intentando reservar tu turno pero <strong>aún no completaste el pago</strong>. Tu horario sigue apartado, pero necesitamos que termines el pago para confirmar tu reserva.
    </p>
    <p style="margin:0 0 24px 0;color:${BRAND_GOLD};font-size:14px;line-height:1.6;font-weight:600;background:#FFF6E8;padding:12px 16px;border-radius:8px;border-left:3px solid ${BRAND_GOLD};">
      ⏱ Tenés <strong>48 horas</strong> para terminar el pago. Sino, el horario va a quedar liberado.
    </p>

    ${reservationDetailsBlock({ service, date, time, modality })}
    ${amountStr ? `<p style="margin:0 0 24px 0;color:${BRAND_DARK};font-size:15px;text-align:center;background:${BRAND_CREAM};padding:14px;border-radius:8px;"><span style="color:${TEXT_MUTED};font-size:12px;text-transform:uppercase;letter-spacing:1px;">Monto a pagar</span><br><strong style="font-size:24px;color:${BRAND_GOLD};">${amountStr}</strong></p>` : ''}

    <!-- OPCIÓN 1: MercadoPago -->
    <div style="margin:0 0 20px 0;padding:20px;background:#ffffff;border:2px solid ${BRAND_GOLD};border-radius:10px;">
      <div style="display:inline-block;background:${BRAND_GOLD};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:1.5px;padding:4px 10px;border-radius:4px;margin-bottom:12px;">OPCIÓN 1 · ONLINE</div>
      <h2 style="margin:0 0 8px 0;color:${BRAND_DARK};font-size:17px;font-weight:600;">💳 Pagar con MercadoPago</h2>
      <p style="margin:0 0 16px 0;color:${TEXT_MUTED};font-size:13px;line-height:1.5;">La forma más rápida. Tu reserva queda confirmada automáticamente.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
        <tr>
          <td style="background:${BRAND_GOLD};border-radius:8px;">
            <a href="${escapeHtml(paymentLink)}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:0.3px;">Pagar ahora →</a>
          </td>
        </tr>
      </table>
      <p style="margin:14px 0 0 0;color:${TEXT_MUTED};font-size:11px;text-align:center;word-break:break-all;">o copiá este link: ${escapeHtml(paymentLink)}</p>
    </div>

    <!-- OPCIÓN 2: Transferencia -->
    <div style="margin:0 0 20px 0;padding:20px;background:#ffffff;border:2px solid ${BORDER};border-radius:10px;">
      <div style="display:inline-block;background:${BRAND_DARK};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:1.5px;padding:4px 10px;border-radius:4px;margin-bottom:12px;">OPCIÓN 2 · TRANSFERENCIA</div>
      <h2 style="margin:0 0 16px 0;color:${BRAND_DARK};font-size:17px;font-weight:600;">🏦 Transferencia bancaria</h2>

      <!-- BROU -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND_CREAM};border-radius:8px;margin-bottom:12px;">
        <tr><td style="padding:14px 16px;">
          <div style="color:${BRAND_DARK};font-size:15px;font-weight:600;margin-bottom:8px;">🏛 Banco BROU</div>
          <div style="font-size:13px;color:${BRAND_DARK};line-height:1.7;">
            <div><span style="color:${TEXT_MUTED};">Cuenta actual:</span> <strong style="font-family:'Courier New',monospace;">001725785-00001</strong></div>
            <div><span style="color:${TEXT_MUTED};">Cuenta anterior:</span> <strong style="font-family:'Courier New',monospace;">178-1539492</strong></div>
            <div><span style="color:${TEXT_MUTED};">Otros bancos:</span> <strong style="font-family:'Courier New',monospace;">00172578500001</strong></div>
          </div>
        </td></tr>
      </table>

      <!-- Itaú -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND_CREAM};border-radius:8px;margin-bottom:12px;">
        <tr><td style="padding:14px 16px;">
          <div style="color:${BRAND_DARK};font-size:15px;font-weight:600;margin-bottom:8px;">🏛 Banco Itaú</div>
          <div style="font-size:13px;color:${BRAND_DARK};line-height:1.7;">
            <div><span style="color:${TEXT_MUTED};">Cuenta:</span> <strong style="font-family:'Courier New',monospace;">0746764</strong></div>
          </div>
        </td></tr>
      </table>

      <p style="margin:14px 0 0 0;color:${BRAND_DARK};font-size:13px;line-height:1.6;background:#FFF6E8;padding:12px;border-radius:6px;">
        📲 Una vez realizada la transferencia, mandanos el comprobante por WhatsApp al
        <a href="https://wa.me/59899712691" style="color:${BRAND_GOLD};font-weight:600;text-decoration:none;">${WHATSAPP}</a>
        para confirmar tu reserva.
      </p>
    </div>

    <p style="margin:24px 0 0 0;color:${TEXT_MUTED};font-size:13px;line-height:1.6;text-align:center;">¿Tenés alguna duda? Estamos para ayudarte 🌿</p>`;

  return {
    subject: `⏳ Recordatorio — Completá el pago de tu reserva (${date} ${time})`,
    html: baseLayout({
      headerColor: BRAND_GOLD,
      badgeText: 'Falta completar el pago',
      badgeEmoji: '⏳',
      title: 'Recordatorio de pago',
      bodyHtml: body
    })
  };
}

// === MANUAL ===
// Reserva creada por admin sin pago confirmado (ej: agendado por teléfono,
// pendiente de coordinar el pago). No incluye links MP — Agustina arregla por afuera.
export function manualTemplate({ name, service, date, time, modality, notes, isOnline }) {
  const firstName = (name || '').trim().split(' ')[0] || 'paciente';
  const onlineNote = isOnline
    ? `<p style="margin:0 0 16px 0;color:${BRAND_DARK};font-size:14px;line-height:1.6;background:#EEF7F0;padding:14px 16px;border-radius:8px;border-left:3px solid ${BRAND_GREEN};">📹 <strong>Consulta online:</strong> te vamos a enviar el link de la videollamada por WhatsApp unos minutos antes.</p>`
    : `<p style="margin:0 0 16px 0;color:${BRAND_DARK};font-size:14px;line-height:1.6;background:${BRAND_CREAM};padding:14px 16px;border-radius:8px;border-left:3px solid ${BRAND_GOLD};">📍 <strong>Consulta presencial.</strong> Si necesitás la dirección, escribinos por WhatsApp.</p>`;

  const body = `
    <h1 style="margin:0 0 12px 0;color:${BRAND_DARK};font-size:22px;font-weight:600;">¡Hola ${escapeHtml(firstName)}!</h1>
    <p style="margin:0 0 24px 0;color:${BRAND_DARK};font-size:15px;line-height:1.6;">Tu reserva quedó <strong>registrada</strong> en nuestra agenda. Te esperamos en el horario acordado.</p>
    ${reservationDetailsBlock({ service, date, time, modality })}
    ${onlineNote}
    ${notes && notes !== 'Sin notas adicionales' ? `<p style="margin:0 0 16px 0;color:${TEXT_MUTED};font-size:13px;line-height:1.6;background:${BRAND_CREAM};padding:12px 16px;border-radius:8px;"><strong>Notas:</strong> ${escapeHtml(notes)}</p>` : ''}
    <p style="margin:24px 0 0 0;color:${BRAND_DARK};font-size:14px;line-height:1.6;">¡Nos vemos pronto! 🌿</p>`;

  return {
    subject: `📅 Tu reserva está registrada — ${date} ${time}`,
    html: baseLayout({
      headerColor: BRAND_GOLD,
      badgeText: 'Reserva registrada',
      badgeEmoji: '📅',
      title: 'Tu reserva está registrada',
      bodyHtml: body
    })
  };
}

// === SURVEY ===
// Encuesta de bienvenida — la admin la dispara desde el panel para pacientes
// nuevas, antes de la primera consulta. Link al Google Form de Agustina.
export function surveyTemplate({ name, surveyUrl }) {
  const firstName = (name || '').trim().split(' ')[0] || 'paciente';

  const body = `
    <h1 style="margin:0 0 12px 0;color:${BRAND_DARK};font-size:22px;font-weight:600;">¡Hola ${escapeHtml(firstName)}! 🌿</h1>
    <p style="margin:0 0 16px 0;color:${BRAND_DARK};font-size:15px;line-height:1.6;">
      Soy <strong>Agustina</strong>, tu nutricionista. ¡Qué alegría empezar este proceso con vos!
    </p>
    <p style="margin:0 0 24px 0;color:${BRAND_DARK};font-size:15px;line-height:1.6;">
      Antes de nuestra primera consulta, me gustaría conocerte un poquito mejor. Por eso te invito a completar este formulario corto — me va a permitir <strong>preparar la consulta a tu medida</strong> y aprovechar al máximo el tiempo que tengamos juntas.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
      <tr>
        <td align="center" style="padding:8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="background:${BRAND_GOLD};border-radius:8px;">
                <a href="${escapeHtml(surveyUrl)}" style="display:inline-block;padding:16px 36px;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;letter-spacing:0.3px;">Completar formulario →</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 16px 0;color:${TEXT_MUTED};font-size:13px;line-height:1.6;text-align:center;">
      Te lleva entre <strong>5 y 10 minutos</strong>. Toda la información que compartas es confidencial.
    </p>

    <div style="margin:24px 0;padding:16px 20px;background:${BRAND_CREAM};border-radius:8px;border-left:3px solid ${BRAND_GOLD};">
      <p style="margin:0;color:${BRAND_DARK};font-size:13px;line-height:1.6;">
        💡 <strong>Tip:</strong> Completá el formulario unos días antes de la consulta. Así puedo revisarlo con tiempo y llegar preparada para tu caso.
      </p>
    </div>

    <p style="margin:24px 0 0 0;color:${BRAND_DARK};font-size:14px;line-height:1.6;">
      Si tenés cualquier duda, escribime por WhatsApp.
    </p>
    <p style="margin:8px 0 0 0;color:${BRAND_DARK};font-size:14px;line-height:1.6;">
      ¡Nos vemos pronto! 🌿<br>
      <strong>Lic. Agustina Villegas</strong>
    </p>`;

  return {
    subject: `🌿 Antes de tu primera consulta — conoceme un poco`,
    html: baseLayout({
      headerColor: BRAND_GREEN,
      badgeText: 'Encuesta de bienvenida',
      badgeEmoji: '🌿',
      title: 'Antes de tu primera consulta',
      bodyHtml: body
    })
  };
}
