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

  // Klickbare Ticket-Zeilen (data-ticket-id / data-ticket-url)
  document.querySelectorAll('.clickable[data-ticket-id]').forEach((row) => {
    row.addEventListener('click', () => {
      window.location.href = row.dataset.ticketUrl || '/tickets/' + row.dataset.ticketId;
    });
  });

  // Avatar-Fallback (data-fallback) / verstecken bei Fehler (data-hide-on-error)
  document.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => { img.src = img.dataset.fallback; });
  });
  document.querySelectorAll('img[data-hide-on-error]').forEach((img) => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });

  // Nutzerverwaltung: Datumsfeld nur bei "Automatisch am ..." aktivieren
  document.addEventListener('change', (e) => {
    const sel = e.target && e.target.closest('select[id^="dur-"]');
    if (!sel) return;
    const until = document.getElementById('until-' + sel.id.replace('dur-', ''));
    if (until) until.disabled = sel.value !== 'custom';
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

// ---- Benachrichtigungen bei Ticketänderungen -----------------------------
// Bevorzugt Web-Push (Server sendet Push, auch wenn die Website geschlossen
// ist – der Browser muss nur laufen). Falls Push nicht konfiguriert ist
// (kein VAPID-Key) oder der Browser es nicht unterstützt, wird auf das alte
// Polling ausgewichen. Nur aktiv, wenn der Nutzer es in den
// Kontoeinstellungen aktiviert hat.
(function setupTicketNotifications() {
  const body = document.body;
  if (!body.dataset.notifyEnabled || body.dataset.notifyEnabled !== '1') return;
  if (!('Notification' in window)) return;

  const button = document.getElementById('enable-notifications');
  const permHint = document.getElementById('notify-permission');
  const pushKey = body.dataset.pushKey || '';
  const pushSupported = pushKey && 'serviceWorker' in navigator && 'PushManager' in window;
  let pollingStarted = false;

  function updatePermissionUI() {
    if (!button || !permHint) return;
    if (Notification.permission === 'granted') {
      permHint.textContent = pushSupported
        ? 'Aktiviert – auch bei geschlossener Website (Browser muss laufen).'
        : 'Aktiviert, solange diese Website im Browser geöffnet ist.';
      button.style.display = 'none';
    } else if (Notification.permission === 'denied') {
      permHint.textContent = 'Im Browser blockiert. Bitte in den Browser-Einstellungen erlauben.';
    } else {
      permHint.textContent = '';
    }
  }

  async function subscribePush(reg) {
    const subscription = await reg.pushManager.getSubscription();
    const sub = subscription || await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushKey),
    });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
  }

  async function enablePush() {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    try {
      await subscribePush(reg);
    } catch (err) {
      // z. B. Push nicht konfiguriert – auf Polling ausweichen
      console.warn('Push-Abo fehlgeschlagen, nutze Polling:', err);
      startPolling();
      return;
    }
    updatePermissionUI();
  }

  function onEnable() {
    Notification.requestPermission().then((permission) => {
      updatePermissionUI();
      if (permission !== 'granted') return;
      if (pushSupported) enablePush();
      else startPolling();
    });
  }

  if (button) button.addEventListener('click', onEnable);
  updatePermissionUI();

  if (Notification.permission !== 'granted') return;

  if (pushSupported) {
    enablePush();
  } else {
    startPolling();
  }

  function startPolling() {
    if (pollingStarted) return;
    pollingStarted = true;

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
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
})();
