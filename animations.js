/* ═══════════════════════════════════════════════════
   animations.js — Agustina Villegas Premium Effects
   ═══════════════════════════════════════════════════ */
(function () {
  'use strict';

  var isMobile = window.matchMedia('(max-width:900px)').matches
    || ('ontouchstart' in window);

  /* ─────────────────────────────────────────────────
     SCROLL PROGRESS BAR
  ───────────────────────────────────────────────── */
  var prog = document.createElement('div');
  prog.id = 'scroll-prog';
  document.body.prepend(prog);

  function updateProgress() {
    var max = document.body.scrollHeight - window.innerHeight;
    var pct = max > 0 ? (window.scrollY / max) * 100 : 0;
    prog.style.width = Math.min(pct, 100) + '%';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });

  /* ─────────────────────────────────────────────────
     CUSTOM CURSOR (desktop only)
  ───────────────────────────────────────────────── */
  if (!isMobile) {
    var dot  = document.createElement('div');
    dot.className = 'cur-dot';
    var ring = document.createElement('div');
    ring.className = 'cur-ring';
    document.body.append(dot, ring);

    var mx = window.innerWidth / 2, my = window.innerHeight / 2;
    var rx = mx, ry = my;

    document.addEventListener('mousemove', function (e) {
      mx = e.clientX; my = e.clientY;
      dot.style.left = mx + 'px';
      dot.style.top  = my + 'px';
    });

    /* ring follows with slight lag */
    (function tick() {
      rx += (mx - rx) * 0.13;
      ry += (my - ry) * 0.13;
      ring.style.left = rx.toFixed(1) + 'px';
      ring.style.top  = ry.toFixed(1) + 'px';
      requestAnimationFrame(tick);
    })();

    /* grow on interactive elements */
    var hoverEls = document.querySelectorAll(
      'a, button, [role="button"], .preview-card, .plan-card, .nut-card, .mas-card, .wa-float'
    );
    hoverEls.forEach(function (el) {
      el.addEventListener('mouseenter', function () { document.body.classList.add('cur-grow'); });
      el.addEventListener('mouseleave', function () { document.body.classList.remove('cur-grow'); });
    });

    /* hide when leaving window */
    document.addEventListener('mouseleave', function () {
      dot.style.opacity = '0'; ring.style.opacity = '0';
    });
    document.addEventListener('mouseenter', function () {
      dot.style.opacity = '1'; ring.style.opacity = '1';
    });
  }

  /* ─────────────────────────────────────────────────
     MAGNETIC BUTTONS (desktop only)
  ───────────────────────────────────────────────── */
  if (!isMobile) {
    document.querySelectorAll('.btn-primary, .btn-outline, .nav-cta').forEach(function (btn) {
      btn.addEventListener('mousemove', function (e) {
        var r = btn.getBoundingClientRect();
        var x = (e.clientX - r.left - r.width  / 2) * 0.2;
        var y = (e.clientY - r.top  - r.height / 2) * 0.2;
        btn.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      });
      btn.addEventListener('mouseleave', function () {
        btn.style.transform = '';
      });
    });
  }

  /* ─────────────────────────────────────────────────
     3-D CARD TILT (desktop only)
  ───────────────────────────────────────────────── */
  if (!isMobile) {
    var tiltCards = document.querySelectorAll(
      '.preview-card, .plan-card, .nut-card:not(.main), .mas-card, .credits-info'
    );
    tiltCards.forEach(function (card) {
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var x = ((e.clientX - r.left) / r.width  - 0.5) * 2;
        var y = ((e.clientY - r.top)  / r.height - 0.5) * 2;
        card.style.setProperty('--ry', (x * 5.5) + 'deg');
        card.style.setProperty('--rx', (-y * 5.5) + 'deg');
      });
      card.addEventListener('mouseleave', function () {
        card.style.setProperty('--ry', '0deg');
        card.style.setProperty('--rx', '0deg');
      });
    });
  }

  /* ─────────────────────────────────────────────────
     PARALLAX — hero right image
  ───────────────────────────────────────────────── */
  var heroRight = document.querySelector('.hero-right');
  if (heroRight && !isMobile) {
    window.addEventListener('scroll', function () {
      heroRight.style.transform = 'translateY(' + (window.scrollY * 0.13) + 'px)';
    }, { passive: true });
  }

  /* ─────────────────────────────────────────────────
     SCROLL REVEAL (shared IntersectionObserver)
     — adds .visible to every .reveal element on page
  ───────────────────────────────────────────────── */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        io.unobserve(entry.target);        /* fire once */
      }
    });
  }, { threshold: 0.08 });

  document.querySelectorAll('.reveal').forEach(function (el) {
    io.observe(el);
  });

  /* ─────────────────────────────────────────────────
     NAV SCROLL STATE
  ───────────────────────────────────────────────── */
  var nav = document.getElementById('nav');
  if (nav) {
    function toggleNav() {
      nav.classList.toggle('scrolled', window.scrollY > 50);
    }
    window.addEventListener('scroll', toggleNav, { passive: true });
    toggleNav();
  }

  /* ─────────────────────────────────────────────────
     STAGGER ANIMATION — hero eyebrow / h1 / desc
     Adds a subtle letter-spacing entrance to the hero
  ───────────────────────────────────────────────── */
  var eyebrow = document.querySelector('.hero-eyebrow');
  if (eyebrow) {
    eyebrow.style.opacity = '0';
    eyebrow.style.transform = 'translateY(12px)';
    eyebrow.style.transition = 'opacity .7s .15s ease, transform .7s .15s ease';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        eyebrow.style.opacity = '1';
        eyebrow.style.transform = 'translateY(0)';
      });
    });
  }

  /* ─────────────────────────────────────────────────
     MARQUEE — pause on hover
  ───────────────────────────────────────────────── */
  var mTrack = document.querySelector('.marquee-track');
  if (mTrack) {
    mTrack.parentElement.addEventListener('mouseenter', function () {
      mTrack.style.animationPlayState = 'paused';
    });
    mTrack.parentElement.addEventListener('mouseleave', function () {
      mTrack.style.animationPlayState = 'running';
    });
  }

  /* ─────────────────────────────────────────────────
     COUNTER ANIMATION — any [data-count] element
  ───────────────────────────────────────────────── */
  var countEls = document.querySelectorAll('[data-count]');
  if (countEls.length) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el    = entry.target;
        var target = parseFloat(el.dataset.count);
        var start  = 0;
        var dur    = 1400;
        var t0     = null;
        function step(ts) {
          if (!t0) t0 = ts;
          var progress = Math.min((ts - t0) / dur, 1);
          var ease = 1 - Math.pow(1 - progress, 3);
          el.textContent = Number((start + (target - start) * ease).toFixed(0));
          if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
        cio.unobserve(el);
      });
    }, { threshold: 0.5 });
    countEls.forEach(function (el) { cio.observe(el); });
  }

})();
