'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('attachment');
  const fileName = document.getElementById('file-name');
  if (fileInput && fileName) {
    fileInput.addEventListener('change', () => {
      fileName.textContent = fileInput.files.length ? `📎 ${fileInput.files[0].name}` : '';
    });
  }

  // Discord-Login: normale Navigation (kein Popup mehr)
  document.querySelectorAll('.discord-login').forEach((btn) => {
    btn.addEventListener('click', () => {
      setLoading(btn, true);
      window.location.href = '/auth/discord';
    });
  });

  // Lade-Spinner auf allen Formular-Submit-Buttons
  document.querySelectorAll('form').forEach((form) => {
    form.addEventListener('submit', () => {
      const btn = form.querySelector('button[type="submit"]');
      if (btn) setLoading(btn, true);
    });
  });

  // Aufklappbare Panels (z. B. "Freigabe zur Schließung")
  document.querySelectorAll('[data-open]').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const panel = document.querySelector(trigger.dataset.open);
      if (panel) panel.classList.toggle('hidden');
    });
  });

  // Interne-Links-Dropdown (nur HR/HR-HR sichtbar)
  document.querySelectorAll('.nav-dropdown').forEach((dd) => {
    const toggle = dd.querySelector('.nav-dropdown-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.nav-dropdown.open').forEach((other) => {
        if (other !== dd) other.classList.remove('open');
      });
      dd.classList.toggle('open');
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.nav-dropdown.open').forEach((dd) => dd.classList.remove('open'));
  });

  // ---- Homepage-Karussell -------------------------------------------------
  const carousel = document.getElementById('homeCarousel');
  if (carousel) {
    const slides = Array.from(carousel.querySelectorAll('.carousel-slide'));
    const dots = Array.from(carousel.querySelectorAll('.carousel-dot'));
    const seconds = window.HOME_SLIDE_SECONDS || 10;
    let current = 0;

    function goTo(index) {
      current = (index + slides.length) % slides.length;
      slides.forEach((s, i) => s.classList.toggle('active', i === current));
      dots.forEach((d, i) => d.classList.toggle('active', i === current));
    }
    dots.forEach((d, i) => d.addEventListener('click', () => goTo(i)));
    setInterval(() => goTo(current + 1), seconds * 1000);
  }

  // ---- Autosave: Entwürfe alle 30 s im localStorage ----------------------
  const reply = document.getElementById('reply-body');
  if (reply && reply.dataset.autosave) {
    const key = `autosave:${reply.dataset.autosave}`;
    const saved = localStorage.getItem(key);
    if (saved && !reply.value) {
      reply.value = saved;
    }
    let saving = false;
    setInterval(() => {
      if (reply.value && reply.value.trim()) {
        localStorage.setItem(key, reply.value);
        saving = true;
      }
      if (!reply.value.trim() && saving) {
        localStorage.removeItem(key);
        saving = false;
      }
    }, 30 * 1000);
    // Entwurf beim erfolgreichen Senden entfernen
    const form = reply.closest('form');
    if (form) {
      form.addEventListener('submit', () => localStorage.removeItem(key));
    }
  }
});

function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) btn.classList.add('is-loading');
  else btn.classList.remove('is-loading');
}
