'use strict';

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch { /* keine JSON-Nachricht */ }
  const title = data.title || 'TicketSystem MRB';
  const options = {
    body: data.body || '',
    icon: '/static/logo.png',
    badge: '/static/logo.png',
    data: { url: data.url || '/', action: data.action || null },
  };
  // Aktions-Buttons (z. B. "To Website" bei Support-Anrufen)
  if (Array.isArray(data.actions) && data.actions.length) {
    options.actions = data.actions;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // "accept"-Action: zur Support-Mitarbeiter-Konsole (Anruf annehmen).
  const url = event.action === 'accept'
    ? (data.action === 'accept' ? (data.url || '/support/staff') : '/support/staff')
    : (data.url || '/');
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        client.focus();
        client.navigate(url);
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(url);
    }
  })());
});
