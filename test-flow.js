'use strict';

// Integrationstest: simuliert alle Rollen (Nutzer / HR / HR-HR) und Flows
// (Discord-Login, HR-HR-Onboarding mit E-Mail-Verifizierung, HR-Einladung
//  mit Einmalpasswort, Ticket-Lebenszyklus inkl. Übergabe/Fälligkeit/Freigabe/
//  Schließen, Kunden-Mails, CSV-Export, Passwort-Reset, Deaktivieren/Löschen).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cookieSignature = require('cookie-signature');

// --- Umgebung zuerst setzen (bevor server.js geladen wird) ---
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-123';
process.env.STAFF_IDS = '';
process.env.AUTHORIZED_DISCORD_USERNAMES = 'jlg09';
process.env.DISCORD_CLIENT_ID = 'test-client-id';
process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
process.env.DB_DIR = path.join(__dirname, 'data-test');
process.env.BASE_URL = 'http://localhost:3000';
// WICHTIG: Remote-DB (Turso) fuer den Test deaktivieren – sonst wuerde der
// Test in die Produktionsdatenbank schreiben, statt in die lokale data-test/.
delete process.env.TURSO_URL;
delete process.env.TURSO_AUTH_TOKEN;
// Ebenso SMTP deaktivieren – Mails landen im Ordner mail-log/, statt wirklich
// ueber Brevo versendet zu werden (sonst sendet der Test echte Mails).
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.SMTP_PORT;
delete process.env.SMTP_SECURE;
delete process.env.MAIL_FROM;
// Guild-Prüfung bleibt hier aus (DISCORD_GUILD_ID nicht gesetzt),
// damit der komplette Flow ohne echten Server durchlaeuft.

const MAIL_DIR = path.join(__dirname, 'mail-log');

// Alte Test-Reste entfernen (Mails + lokale Test-DB), damit jeder Lauf
// reproduzierbar startet und keine veralteten Dateien den Test verfaelschen.
try {
  if (fs.existsSync(MAIL_DIR)) {
    for (const f of fs.readdirSync(MAIL_DIR)) {
      if (f.endsWith('.html')) fs.unlinkSync(path.join(MAIL_DIR, f));
    }
  }
} catch {}
try {
  const testDb = path.join(__dirname, 'data-test', 'tickets.db');
  if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
} catch {}
let mockDiscord = { id: '1', username: 'test', global_name: 'Test', discriminator: '0' };

// Discord-API mocken (globales fetch). Nur Discord-Aufrufe abfangen;
// alle anderen Anfragen (lokaler Test-Server) normal durchlassen.
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/oauth2/token')) {
    return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token', token_type: 'Bearer' }) };
  }
  if (u.includes('/users/@me/guilds')) {
    // Simulation: Nutzer ist nicht auf dem Server
    return { ok: true, status: 200, json: async () => [] };
  }
  if (u.includes('/users/@me')) {
    return { ok: true, status: 200, json: async () => mockDiscord };
  }
  return realFetch(url, opts);
};

// /auth/discord erzeugt zufaelligen State
const { app, sessionStore } = require('./server');
const { db } = require('./db');

let server;
let base;
let failures = 0;
let uploadedFile = null;

function ok(name, cond, extra = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`${mark}  ${name}${extra ? ' — ' + extra : ''}`);
}

function cookieFor(userId) {
  const sid = crypto.randomBytes(16).toString('hex');
  const sess = { userId, cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/' } };
  return new Promise((resolve) => {
    sessionStore.set(sid, sess, () => {
      const signed = cookieSignature.sign(sid, process.env.SESSION_SECRET);
      resolve(`connect.sid=s:${signed}`);
    });
  });
}

function cookieFromRes(res) {
  let sc;
  if (typeof res.headers.getSetCookie === 'function') sc = res.headers.getSetCookie();
  else sc = [res.headers.get('set-cookie')];
  const line = sc.find((c) => c && c.startsWith('connect.sid='));
  if (!line) return '';
  return line.split(';')[0];
}

async function get(url, cookie) {
  const res = await fetch(base + url, { headers: { cookie: cookie || '' }, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), body: await res.text(), headers: res.headers };
}

async function post(url, body, cookie) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { cookie: cookie || '', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location'), body: await res.text(), headers: res.headers };
}

async function postForm(url, formData, cookie) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { cookie: cookie || '' },
    body: formData,
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location'), body: await res.text(), headers: res.headers };
}

// Discord-Login als bestimmter Nutzer simulieren -> Session-Cookie
async function discordLogin(username, globalName, email) {
  mockDiscord = {
    id: String(Date.now() + Math.floor(Math.random() * 1e6)),
    username,
    global_name: globalName,
    discriminator: '0',
    ...(email ? { email, verified: true } : {}),
  };
  const auth = await get('/auth/discord');
  const state = new URL(auth.location).searchParams.get('state');
  const cb = await get(`/auth/callback?code=FAKECODE&state=${state}`);
  return cookieFromRes(cb);
}

function latestMail() {
  if (!fs.existsSync(MAIL_DIR)) return null;
  const files = fs.readdirSync(MAIL_DIR).filter((f) => f.endsWith('.html')).sort().reverse();
  if (!files.length) return null;
  const raw = fs.readFileSync(path.join(MAIL_DIR, files[0]), 'utf8');
  const subject = (raw.match(/Subject: ([^\n]*)/) || [])[1] || '';
  const code = (raw.match(/color:#fff;">(\d{6})<\/div>/) || [])[1] || '';
  return { subject, code, raw };
}

function findMail(subjectPart) {
  if (!fs.existsSync(MAIL_DIR)) return null;
  const files = fs.readdirSync(MAIL_DIR).filter((f) => f.endsWith('.html')).sort().reverse();
  for (const f of files) {
    const raw = fs.readFileSync(path.join(MAIL_DIR, f), 'utf8');
    const subject = (raw.match(/Subject: ([^\n]*)/) || [])[1] || '';
    if (subject.includes(subjectPart)) return { subject, raw };
  }
  return null;
}

(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // ==================================================================
  // 1) HR-HR-Onboarding (jlg09 per Discord -> Setup mit Discord-E-Mail)
  // ==================================================================
  let hrhrCookie = await discordLogin('jlg09', 'JLG09', 'jlg09@example.com');
  ok('HR-HR: Discord-Login liefert Session', hrhrCookie.length > 0);

  let r = await get('/', hrhrCookie);
  ok('HR-HR: wird zum Setup geleitet (pending_setup)', r.status === 302 && r.location === '/onboard/setup', r.location);

  let mail;

  r = await get('/onboard/setup', hrhrCookie);
  ok('HR-HR: Setup-Seite erreichbar', r.status === 200 && r.body.includes('Konto einrichten'));
  ok('HR-HR: E-Mail aus Discord vorausgefuellt (nicht aenderbar)', r.body.includes('jlg09@example.com'));

  r = await post('/onboard/setup', {
    password: 'SuperGeheim123', password_confirm: 'SuperGeheim123',
  }, hrhrCookie);
  ok('HR-HR: Setup gesendet -> direkt aktiv (kein Verify-Code)', r.status === 302 && r.location === '/dashboard', r.location);

  r = await get('/dashboard', hrhrCookie);
  ok('HR-HR: Dashboard erreichbar, Rolle HR-HR', r.status === 200 && r.body.includes('Meine Tickets'));

  const hrhrUser = db.prepare('SELECT * FROM users WHERE discord_username = ?').get('jlg09');
  ok('HR-HR: Rolle = hrhr, Status = active', hrhrUser.role === 'hrhr' && hrhrUser.status === 'active', `${hrhrUser.role}/${hrhrUser.status}`);
  ok('HR-HR: is_root gesetzt (festegelegter HR-HR)', hrhrUser.is_root === 1);
  ok('HR-HR: E-Mail kommt aus Discord', hrhrUser.email === 'jlg09@example.com', hrhrUser.email);

  r = await get('/admin/accounts', hrhrCookie);
  ok('HR-HR: Team-Verwaltung erreichbar', r.status === 200 && r.body.includes('Team-Verwaltung'));

  // ==================================================================
  // 2) Passwort-Login des HR-HR (mit der Discord-E-Mail)
  // ==================================================================
  r = await post('/auth/login', { identifier: 'jlg09@example.com', password: 'SuperGeheim123' });
  ok('HR-HR: Passwort-Login funktioniert', r.status === 302 && r.location === '/dashboard', r.location);
  ok('HR-HR: Passwort-Login setzt Cookie', cookieFromRes(r).length > 0);
  r = await post('/auth/login', { identifier: 'jlg09@example.com', password: 'falsch123' });
  ok('HR-HR: falsches Passwort abgelehnt', r.status === 400);

  // ==================================================================
  // 3) HR-Einladung per E-Mail (Link, ohne Einmalpasswort)
  // ==================================================================
  r = await post('/admin/accounts/invite', { email: 'max@beispiel.de', discord_username: 'max.mustermann' }, hrhrCookie);
  ok('HR-HR: Einladung gesendet', r.status === 302 && r.location === '/admin/accounts');

  mail = latestMail();
  ok('HR-HR: Einladungs-E-Mail mit Link (ohne OTP)', mail && mail.subject.includes('Einladung'), mail ? mail.subject : 'keine Mail');
  const inviteToken = (mail.raw.match(/\/invite\/([a-f0-9]{48})/) || [])[1];
  ok('HR-HR: Einladung enthaelt Link', !!inviteToken, `token=${inviteToken ? inviteToken.slice(0, 8) : 'keins'}`);
  ok('HR-HR: Einladungs-Mail enthaelt KEIN Einmalpasswort', mail && !mail.code, mail ? `code=${mail.code}` : 'keine Mail');

  const invited = db.prepare("SELECT * FROM users WHERE status = 'invited'").get();
  ok('HR-HR: Eingeladener Account angelegt (Rolle hr)', invited && invited.role === 'hr', invited ? invited.role : 'fehlt');

  // Einladungslink ohne Login
  r = await get(`/invite/${inviteToken}`);
  ok('Einladungslink zeigt Landeseite', r.status === 200 && r.body.includes('Du wurdest eingeladen'));

  // Eingeladener meldet sich mit Discord an (Username passt, mit E-Mail)
  let hrCookie = await discordLogin('max.mustermann', 'Max Mustermann', 'max@beispiel.de');
  ok('Eingeladener: Discord-Login liefert Session', hrCookie.length > 0);

  r = await get('/', hrCookie);
  ok('Eingeladener: wird direkt zum Passwort geleitet (kein OTP)', r.status === 302 && r.location === '/onboard/password', r.location);

  r = await get('/onboard/password', hrCookie);
  ok('Eingeladener: Passwort-Seite erreichbar', r.status === 200);

  r = await post('/onboard/password', { password: 'HrPasswort123', password_confirm: 'HrPasswort123' }, hrCookie);
  ok('Eingeladener: Passwort gesetzt -> aktiv', r.status === 302 && r.location === '/dashboard', r.location);

  r = await get('/dashboard', hrCookie);
  ok('Eingeladener: Dashboard erreichbar, Rolle HR', r.status === 200 && r.body.includes('Meine Tickets'));

  const hrUser = db.prepare("SELECT * FROM users WHERE discord_username = 'max.mustermann'").get();
  ok('HR: Rolle = hr, Status = active', hrUser && hrUser.role === 'hr' && hrUser.status === 'active', hrUser ? `${hrUser.role}/${hrUser.status}` : 'fehlt');

  // Passwort-Login des HR
  r = await post('/auth/login', { identifier: 'max@beispiel.de', password: 'HrPasswort123' });
  ok('HR: Passwort-Login funktioniert', r.status === 302 && r.location === '/dashboard');

  // ==================================================================
  // 4) Normaler Nutzer per Discord (nicht authorisiert, mit E-Mail)
  // ==================================================================
  let userCookie = await discordLogin('lisa_wasmacht', 'Lisa', 'lisa@example.com');
  ok('Normaler Nutzer: Discord-Login erzeugt Account', userCookie.length > 0);
  const normalUser = db.prepare('SELECT * FROM users WHERE discord_username = ?').get('lisa_wasmacht');
  ok('Normaler Nutzer: Rolle user, Status active', normalUser && normalUser.role === 'user' && normalUser.status === 'active');
  ok('Normaler Nutzer: E-Mail aus Discord uebernommen', normalUser && normalUser.email === 'lisa@example.com', normalUser ? normalUser.email : 'keine');

  r = await get('/dashboard', userCookie);
  ok('Normaler Nutzer: Dashboard erreichbar', r.status === 200 && r.body.includes('Meine Tickets'));
  r = await get('/admin', userCookie);
  ok('Normaler Nutzer: /admin verboten (403)', r.status === 403);
  r = await get('/admin/accounts', userCookie);
  ok('Normaler Nutzer: HR-Verwaltung verboten (403)', r.status === 403);
  r = await get('/admin/logs', userCookie);
  ok('Normaler Nutzer: Audit-Log verboten (403)', r.status === 403);

  // ==================================================================
  // 5) Tickets: Erstellen, Claim, Fälligkeit, Übergabe, Freigabe, Schließen
  // ==================================================================
  const ticketForm = new FormData();
  ticketForm.append('subject', 'Kann mich nicht einloggen');
  ticketForm.append('category', 'Bug');
  ticketForm.append('body', 'Seit heute Morgen geht gar nichts mehr. Die Datenbankabsturz-Fehlermeldung erscheint.');
  ticketForm.append('attachment', new Blob(['Testinhalt des Anhangs'], { type: 'text/plain' }), 'fehler-protokoll.txt');
  r = await postForm('/tickets', ticketForm, userCookie);
  ok('Ticket-Erstellung (Nutzer) mit Anhang leitet zum Ticket', r.status === 302 && /^\/tickets\/\d+$/.test(r.location), r.location);
  const ticketUrl = r.location;
  const ticketId = ticketUrl.split('/')[2];

  mail = findMail('erstellt');
  ok('Kunde: Bestaetigungs-E-Mail nach Erstellung', !!mail, mail ? mail.subject : 'keine Mail');

  const firstMsg = db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id ASC LIMIT 1').get(ticketId);
  const blobOk = !!(firstMsg && firstMsg.attachment && firstMsg.attachment_data && firstMsg.attachment_data.length);
  ok('Erste Nachricht enthaelt Dateianhang', blobOk, firstMsg ? firstMsg.attachment : 'fehlt');
  ok('Anhang liegt als Blob in der Datenbank', blobOk && firstMsg.attachment_data.length >= 5);
  uploadedFile = null; // Anhaenge liegen jetzt in der DB, nicht im Dateisystem

  // Geschuetzter Download: /file/... liefert den Blob aus der DB
  r = await get(`/file/${ticketId}/${firstMsg.id}/${encodeURIComponent(firstMsg.attachment_name || '')}`, userCookie);
  ok('Anhang-Download liefert Inhalt (Blob aus DB)', r.status === 200 && r.body.includes('Testinhalt des Anhangs'), `Status ${r.status}`);

  r = await get(ticketUrl, userCookie);
  ok('Ticket-Ansicht (Besitzer) erreichbar', r.status === 200 && r.body.includes('Kann mich nicht einloggen'));

  // Anderer normaler Nutzer darf das Ticket nicht sehen
  const strangerId = db.prepare("INSERT INTO users (discord_id, discord_username, username, role, status) VALUES ('500','fremd','Fremd','user','active')").run().lastInsertRowid;
  const strangerCookie = await cookieFor(strangerId);
  r = await get(ticketUrl, strangerCookie);
  ok('Fremder normaler Nutzer bekommt 403', r.status === 403);

  // HR darf jedes Ticket ansehen
  r = await get(ticketUrl, hrCookie);
  ok('HR darf fremdes Ticket sehen', r.status === 200);

  // HR claimt das Ticket -> nur der Claimer darf es bearbeiten
  r = await post(`/admin/tickets/${ticketId}/claim`, {}, hrCookie);
  ok('HR claimt Ticket', r.status === 302 && r.location === ticketUrl);
  const claimedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Claim: claimed_by gesetzt + Status pending', claimedTicket.claimed_by === hrUser.id && claimedTicket.status === 'pending', `by=${claimedTicket.claimed_by} status=${claimedTicket.status}`);
  ok('Claim: Faelligkeit wurde gesetzt', !!claimedTicket.due_at, claimedTicket.due_at || 'fehlt');

  r = await post(ticketUrl + '/message', { body: 'HR-HR versucht zu antworten' }, hrhrCookie);
  ok('Geclaimt: anderer HR darf nicht antworten (403)', r.status === 403);
  r = await post(`/admin/tickets/${ticketId}/status`, { status: 'pending' }, hrhrCookie);
  ok('Geclaimt: anderer HR darf Status nicht aendern (403)', r.status === 403);
  r = await post(ticketUrl + '/message', { body: 'Besitzer versucht zu antworten' }, userCookie);
  ok('Geclaimt: Besitzer darf nicht antworten (403)', r.status === 403);

  r = await post(ticketUrl + '/message', { body: 'Wir kümmern uns drum!' }, hrCookie);
  ok('Claimer antwortet', r.status === 302);
  const staffMsg = db.prepare("SELECT * FROM messages WHERE ticket_id = ? AND user_id = ? AND body = 'Wir kümmern uns drum!'").get(ticketId, hrUser.id);
  ok('Claimer-Antwort als staff gespeichert', staffMsg && staffMsg.author_role === 'staff');
  r = await get(ticketUrl, userCookie);
  ok('HR-Antwort fuer Nutzer sichtbar', r.body.includes('Wir kümmern uns drum'));
  mail = findMail('Neuigkeiten');
  ok('Kunde: Aktivitaets-E-Mail bei Support-Antwort', !!mail, mail ? mail.subject : 'keine Mail');

  // Fälligkeit + nächste Aktion setzen
  r = await post(`/admin/tickets/${ticketId}/due`, { hours: '48', next_action: 'Rückfrage an den Kunden' }, hrCookie);
  ok('HR setzt Faelligkeit + naechste Aktion', r.status === 302);
  const dueTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Faelligkeit: due_at gesetzt + naechste Aktion', !!dueTicket.due_at && dueTicket.next_action === 'Rückfrage an den Kunden', `due=${dueTicket.due_at} act=${dueTicket.next_action}`);

  // Übergabe: HR uebergibt an HR-HR (mit Begründung)
  r = await post(`/admin/tickets/${ticketId}/transfer`, { assignee: String(hrhrUser.id), reason: 'Weil HR-HR das Problem kennt' }, hrCookie);
  ok('HR uebergibt Ticket an HR-HR', r.status === 302 && r.location === ticketUrl);
  const transferred = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Übergabe: neuer Claimer = HR-HR, Status pending', transferred.claimed_by === hrhrUser.id && transferred.status === 'pending', `by=${transferred.claimed_by}`);
  mail = findMail('übergeben');
  ok('Übergabe: E-Mail an neuen Bearbeiter', !!mail, mail ? mail.subject : 'keine Mail');

  r = await post(ticketUrl + '/message', { body: 'Ich bin jetzt dran' }, hrhrCookie);
  ok('Neuer Bearbeiter (HR-HR) kann antworten', r.status === 302);
  r = await post(ticketUrl + '/message', { body: 'Alter Bearbeiter versucht es' }, hrCookie);
  ok('Alter Bearbeiter darf nach Übergabe nicht antworten (403)', r.status === 403);

  // HR-HR gibt den Claim ab -> wieder frei
  r = await post(`/admin/tickets/${ticketId}/unclaim`, {}, hrhrCookie);
  ok('HR-HR hebt Claim auf', r.status === 302);
  const unclaimedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Unclaim: claimed_by leer, Status wieder offen', unclaimedTicket.claimed_by === null && unclaimedTicket.status === 'open');

  r = await post(ticketUrl + '/message', { body: 'Vielen Dank!' }, userCookie);
  ok('Nutzer antwortet (nach Unclaim)', r.status === 302);

  // Freigabe zur Schliessung: HR übernimmt erneut, meldet sich, legt Freigabe vor
  r = await post(`/admin/tickets/${ticketId}/claim`, {}, hrCookie);
  ok('HR uebernimmt erneut', r.status === 302);
  r = await post(ticketUrl + '/message', { body: 'Alles geloest!' }, hrCookie);
  ok('HR meldet Loesung', r.status === 302);
  r = await post(`/admin/tickets/${ticketId}/release`, { report: 'Fehler war ein Konfigurationsproblem, behoben und getestet.' }, hrCookie);
  ok('HR legt Freigabe zur Schliessung vor', r.status === 302);
  const released = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Freigabe: Status = release', released.status === 'release', released.status);

  // Schließen nur durch HR-HR
  r = await post(ticketUrl + '/close', {}, userCookie);
  ok('Nutzer kann nicht schliessen (403)', r.status === 403);
  r = await post(ticketUrl + '/close', {}, hrCookie);
  ok('HR kann nicht schliessen (403)', r.status === 403);
  r = await post(ticketUrl + '/close', {}, hrhrCookie);
  ok('HR-HR schliesst Ticket', r.status === 302 && r.location === ticketUrl);
  const closedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Schliessung: Status closed + closed_by = HR-HR', closedTicket.status === 'closed' && closedTicket.closed_by === hrhrUser.id);

  r = await get(ticketUrl, userCookie);
  ok('Ticket als geschlossen markiert', r.body.includes('Geschlossen'));
  ok('Kein Antwortformular nach Schliessung', !r.body.includes('id="reply-form"'));

  // Wieder oeffnen nur durch HR-HR
  r = await post(ticketUrl + '/reopen', {}, hrCookie);
  ok('HR kann nicht wieder oeffnen (403)', r.status === 403);
  r = await post(ticketUrl + '/reopen', {}, hrhrCookie);
  ok('HR-HR oeffnet wieder', r.status === 302);
  const reopened = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Reopen: Status open', reopened.status === 'open');

  // ==================================================================
  // 6) Überfälligkeit, CSV, QuickJump, Admin-Suche
  // ==================================================================
  db.prepare("UPDATE tickets SET due_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(ticketId);
  r = await get('/admin?overdue=1', hrhrCookie);
  ok('HR-HR: Überfaellig-Filter findet Ticket', r.status === 200 && r.body.includes('Kann mich nicht einloggen'));
  r = await get('/dashboard', userCookie);
  ok('Dashboard: Überfaellig-Badge sichtbar', r.body.includes('Überfällig'));

  r = await get('/admin/export.csv', hrhrCookie);
  ok('CSV-Export liefert CSV', r.status === 200 && String(r.headers.get('content-type') || '').includes('text/csv') && r.body.includes('Kann mich nicht einloggen'));

  r = await post('/dashboard/jump', { number: String(closedTicket.number) }, userCookie);
  ok('QuickJump: Ticketnummer fuehrt zum Ticket', r.status === 302 && r.location === ticketUrl);
  r = await post('/dashboard/jump', { number: '999999' }, userCookie);
  ok('QuickJump: unbekannte Nummer zeigt Fehler', r.status === 200 && r.body.includes('kein Ticket'));

  r = await get('/admin', hrhrCookie);
  ok('HR-HR: Ticket-Verwaltung erreichbar', r.status === 200 && r.body.includes('Alle Tickets'));
  r = await get('/admin?search=einloggen', hrhrCookie);
  ok('HR-HR: Suche nach Betreff-Stichwort', r.body.includes('Kann mich nicht einloggen'));
  const numStr = String(claimedTicket.number).padStart(4, '0');
  r = await get(`/admin?search=${numStr}`, hrhrCookie);
  ok('HR-HR: Suche nach Ticketnummer', r.body.includes(numStr) && r.body.includes('Kann mich nicht einloggen'));
  r = await get('/admin?search=Datenbankabsturz', hrhrCookie);
  ok('HR-HR: Stichwortsuche in Nachrichten', r.body.includes('Kann mich nicht einloggen'));

  const ticketLogCount = db.prepare('SELECT COUNT(*) AS c FROM ticket_logs WHERE ticket_id = ?').get(ticketId).c;
  ok('Ticket-Audit-Log protokolliert Aktionen', ticketLogCount >= 6, `Eintraege: ${ticketLogCount}`);

  // ==================================================================
  // 7) HR-Verwaltung: Rolle, Deaktivieren, Reaktivieren, Löschen, Logs
  // ==================================================================
  // Promotion zum HR-HR nur, wenn in Config festgelegt -> hier verweigert
  r = await post(`/admin/accounts/${hrUser.id}/role`, { role: 'hrhr' }, hrhrCookie);
  ok('HR-HR: nicht-festgelegter Nutzer kann nicht zu HR-HR werden', r.status === 302);
  const stillHr = db.prepare('SELECT * FROM users WHERE id = ?').get(hrUser.id);
  ok('Rolle bleibt HR (kein unberechtigter Aufstieg)', stillHr.role === 'hr', stillHr.role);

  r = await get('/admin/logs', hrhrCookie);
  ok('HR-HR: Audit-Log-Seite erreichbar', r.status === 200 && r.body.includes('Audit-Log'));
  r = await get('/admin/logs', hrCookie);
  ok('HR: Audit-Log verboten (403)', r.status === 403);

  // Passwort-Reset per Admin
  r = await post(`/admin/accounts/${hrUser.id}/reset-password`, {}, hrhrCookie);
  ok('HR-HR: Passwort-Reset-Mail ausloesbar', r.status === 302);
  mail = findMail('Passwort zurücksetzen');
  ok('Reset-Mail an Betroffenen gesendet', !!mail, mail ? mail.subject : 'keine Mail');

  r = await post(`/admin/accounts/${hrUser.id}/disable`, { reason: 'Schlechte Performance' }, hrhrCookie);
  ok('HR-HR: HR deaktiviert (mit Grund)', r.status === 302 && r.location === '/admin/accounts');
  mail = findMail('deaktiviert');
  ok('Deaktivierung: E-Mail an Betroffenen', !!mail, mail ? mail.subject : 'keine Mail');
  ok('Deaktivierung: E-Mail enthaelt Begruendung', mail && mail.raw.includes('Schlechte Performance'));

  const disabledUser = db.prepare('SELECT * FROM users WHERE id = ?').get(hrUser.id);
  ok('Deaktivierung: Status = disabled', disabledUser.status === 'disabled' && disabledUser.disabled_reason === 'Schlechte Performance');

  // Deaktivierter kann sich nicht mehr per Passwort einloggen
  r = await post('/auth/login', { identifier: 'max@beispiel.de', password: 'HrPasswort123' });
  ok('Deaktivierter kann nicht mehr einloggen (403)', r.status === 403);

  // Reaktivieren
  r = await post(`/admin/accounts/${hrUser.id}/enable`, { reason: 'Geloest, wieder dabei' }, hrhrCookie);
  ok('HR-HR: HR reaktiviert', r.status === 302 && r.location === '/admin/accounts');
  mail = findMail('reaktiviert');
  ok('Reaktivierung: E-Mail an Betroffenen', !!mail, mail ? mail.subject : 'keine Mail');
  const enabledUser = db.prepare('SELECT * FROM users WHERE id = ?').get(hrUser.id);
  ok('Reaktivierung: Status = active', enabledUser.status === 'active');

  // Löschen
  r = await post(`/admin/accounts/${hrUser.id}/delete`, { reason: 'Verstoss gegen Richtlinien' }, hrhrCookie);
  ok('HR-HR: HR geloescht (mit Grund)', r.status === 302 && r.location === '/admin/accounts');
  mail = findMail('gelöscht');
  ok('Loeschung: E-Mail an Betroffenen', !!mail, mail ? mail.subject : 'keine Mail');
  const deletedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(hrUser.id);
  ok('Loeschung: Status = deleted', deletedUser.status === 'deleted');

  // Löschen eines HR-HR nicht moeglich
  r = await post(`/admin/accounts/${hrhrUser.id}/delete`, { reason: 'x' }, hrhrCookie);
  ok('HR-HR: HR-HR kann nicht geloescht werden', r.status === 400);

  const logCount = db.prepare('SELECT COUNT(*) AS c FROM account_logs').get().c;
  ok('Audit-Log protokolliert Konto-Aktionen', logCount >= 8, `Eintraege: ${logCount}`);

  // ==================================================================
  // 8) Passwort vergessen / zurücksetzen
  // ==================================================================
  r = await get('/forgot-password');
  ok('Forgot-Password-Seite erreichbar', r.status === 200);
  r = await post('/forgot-password', { identifier: 'jlg09@example.com' });
  ok('Forgot-Password: Link-Mail gesendet', r.status === 200);
  mail = findMail('Passwort zurücksetzen');
  const resetToken = mail ? (mail.raw.match(/reset-password\?token=([a-f0-9]{64})/) || [])[1] : null;
  ok('Forgot-Password: Reset-Link extrahiert', !!resetToken);

  r = await get(`/reset-password?token=${resetToken}`);
  ok('Reset-Seite erreichbar', r.status === 200);
  r = await post('/reset-password', { token: resetToken, password: 'NeuesPasswort99', password_confirm: 'NeuesPasswort99' });
  ok('Reset: Passwort gesetzt -> Login', r.status === 302 && r.location === '/login', r.location);
  r = await post('/auth/login', { identifier: 'jlg09@example.com', password: 'NeuesPasswort99' });
  ok('Login mit neuem Passwort funktioniert', r.status === 302 && r.location === '/dashboard');

  // ==================================================================
  // 9) Sicherheit / Randfaelle
  // ==================================================================
  r = await get('/auth/callback?error=access_denied');
  ok('Callback bei Abbruch zeigt Fehler', r.status === 400);
  r = await get('/auth/callback?code=abc');
  ok('Callback mit falschem State abgelehnt', r.status === 400);

  r = await get('/');
  ok('Startseite oeffentlich erreichbar', r.status === 200 && r.body.includes('Mitteldeutsche Regionalbahn'));
  r = await get('/dashboard');
  ok('Ohne Login: Dashboard leitet zu /login', r.status === 302 && r.location === '/login');

  const logoutRes = await fetch(base + '/auth/logout', {
    method: 'POST', headers: { cookie: userCookie }, redirect: 'manual',
  });
  ok('Logout leitet zu /login', logoutRes.status === 302 && logoutRes.headers.get('location') === '/login');

  // Persistenz
  ok('Test-DB-Datei gespeichert', fs.existsSync(path.join(__dirname, 'data-test', 'tickets.db')));

  if (uploadedFile && fs.existsSync(uploadedFile)) fs.unlinkSync(uploadedFile);

  server.close(() => {
    console.log(failures === 0 ? '\n=== ALLE TESTS BESTANDEN ===' : `\n=== ${failures} TEST(S) FEHLGESCHLAGEN ===`);
    process.exit(failures === 0 ? 0 : 1);
  });
})().catch((e) => {
  console.error('TEST-CRASH:', e);
  process.exit(1);
});
