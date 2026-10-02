/* Google Analytics 4 — un solo lugar para el Measurement ID.
   Reemplazar GA4_ID por el real (formato G-XXXXXXXXXX) cuando se cree la propiedad en
   analytics.google.com. Hasta entonces este script no manda datos a ningún lado. */
(function () {
  var GA4_ID = 'G-XXXXXXXXXX'; // TODO: pegar acá el Measurement ID real

  if (!GA4_ID || GA4_ID.indexOf('XXXX') !== -1) return; // sin ID real, no cargar nada

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', GA4_ID);
})();
