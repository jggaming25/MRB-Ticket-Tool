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

function isConfigured() {
  return !!(phone && apiKey);
}

// Sendet eine Textnachricht (fire-and-forget). Liefert immer ein Promise,
// damit Aufrufer nicht auf Fehler reagieren müssen.
function sendMessage(text) {
  const msg = String(text == null ? '' : text).trim();
  if (!msg) return Promise.resolve(false);
  if (!isConfigured()) {
    console.warn('WhatsApp nicht konfiguriert (WHATSAPP_PHONE/WHATSAPP_API_KEY fehlen) – Nachricht übersprungen:', msg);
    return Promise.resolve(false);
  }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(msg)}&apikey=${encodeURIComponent(apiKey)}`;
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const ok = res.statusCode === 200 && !/error/i.test(body.slice(0, 300));
        if (!ok) console.error('WhatsApp-Versand fehlgeschlagen:', res.statusCode, body.slice(0, 300));
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

module.exports = { isConfigured, sendMessage };
