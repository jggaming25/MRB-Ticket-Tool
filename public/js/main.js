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

  // Bestätigungsdialog für Formulare (data-confirm)
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  // Klickbare Ticket-Zeilen (data-ticket-id)
  document.querySelectorAll('.clickable[data-ticket-id]').forEach((row) => {
    row.addEventListener('click', () => {
      window.location.href = '/tickets/' + row.dataset.ticketId;
    });
  });

  // Avatar-Fallback (data-fallback) / verstecken bei Fehler (data-hide-on-error)
  document.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => { img.src = img.dataset.fallback; });
  });
  document.querySelectorAll('img[data-hide-on-error]').forEach((img) => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
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

// ---- Desktop-Benachrichtigungen bei Ticketänderungen --------------------
// Pollt die Änderungen an sichtbaren Tickets und zeigt eine Browser-/
// Windows-Benachrichtigung an, sobald sich etwas getan hat. Nur aktiv, wenn
// der Nutzer es in den Kontoeinstellungen aktiviert hat.
(function setupTicketNotifications() {
  const body = document.body;
  if (!body.dataset.notifyEnabled || body.dataset.notifyEnabled !== '1') return;
  if (!('Notification' in window)) return;

  const button = document.getElementById('enable-notifications');
  const permHint = document.getElementById('notify-permission');

  function updatePermissionUI() {
    if (!button || !permHint) return;
    if (Notification.permission === 'granted') {
      permHint.textContent = 'Aktiviert.';
      button.style.display = 'none';
    } else if (Notification.permission === 'denied') {
      permHint.textContent = 'Im Browser blockiert. Bitte in den Browser-Einstellungen erlauben.';
    } else {
      permHint.textContent = '';
    }
  }

  if (button) {
    button.addEventListener('click', () => {
      Notification.requestPermission().then(updatePermissionUI);
    });
  }

  updatePermissionUI();

  if (Notification.permission !== 'granted') return;

  const storageKey = `notify:lastUpdate:${body.dataset.userId || ''}`;
  let lastUpdate = localStorage.getItem(storageKey) || new Date().toISOString();

  async function poll() {
    if (document.hidden) return;
    let res;
    try {
      res = await fetch(`/api/tickets/updates?since=${encodeURIComponent(lastUpdate)}`);
    } catch {
      return; // Offline / Server nicht erreichbar
    }
    if (!res.ok) return;
    const { tickets } = await res.json();
    if (!tickets || !tickets.length) return;

    const newest = tickets[0].updated_at;
    if (newest > lastUpdate) lastUpdate = newest;
    localStorage.setItem(storageKey, lastUpdate);

    const single = tickets[0];
    const title = tickets.length > 1
      ? `${tickets.length} Tickets haben Änderungen`
      : `Ticket #${String(single.number).padStart(4, '0')} hat Änderungen`;
    const notification = new Notification(title, {
      body: tickets.length > 1
        ? `${single.subject} u.a. – Klick zum Öffnen`
        : `${single.subject}`,
      icon: '/static/logo.png',
    });
    notification.onclick = () => {
      window.focus();
      window.location.href = `/tickets/${single.id}`;
      notification.close();
    };
  }

  setInterval(poll, 30000); // alle 30 s
})();
