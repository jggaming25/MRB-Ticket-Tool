'use strict';

// WhatsApp-Benachrichtigungen über den CallMeBot-Dienst.
// Konfiguration über Umgebungsvariablen:
//   WHATSAPP_PHONE   – Handynummer in internationalem Format ohne führende 0,
//                      z. B. 4915257029657 für 01525 7029657
//   WHATSAPP_API_KEY – CallMeBot-API-Key (wird einmalig pro Nummer durch die
//                      "activation code"-Anfrage an den Bot freigeschaltet)
const https = require('node:https');

const phone = String(process.env.WHATSAPP_PHONE || '').trim();
const apiKey = String(process.env.WHATSAPP_API_KEY || '').trim();

// CallMeBot-Quota: max. 48 Nachrichten pro 240 Minuten. Wir zaehlen die
// erfolgreich gesendeten Nachrichten in einem gleitenden Fenster und geben ab
// der Grenze nichts mehr zum Versand frei – so verbrennt die App die Quota
// nicht durch Tests/Retries und loggt klar, warum eine Nachricht nicht rausgeht.
const QUOTA_LIMIT = 48;
const QUOTA_WINDOW_MS = 240 * 60 * 1000;
const sentTimes = [];

function quotaUsed() {
  const now = Date.now();
  while (sentTimes.length && sentTimes[0] <= now - QUOTA_WINDOW_MS) sentTimes.shift();
  return sentTimes.length;
}

function isConfigured() {
  return !!(phone && apiKey);
}

// Zeitpunkt des letzten Rate-Limits (Status 209) – sendImportant wartet danach
// erst wieder auf das Ende des Quota-Fensters, statt die Grenze zu erreichen.
let lastRateLimitAt = 0;

// Sendet eine Textnachricht (fire-and-forget). Liefert immer ein Promise,
// damit Aufrufer nicht auf Fehler reagieren müssen.
function sendMessage(text) {
  const msg = String(text == null ? '' : text).trim();
  if (!msg) return Promise.resolve(false);
  if (!isConfigured()) {
    console.warn('WhatsApp nicht konfiguriert (WHATSAPP_PHONE/WHATSAPP_API_KEY fehlen) – Nachricht übersprungen:', msg);
    return Promise.resolve(false);
  }
  if (quotaUsed() >= QUOTA_LIMIT) {
    console.error(`WhatsApp-Quota (${QUOTA_LIMIT} Nachrichten / ${QUOTA_WINDOW_MS / 60000} min) erreicht – Nachricht NICHT gesendet. Warte bis zum Ablauf des Fensters.`, msg.slice(0, 80));
    return Promise.resolve(false);
  }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(msg)}&apikey=${encodeURIComponent(apiKey)}`;
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const isRateLimit = res.statusCode === 209 || /limit of \d+ messages/i.test(body);
        const ok = res.statusCode === 200 && !/error/i.test(body.slice(0, 300));
        if (isRateLimit) {
          lastRateLimitAt = Date.now();
          console.error('WhatsApp-Rate-Limit (48 Nachrichten / 240 min) erreicht – Nachricht NICHT zugestellt. Erst nach Ablauf des Fensters erneut versuchen.', msg.slice(0, 80));
        } else if (!ok) {
          console.error('WhatsApp-Versand fehlgeschlagen:', res.statusCode, body.slice(0, 300));
        } else {
          sentTimes.push(Date.now());
        }
        resolve(ok);
      });
    });
    req.on('error', (err) => {
      console.error('WhatsApp-Versand fehlgeschlagen:', err.message);
      resolve(false);
    });
    req.setTimeout(10000, () => {
      req.destroy(new Error('WhatsApp-Timeout'));
    });
  });
}

// Kritische Meldungen (z. B. IT-Alarm): Bei Fehlschlag automatisch erneut
// versuchen, bis sie durchkommen – damit eine Pflichtbenachrichtigung nie
// verloren geht. CallMeBot drosselt auf 48 Nachrichten / 240 min; bei einem
// Rate-Limit (Antwort "209 … Message limit reached") hilft nur Warten, deshalb
// wächst die Wartezeit zwischen den Versuchen und deckt das gesamte 240-Minuten-
// Quota-Fenster mehrfach ab (insgesamt ca. 9 Stunden). Die Timer sind "unref'd",
// damit sie den Prozess nicht offen halten (z. B. bei Tests). Liefert ein
// Promise, das bei Erfolg true liefert und nach dem letzten Fehlversuch false –
// Aufrufer können es ignorieren oder das Ergebnis auswerten.
function sendImportant(text, opts = {}) {
  if (!isConfigured()) {
    console.warn('WhatsApp nicht konfiguriert (WHATSAPP_PHONE/WHATSAPP_API_KEY fehlen) – Pflichtnachricht übersprungen:', text);
    return Promise.resolve(false);
  }
  const waits = Array.isArray(opts.waits) ? opts.waits : [
    30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000,
    30 * 60_000, 60 * 60_000, 60 * 60_000, 60 * 60_000, 60 * 60_000,
    60 * 60_000, 60 * 60_000, 60 * 60_000, 60 * 60_000,
  ];
  let i = 0;
  return new Promise((resolve) => {
    const attempt = () => {
      module.exports.sendMessage(text).then((ok) => {
        if (ok) return resolve(true);
        if (i >= waits.length) {
          console.error('WhatsApp-Pflichtnachricht nach allen Versuchen NICHT zugestellt:', text);
          return resolve(false);
        }
        let wait = waits[i++];
        // Nach einem Rate-Limit nichts verbrennen: erst deutlich später erneut
        // versuchen, damit die 240-Minuten-Quota wieder freigegeben ist.
        if (module.exports.lastRateLimitAt && Date.now() - module.exports.lastRateLimitAt < QUOTA_WINDOW_MS) {
          wait = Math.max(wait, 30 * 60 * 1000);
        }
        const t = setTimeout(() => { attempt(); }, wait);
        if (typeof t.unref === 'function') t.unref();
      });
    };
    attempt();
  });
}

module.exports = { isConfigured, sendMessage, sendImportant, quotaUsed };
Object.defineProperty(module.exports, 'lastRateLimitAt', {
  enumerable: true,
  get: () => lastRateLimitAt,
});
