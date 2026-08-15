// Rebrand concept — nav scroll state, mobile menu, scroll progress, reveal-on-scroll
document.addEventListener('DOMContentLoaded', () => {
  const nav = document.getElementById('rbNav');
  const prog = document.getElementById('rbProg');
  const burger = document.getElementById('rbBurger');
  const mmenu = document.getElementById('rbMmenu');
  const mclose = document.getElementById('rbMmenuClose');

  const onScroll = () => {
    const y = window.scrollY;
    if (nav) nav.classList.toggle('scrolled', y > 40);
    if (prog) {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      prog.style.width = (h > 0 ? (y / h) * 100 : 0) + '%';
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const toggleMenu = (open) => {
    if (!mmenu) return;
    mmenu.classList.toggle('open', open);
    document.body.style.overflow = open ? 'hidden' : '';
  };
  burger?.addEventListener('click', () => toggleMenu(true));
  mclose?.addEventListener('click', () => toggleMenu(false));
  mmenu?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => toggleMenu(false)));

  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
  document.querySelectorAll('.rb-reveal').forEach(el => io.observe(el));

  // subtle mouse-follow parallax on hero blob
  const media = document.querySelector('.rb-hero-media');
  if (media && window.matchMedia('(min-width: 981px)').matches) {
    media.addEventListener('mousemove', (e) => {
      const r = media.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      media.style.setProperty('--tx', (x * 10).toFixed(2) + 'px');
      media.style.setProperty('--ty', (y * 10).toFixed(2) + 'px');
      const img = media.querySelector('img');
      if (img) img.style.transform = `translate(${x * 10}px, ${y * 10}px) scale(1.03)`;
    });
    media.addEventListener('mouseleave', () => {
      const img = media.querySelector('img');
      if (img) img.style.transform = '';
    });
  }
});
