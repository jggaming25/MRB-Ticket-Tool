'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

const MAIL_FROM = process.env.MAIL_FROM || 'TicketSystem MRB <noreply@localhost>';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

let transporter = null;
// Im Testmodus (NODE_ENV='test') nie SMTP nutzen – auch wenn SMTP_HOST in
// der .env steht. Mails landen dann im mail-log/, statt echte Mails zu senden.
if (process.env.NODE_ENV !== 'test' && process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS || '',
    },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 40000,
    // Auf Cloud-Hosts (z. B. Render) erzwingt diese Option IPv4. Manche
    // SMTP-Server (Brevo) haben keine funktionierende IPv6-Verbindung, wodurch
    // der Versand sonst in einem endlosen Timeout hängen bleibt.
    family: 4,
  });
}

// Sicherheitsnetz: Sollte nodemailer den SMTP-Vorgang trotz Timeouts nicht
// abschließen (z. B. weil der Server gar nicht antwortet), den Vorgang nach
// 45 Sekunden abbrechen statt den Request ewig hängen zu lassen.
// (45s, damit auch Render-Free-Instanzen nach dem Aufwachen aus dem
// Schlafmodus genug Zeit für den SMTP-Versand haben.)
const SEND_TIMEOUT_MS = 45000;
function withSendTimeout(promise) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, SEND_TIMEOUT_MS);
    promise.then(
      (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    );
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:Segoe UI,Arial,sans-serif;color:#e6e8ef;">
  <div style="max-width:560px;margin:24px auto;background:#1e222d;border:1px solid #2e3443;border-radius:12px;padding:28px;">
    <div style="font-size:22px;font-weight:700;margin-bottom:18px;">🎫 TicketSystem <span style="color:#5865f2;">MRB</span></div>
    ${bodyHtml}
    <p style="margin-top:24px;color:#9aa3b5;font-size:12px;">Diese E-Mail wurde automatisch vom TicketSystem MRB versendet. Antworten auf diese Mail werden nicht gelesen.</p>
  </div>
</body>
</html>`;
}

function writeMailLog(to, subject, html) {
  const dir = path.join(__dirname, 'mail-log');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${String(to).replace(/[^a-z0-9@._-]/gi, '_')}.html`);
  fs.writeFileSync(file, `Subject: ${subject}\nTo: ${to}\n\n${html}`);
}

async function sendMail({ to, subject, html }) {
  if (!to) return false;
  if (transporter) {
    try {
      console.log(`[MAIL] Versand gestartet an ${to} (${subject}) via ${process.env.SMTP_HOST}:${process.env.SMTP_PORT} als ${process.env.SMTP_USER}, From=${MAIL_FROM}`);
      const ok = await withSendTimeout(
        transporter.sendMail({ from: MAIL_FROM, to, subject, html })
      );
      if (ok) {
        console.log(`[MAIL] Versand OK an ${to} (${subject})`);
      } else {
        writeMailLog(to, subject, html);
        console.error(`[MAIL] SMTP-Zeitüberschreitung an ${to} (${subject}) – Mail in mail-log/ gesichert`);
      }
      return ok;
    } catch (err) {
      // Bei SMTP-Fehlern (falsche Zugangsdaten, unverifizierter Absender o. a.)
      // die Mail trotzdem lokal sichern und den Fehler sichtbar loggen, damit
      // das Problem auf Render im Log auftaucht statt still zu scheitern.
      writeMailLog(to, subject, html);
      console.error(`[MAIL] SMTP-Fehler an ${to} (${subject}):`, err.message);
      return false;
    }
  }
  // Fallback: Mail in mail-log/ schreiben (kein SMTP konfiguriert)
  writeMailLog(to, subject, html);
  console.log(`[MAIL] (SMTP nicht konfiguriert -> mail-log/) An: ${to} | Betreff: ${subject}`);
  return true;
}

async function sendAccountDisabled(to, reason) {
  const body = `
    <p>Hallo!</p>
    <p>Dein Teammitglied-Konto im TicketSystem MRB wurde <strong>deaktiviert</strong>.</p>
    ${reason ? `<p>Begründung:<br><em style="background:#0f1117;padding:10px;border-radius:6px;display:block;">${escapeHtml(reason)}</em></p>` : ''}
    <p>Du kannst dich vorerst nicht mehr anmelden. Bei Fragen wende dich an den Inhaber.</p>`;
  return sendMail({ to, subject: '🎫 Dein Teammitglied-Konto wurde deaktiviert', html: layout('Konto deaktiviert', body) });
}

async function sendAccountReactivated(to, reason) {
  const body = `
    <p>Hallo!</p>
    <p>Dein Teammitglied-Konto im TicketSystem MRB wurde <strong>reaktiviert</strong> und du kannst dich wieder anmelden.</p>
    ${reason ? `<p>Begründung:<br><em style="background:#0f1117;padding:10px;border-radius:6px;display:block;">${escapeHtml(reason)}</em></p>` : ''}`;
  return sendMail({ to, subject: '🎫 Dein Teammitglied-Konto wurde reaktiviert', html: layout('Konto reaktiviert', body) });
}

async function sendAccountDeleted(to, reason) {
  const body = `
    <p>Hallo!</p>
    <p>Dein Teammitglied-Konto im TicketSystem MRB wurde <strong>gelöscht</strong>.</p>
    ${reason ? `<p>Begründung:<br><em style="background:#0f1117;padding:10px;border-radius:6px;display:block;">${escapeHtml(reason)}</em></p>` : ''}
    <p>Bei Fragen wende dich an den Inhaber.</p>`;
  return sendMail({ to, subject: '🎫 Dein Teammitglied-Konto wurde gelöscht', html: layout('Konto gelöscht', body) });
}

// ---- Kunden-Benachrichtigungen -------------------------------------------
// Der Kunde bekommt nur dann E-Mails, wenn in seinem Discord-Konto eine
// (verifizierte) E-Mail-Adresse hinterlegt ist.

function ticketUrl(ticketNumber) {
  return `${BASE_URL}/dashboard?number=${ticketNumber}`;
}

async function sendTicketCreated(to, ticketNumber, subject) {
  const body = `
    <p>Hallo!</p>
    <p>Dein Ticket wurde erfolgreich erstellt:</p>
    <p style="background:#0f1117;border:1px solid #2e3443;border-radius:8px;padding:12px;">
      <strong>#${String(ticketNumber).padStart(4, '0')}</strong> – ${escapeHtml(subject)}
    </p>
    <p>Unser Team übernimmt dein Ticket in Kürze. Du bekommst zu jeder Änderung eine E-Mail.</p>`;
  return sendMail({ to, subject: `🎫 Ticket #${String(ticketNumber).padStart(4, '0')} erstellt`, html: layout('Ticket erstellt', body) });
}

// Generische Aktivitaets-Mail: "Es hat sich etwas getan."
async function sendTicketActivity(to, ticketNumber, subject, summary) {
  const body = `
    <p>Hallo!</p>
    <p>Bei deinem Ticket hat sich etwas getan:</p>
    <p style="background:#0f1117;border:1px solid #2e3443;border-radius:8px;padding:12px;">
      <strong>#${String(ticketNumber).padStart(4, '0')}</strong> – ${escapeHtml(subject)}
    </p>
    ${summary ? `<p>${summary}</p>` : ''}
    <p>Du kannst den Verlauf jederzeit im Ticketsystem einsehen.</p>`;
  return sendMail({ to, subject: `🎫 Neuigkeiten zu Ticket #${String(ticketNumber).padStart(4, '0')}`, html: layout('Neuigkeiten zum Ticket', body) });
}

async function sendTicketAssignedToHR(to, ticketNumber, subject, fromName) {
  const body = `
    <p>Hallo!</p>
    <p>Dir wurde das Ticket <strong>#${String(ticketNumber).padStart(4, '0')}</strong> – ${escapeHtml(subject)} übergeben.</p>
    ${fromName ? `<p>Übergeben von: <strong>${escapeHtml(fromName)}</strong></p>` : ''}
    <p>Melde dich im Ticketsystem an, um das Ticket zu bearbeiten. Du bist jetzt dafür verantwortlich.</p>`;
  return sendMail({ to, subject: `🎫 Dir wurde Ticket #${String(ticketNumber).padStart(4, '0')} übergeben`, html: layout('Ticket übergeben', body) });
}

// Einmaliger SMTP-Selbsttest beim Serverstart: Prüft, ob die SMTP-Verbindung
// zu Brevo überhaupt aufgebaut werden kann und loggt das Ergebnis sichtbar.
// Zeigt bei Fehlern den konkreten Grund (DNS, ECONNREFUSED, ETIMEDOUT, TLS, Auth).
async function testConnection() {
  if (!transporter) {
    console.warn('[MAIL] SMTP-Selbsttest: kein SMTP konfiguriert (Mails landen im mail-log/)');
    return;
  }
  const details = { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, user: process.env.SMTP_USER };
  try {
    // Sicherheitsnetz, damit der Start nicht hängen bleibt, falls der Server
    // gar nicht antwortet. Der echte Fehler kommt trotzdem in den catch-Zweig.
    const result = await Promise.race([
      transporter.verify().then(() => 'ok'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 30000)),
    ]);
    if (result === 'ok') {
      console.log(`[MAIL] SMTP-Selbsttest OK: ${details.host}:${details.port} (User ${details.user}) erreichbar`);
    } else {
      console.error(`[MAIL] SMTP-Selbsttest FEHLGESCHLAGEN: Verbindung zu ${details.host}:${details.port} hat die Zeitueberschreitung erreicht (30s) – kein Antwort vom Server`);
    }
  } catch (err) {
    const code = err && err.code ? ` (${err.code})` : '';
    const cmd = err && err.command ? ` Kommando=${err.command}` : '';
    console.error(`[MAIL] SMTP-Selbsttest FEHLGESCHLAGEN: ${err.message}${code}${cmd}`);
  }
}

module.exports = {
  sendAccountDisabled,
  sendAccountReactivated,
  sendAccountDeleted,
  sendTicketCreated,
  sendTicketActivity,
  sendTicketAssignedToHR,
  ticketUrl,
  escapeHtml,
  testConnection,
};
