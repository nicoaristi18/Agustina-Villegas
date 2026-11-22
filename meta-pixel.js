/* Píxel de Meta (Instagram + Facebook Ads) — un solo lugar para el ID.
   Reemplazar META_PIXEL_ID por el ID real (solo números) cuando Agustina cree la cuenta
   publicitaria en business.facebook.com. Hasta entonces este script no carga nada y
   window.trackMeta() no hace nada, así que las páginas lo pueden llamar sin romperse.

   Eventos que manda el sitio:
   - PageView          → en cada página que incluye este script (automático)
   - ViewContent       → runners.html (página de la guía) y planes.html
   - InitiateCheckout  → al abrir la compra de la guía, elegir un combo o un plan
   - Purchase          → compra de la guía (comprado.html) y de un plan (mi-cuenta.html)
   - Schedule          → reserva de turno pagada (reservar.html)
   - Contact           → clic en cualquier link de WhatsApp
   No se manda ningún dato personal (ni nombre, ni email, ni teléfono). */
(function () {
  var META_PIXEL_ID = 'XXXXXXXXXXXXXXX';

  window.trackMeta = function () {}; // sin ID real, no hace nada
  if (!META_PIXEL_ID || META_PIXEL_ID.indexOf('XXXX') !== -1) return;

  /* Código base oficial de Meta */
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0';
    n.queue = []; t = b.createElement(e); t.async = !0;
    t.src = v; s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  fbq('init', META_PIXEL_ID);
  fbq('track', 'PageView');

  // eventId: mismo identificador de la compra, para que Meta no la cuente dos veces.
  window.trackMeta = function (event, params, eventId) {
    try {
      if (eventId) fbq('track', event, params || {}, { eventID: String(eventId) });
      else fbq('track', event, params || {});
    } catch (err) { /* nunca romper la página por la medición */ }
  };

  // Clic en WhatsApp → Contact (muchos pacientes escriben directo, sin comprar en la web)
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href*="wa.me"], a[href*="api.whatsapp.com"]') : null;
    if (a) window.trackMeta('Contact', { content_name: 'whatsapp', content_category: location.pathname });
  }, true);
})();
