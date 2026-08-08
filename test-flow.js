'use strict';

// Integrationstest: simuliert alle Rollen (Nutzer / Team / Inhaber) und Flows
// (Discord-Login ohne Einladung/Passwort, automatische Inhaber-Zuordnung,
// Rollenvergabe durch den Inhaber, Ticket-Lebenszyklus inkl. Übernahme/
// Übergabe/Fälligkeit/Freigabe/Schließen, Kunden-Mails, CSV-Export,
// Deaktivieren/Löschen, Kontoeinstellungen).
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
const { db, migrateLogActions, logActionLabel } = require('./db');
const config = require('./config');
const pushModule = require('./push');

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

async function postJson(url, body, cookie) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { cookie: cookie || '', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  // 1) Inhaber-Login (jlg09 per Discord) -> sofort aktiv, keine Einladung
  // ==================================================================
  let hrhrCookie = await discordLogin('jlg09', 'JLG09', 'jlg09@example.com');
  ok('Inhaber: Discord-Login liefert Session', hrhrCookie.length > 0);

  let r = await get('/', hrhrCookie);
  ok('Inhaber: kein Setup/Onboarding noetig (direkt nutzbar)', r.status === 200, `${r.status}`);

  let mail;

  r = await get('/dashboard', hrhrCookie);
  ok('Inhaber: Dashboard erreichbar, Rolle Inhaber', r.status === 200 && r.body.includes('Meine Tickets'));

  const hrhrUser = db.prepare('SELECT * FROM users WHERE discord_username = ?').get('jlg09');
  ok('Inhaber: Rolle = hrhr, Status = active', hrhrUser.role === 'hrhr' && hrhrUser.status === 'active', `${hrhrUser.role}/${hrhrUser.status}`);
  ok('Inhaber: is_root gesetzt (festegelegter Inhaber)', hrhrUser.is_root === 1);
  ok('Inhaber: E-Mail kommt aus Discord', hrhrUser.email === 'jlg09@example.com', hrhrUser.email);

  r = await get('/admin/accounts', hrhrCookie);
  ok('Inhaber: Nutzerverwaltung erreichbar', r.status === 200 && r.body.includes('Nutzerverwaltung'));

  // Passwort-Login existiert nicht mehr -> Route weg (404)
  r = await post('/auth/login', { identifier: 'jlg09@example.com', password: 'x' });
  ok('Kein E-Mail/Passwort-Login mehr (Route entfernt)', r.status === 404, `Status ${r.status}`);

  // ==================================================================
  // 2) Nutzer loggt sich per Discord ein, Inhaber ernennt ihn zum Team
  // ==================================================================
  let hrCookie = await discordLogin('max.mustermann', 'Max Mustermann', 'max@beispiel.de');
  ok('Nutzer: Discord-Login liefert Session', hrCookie.length > 0);

  const maxUser = db.prepare("SELECT * FROM users WHERE discord_username = 'max.mustermann'").get();
  ok('Nutzer: Rolle = user, Status = active (Standard nach erstem Login)', maxUser && maxUser.role === 'user' && maxUser.status === 'active', maxUser ? `${maxUser.role}/${maxUser.status}` : 'fehlt');

  // Ohne Einladung: kein Onboarding-Link, kein Passwort-Link erreichbar
  r = await get('/invite/egal', hrhrCookie);
  ok('Einladungslink existiert nicht mehr (404)', r.status === 404, `Status ${r.status}`);
  r = await get('/onboard/password', maxUser ? await cookieFor(maxUser.id) : '');
  ok('Onboarding-Route existiert nicht mehr (404)', r.status === 404, `Status ${r.status}`);

  // Inhaber ernennt den Nutzer per Rollenvergabe zum Team
  r = await post(`/admin/accounts/${maxUser.id}/role`, { role: 'hr' }, hrhrCookie);
  ok('Inhaber: Nutzer zum Team ernannt', r.status === 302 && r.location === '/admin/accounts');
  const hrUser = db.prepare('SELECT * FROM users WHERE id = ?').get(maxUser.id);
  ok('Team: Rolle = hr, bleibt aktiv', hrUser && hrUser.role === 'hr' && hrUser.status === 'active', hrUser ? `${hrUser.role}/${hrUser.status}` : 'fehlt');

  r = await get('/dashboard', hrCookie);
  ok('Team: Dashboard erreichbar, Rolle Team', r.status === 200 && r.body.includes('Meine Tickets'));

  // ==================================================================
  // 3) Normaler Nutzer per Discord (nicht authorisiert, mit E-Mail)
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
  // Ticket-Erstellung: HR/HR-HR mit notify_changes=1 erhalten Push
  db.prepare('UPDATE users SET notify_changes = 1 WHERE id = ?').run(hrUser.id);
  const pushedTo = [];
  const origSend = pushModule.sendToUser;
  pushModule.sendToUser = (userId, payload) => { pushedTo.push({ userId, payload }); };
  r = await postForm('/tickets', ticketForm, userCookie);
  pushModule.sendToUser = origSend;
  ok('Ticket-Erstellung (Nutzer) mit Anhang leitet zum Ticket', r.status === 302 && /^\/tickets\/\d+$/.test(r.location), r.location);
  const hrPushed = pushedTo.some((p) => p.userId === hrUser.id && /Neues Ticket #/.test(p.payload.title) && p.payload.url);
  ok('Ticket-Erstellung: Team erhaelt Push-Benachrichtigung', hrPushed, JSON.stringify(pushedTo.map((p) => ({ uid: p.userId, title: p.payload.title }))));
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

  // "Zum Schließen Freigeben" erst möglich, wenn das Ticket übernommen wurde
  r = await get(ticketUrl + '?ctx=admin', hrCookie);
  ok('Ohne Übernahme: kein "Zum Schließen Freigeben"-Button', !r.body.includes('Zum Schließen Freigeben'), 'Button trotzdem sichtbar');
  r = await post(`/admin/tickets/${ticketId}/release`, {}, hrCookie);
  const noClaimTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Ohne Übernahme: Freigabe abgelehnt, Ticket bleibt offen', r.status === 302 && noClaimTicket.status === 'open', `status=${noClaimTicket.status}`);

  // Write-Lock: nur ein Bearbeiter darf gleichzeitig in einem Ticket eintragen
  const hr2Id = db.prepare("INSERT INTO users (discord_id, discord_username, username, role, status) VALUES ('600','hr2','HR2','hr','active')").run().lastInsertRowid;
  const hr2Cookie = await cookieFor(hr2Id);

  r = await postJson(`/admin/tickets/${ticketId}/lock`, { action: 'acquire' }, hrCookie);
  ok('Bearbeiter erhaelt Write-Lock', r.status === 200 && JSON.parse(r.body).ok === true, `Status ${r.status}`);
  r = await postJson(`/admin/tickets/${ticketId}/lock`, { action: 'acquire' }, hr2Cookie);
  ok('Lock: zweiter Bearbeiter blockiert (409)', r.status === 409, `Status ${r.status}`);
  r = await post(ticketUrl + '/message', { body: 'Blockierte Eingabe' }, hr2Cookie);
  const blockedMsgCount = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE ticket_id = ? AND body = 'Blockierte Eingabe'").get(ticketId).c;
  ok('Lock: blockierte Eingabe wird nicht gespeichert', r.status === 302 && blockedMsgCount === 0, `count=${blockedMsgCount}`);
  r = await postJson(`/admin/tickets/${ticketId}/lock`, { action: 'release' }, hrCookie);
  ok('Bearbeiter gibt Write-Lock ab', r.status === 200 && JSON.parse(r.body).ok === true, `Status ${r.status}`);
  r = await postJson(`/admin/tickets/${ticketId}/lock`, { action: 'acquire' }, hr2Cookie);
  ok('Lock: nach Freigabe kann zweiter Bearbeiter uebernehmen', r.status === 200 && JSON.parse(r.body).ok === true, `Status ${r.status}`);
  await postJson(`/admin/tickets/${ticketId}/lock`, { action: 'release' }, hr2Cookie);

  // HR claimt das Ticket -> nur der Claimer darf es bearbeiten
  r = await post(`/admin/tickets/${ticketId}/claim`, {}, hrCookie);
  ok('HR claimt Ticket', r.status === 302 && r.location === ticketUrl + '?ctx=admin', r.location);
  const claimedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Claim: claimed_by gesetzt + Status pending', claimedTicket.claimed_by === hrUser.id && claimedTicket.status === 'pending', `by=${claimedTicket.claimed_by} status=${claimedTicket.status}`);
  ok('Claim: Faelligkeit wurde gesetzt', !!claimedTicket.due_at, claimedTicket.due_at || 'fehlt');

  r = await get(ticketUrl, hrCookie);
  ok('Meine-Tickets-Kontext: keine Verwaltungs-Buttons', !r.body.includes('Freigeben') && !r.body.includes('Zum Schließen Freigeben'), 'Buttons trotzdem sichtbar');
  r = await get(ticketUrl + '?ctx=admin', hrCookie);
  ok('Bearbeiter sieht "Freigeben"-Button nach Übernahme', r.body.includes('Freigeben'), 'Freigeben fehlt');
  r = await get(ticketUrl + '?ctx=admin', hrhrCookie);
  ok('Jeder Bearbeiter sieht "Zum Schließen Freigeben"-Button', r.body.includes('Zum Schließen Freigeben'), 'Zum Schließen Freigeben fehlt');

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

  // Fälligkeit + nächste Aktion setzen (Datumsangabe)
  const future = new Date(Date.now() + 48 * 3600 * 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const futureLocal = `${future.getFullYear()}-${pad2(future.getMonth() + 1)}-${pad2(future.getDate())}T${pad2(future.getHours())}:${pad2(future.getMinutes())}`;
  r = await post(`/admin/tickets/${ticketId}/due`, { due_at: futureLocal, next_action: config.nextActions[0] }, hrCookie);
  ok('HR setzt Faelligkeit + naechste Aktion', r.status === 302);
  const dueTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Faelligkeit: due_at gesetzt + naechste Aktion', !!dueTicket.due_at && dueTicket.next_action === config.nextActions[0], `due=${dueTicket.due_at} act=${dueTicket.next_action}`);

  // Übergabe: HR uebergibt an HR-HR (mit Begründung)
  r = await post(`/admin/tickets/${ticketId}/transfer`, { assignee: String(hrhrUser.id), reason: 'Weil HR-HR das Problem kennt' }, hrCookie);
  ok('HR uebergibt Ticket an HR-HR', r.status === 302 && r.location === ticketUrl + '?ctx=admin', r.location);
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

  // Inhaber: Schließen ist nur möglich, wenn der Bearbeiter das Ticket zur
  // Freigabe vorgelegt hat (Status "release"). Ohne Freigabe bleibt es offen.
  r = await post(ticketUrl + '/close', {}, hrhrCookie);
  const afterWarn = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Inhaber: Schliessen ohne Freigabe-Status abgelehnt, Ticket bleibt offen', r.status === 302 && afterWarn.status === 'open', `status=${afterWarn.status}`);
  db.prepare("UPDATE tickets SET status = 'release' WHERE id = ?").run(ticketId);
  r = await post(ticketUrl + '/close', {}, hrhrCookie);
  const closedAfterRelease = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Inhaber: schliesst Ticket bei Freigabe-Status', r.status === 302 && closedAfterRelease.status === 'closed', `status=${closedAfterRelease.status}`);

  // Geschlossene Tickets dürfen nicht mehr freigegeben werden
  r = await post(`/admin/tickets/${ticketId}/release`, {}, hrCookie);
  const closedForRelease = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Geschlossenes Ticket: Freigabe abgelehnt', r.status === 302 && closedForRelease.status === 'closed', `status=${closedForRelease.status}`);

  r = await post(ticketUrl + '/reopen', {}, hrhrCookie);
  ok('Inhaber: wieder geoeffnet', r.status === 302);
  const reopened2 = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Reopen: Status open', reopened2.status === 'open');

  // Manueller Statuswechsel durch Bearbeiter
  r = await post(`/admin/tickets/${ticketId}/status`, { status: 'pending' }, hrCookie);
  const manStatus = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Bearbeiter setzt Status manuell (In Bearbeitung)', r.status === 302 && manStatus.status === 'pending', `status=${manStatus.status}`);
  r = await post(`/admin/tickets/${ticketId}/status`, { status: 'open' }, hrCookie);
  const manStatus2 = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  ok('Bearbeiter setzt Status manuell (Offen)', r.status === 302 && manStatus2.status === 'open', `status=${manStatus2.status}`);

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
  ok('Inhaber: Audit-Log-Seite erreichbar', r.status === 200 && r.body.includes('Audit-Log'));
  r = await get('/admin/logs', hrCookie);
  ok('Team: Audit-Log verboten (403)', r.status === 403);

  // Rückstufung Team -> Nutzer durch den Inhaber
  r = await post(`/admin/accounts/${hrUser.id}/role`, { role: 'user' }, hrhrCookie);
  ok('Inhaber: Team zum Nutzer zurueckgestuft', r.status === 302);
  const downgraded = db.prepare('SELECT * FROM users WHERE id = ?').get(hrUser.id);
  ok('Rolle = user nach Rueckstufung', downgraded.role === 'user', downgraded.role);
  // Zurueck zum Team, damit der Rest des Tests weiterlaufen kann
  r = await post(`/admin/accounts/${hrUser.id}/role`, { role: 'hr' }, hrhrCookie);
  ok('Inhaber: wieder zum Team ernannt', r.status === 302);

  r = await post(`/admin/accounts/${hrUser.id}/disable`, { reason: 'Schlechte Performance' }, hrhrCookie);
  ok('Inhaber: Team deaktiviert (mit Grund)', r.status === 302 && r.location === '/admin/accounts');
  mail = findMail('deaktiviert');
  ok('Deaktivierung: E-Mail an Betroffenen', !!mail, mail ? mail.subject : 'keine Mail');
  ok('Deaktivierung: E-Mail enthaelt Begruendung', mail && mail.raw.includes('Schlechte Performance'));

  const disabledUser = db.prepare('SELECT * FROM users WHERE id = ?').get(hrUser.id);
  ok('Deaktivierung: Status = disabled', disabledUser.status === 'disabled' && disabledUser.disabled_reason === 'Schlechte Performance');

  // Deaktivierter Nutzer wird ausgeloggt (Session-Guard zerstört Session)
  r = await get('/dashboard', hrCookie);
  ok('Deaktivierter kann nicht mehr auf geschuetzte Seiten', r.status === 302 && r.location === '/login', `${r.status} ${r.location}`);

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

  // Gelöschtes Konto kann reaktiviert werden
  r = await post(`/admin/accounts/${hrUser.id}/enable`, { reason: 'Fehler, Konto wiederhergestellt' }, hrhrCookie);
  ok('HR-HR: geloeschtes Konto kann reaktiviert werden', r.status === 302 && r.location === '/admin/accounts');
  const revivedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(hrUser.id);
  ok('Reaktivierung nach Loeschung: Status = active', revivedUser.status === 'active');

  // Löschen ohne Datumsangabe = sofort (unbegrenzt)
  r = await post(`/admin/accounts/${hrUser.id}/delete`, { reason: 'Sofortloeschung ohne Datum' }, hrhrCookie);
  ok('HR-HR: Loeschung ohne Datum sofort ausgefuehrt', r.status === 302 && r.location === '/admin/accounts');
  const deletedNow = db.prepare('SELECT * FROM users WHERE id = ?').get(hrUser.id);
  ok('Sofortloeschung: Status = deleted', deletedNow.status === 'deleted' && deletedNow.delete_at === null);


  // Löschen eines HR-HR nicht moeglich
  r = await post(`/admin/accounts/${hrhrUser.id}/delete`, { reason: 'x' }, hrhrCookie);
  ok('HR-HR: HR-HR kann nicht geloescht werden', r.status === 400);

  const logCount = db.prepare('SELECT COUNT(*) AS c FROM account_logs').get().c;
  ok('Audit-Log protokolliert Konto-Aktionen', logCount >= 5, `Eintraege: ${logCount}`);

  // Leere Aktion in der Vergangenheit: Die UI zeigt einen Fallback statt einer leeren Spalte
  db.prepare("INSERT INTO account_logs (account_id, actor_id, action, reason) VALUES (?, ?, '', 'Test leerer Action')").run(normalUser.id, hrhrUser.id);
  r = await get('/admin/accounts', hrhrCookie);
  ok('Audit-Log: leere Aktion zeigt Fallback statt nichts', r.body.includes('Unbekannt'), 'Unbekannt fehlt');
  r = await get('/admin/logs', hrhrCookie);
  ok('Audit-Log-Seite: leere Aktion zeigt Fallback', r.body.includes('Unbekannt'));

  // Aktionen-Backfill: Leere Aktionen werden beim Start aus Details/Begruendung rekonstruiert
  db.prepare("INSERT INTO account_logs (account_id, actor_id, action, reason) VALUES (?, ?, '', 'IT-Alarm gesetzt.')").run(normalUser.id, hrhrUser.id);
  db.prepare("INSERT INTO ticket_logs (ticket_id, actor_id, action, details) VALUES (?, ?, '', 'Ticket geschlossen')").run(ticketId, hrhrUser.id);
  migrateLogActions();
  const backfilledAccount = db.prepare("SELECT action FROM account_logs WHERE reason = 'IT-Alarm gesetzt.'").get();
  const backfilledTicket = db.prepare("SELECT action FROM ticket_logs WHERE details = 'Ticket geschlossen'").get();
  ok('Backfill: Konto-Aktion aus Begruendung rekonstruiert', backfilledAccount && backfilledAccount.action === 'alarm_set', `action=${backfilledAccount && backfilledAccount.action}`);
  ok('Backfill: Ticket-Aktion aus Details rekonstruiert', backfilledTicket && backfilledTicket.action === 'closed', `action=${backfilledTicket && backfilledTicket.action}`);
  ok('LogLabel: bekannte Aktion -> deutsches Label', logActionLabel('created') === 'Erstellt', logActionLabel('created'));
  ok('LogLabel: unbekannte Aktion -> Unbekannt', logActionLabel('') === 'Unbekannt');
  ok('LogLabel: Legacy-Aktion activated -> deutsches Label', logActionLabel('activated') === 'Konto aktiviert', logActionLabel('activated'));
  ok('LogLabel: Legacy-Aktion invited -> deutsches Label', logActionLabel('invited') === 'Eingeladen', logActionLabel('invited'));
  ok('LogLabel: Legacy-Aktion password_reset -> deutsches Label', logActionLabel('password_reset') === 'Passwort zurückgesetzt', logActionLabel('password_reset'));
  ok('LogLabel: Grossbuchstaben-Key case-insensitiv', logActionLabel('ACTIVATED') === 'Konto aktiviert', logActionLabel('ACTIVATED'));

  // Turso-Szenario: Die Action-Spalte heisst dort historisch "ACTION"
  // (grossgeschrieben). SQL ist case-insensitiv, JS liest aber case-sensitiv
  // -> ohne Normalisierung ergibt l.action undefined und die UI zeigt
  // ueberall "Unbekannt". Die Normalisierung muss den Key angleichen.
  db.prepare('DROP TABLE IF EXISTS upper_log').run();
  db.prepare('CREATE TABLE upper_log (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, actor_id INTEGER, ACTION TEXT, reason TEXT)').run();
  db.prepare("INSERT INTO upper_log (account_id, actor_id, ACTION, reason) VALUES (?, ?, 'alarm_set', 'Upper-Case-Spalte')").run(normalUser.id, hrhrUser.id);
  const rawRow = db.prepare('SELECT * FROM upper_log').get();
  ok('Turso-Szenario: SELECT * liefert Key ACTION (gross)', rawRow && rawRow.ACTION === 'alarm_set' && rawRow.action === undefined, JSON.stringify(rawRow));
  const normRow = { ...rawRow, action: rawRow.ACTION };
  ok('Turso-Szenario: Normalisierung stellt action bereit', normRow.action === 'alarm_set');
  ok('Turso-Szenario: Label korrekt nach Normalisierung', logActionLabel(normRow.action) === 'Meldung angezeigt', logActionLabel(normRow.action));
  db.prepare('DROP TABLE upper_log').run();

  // Legacy-Backfill: alte Detail-/Begruendungstexte werden korrekt rekonstruiert
  const legacyCases = [
    { table: 'account_logs', col: 'reason', text: 'E-Mail verifiziert, Konto aktiviert', want: 'activated' },
    { table: 'account_logs', col: 'reason', text: 'HR-Einladung abgeschlossen, Passwort gesetzt', want: 'activated' },
    { table: 'account_logs', col: 'reason', text: 'Passwort per "Vergessen"-Link zurückgesetzt', want: 'password_reset' },
    { table: 'account_logs', col: 'reason', text: 'Passwort-Reset per Admin ausgelöst', want: 'password_reset' },
    { table: 'account_logs', col: 'reason', text: 'Eingeladen als HR (test, test@example.com)', want: 'invited' },
    { table: 'account_logs', col: 'reason', text: 'HR-HR-Account per Discord-Registrierung angelegt', want: 'hrhr_created' },
    { table: 'account_logs', col: 'reason', text: 'Reaktiviert', want: 'enabled' },
    { table: 'ticket_logs', col: 'details', text: 'Freigabe zur Schliessung beantragt (Abschlussbericht eingereicht)', want: 'release_requested' },
  ];
  for (const c of legacyCases) {
    db.prepare(`INSERT INTO ${c.table} (${c.table === 'account_logs' ? 'account_id, actor_id' : 'ticket_id, actor_id'}, action, ${c.col}) VALUES (?, ?, ?, ?)`)
      .run(c.table === 'account_logs' ? normalUser.id : ticketId, hrhrUser.id, 'unbekannt', c.text);
  }
  migrateLogActions();
  for (const c of legacyCases) {
    const row = db.prepare(`SELECT action FROM ${c.table} WHERE ${c.col} = ?`).get(c.text);
    ok(`Backfill: "${c.text.slice(0, 30)}" -> ${c.want}`, row && row.action === c.want, `action=${row && row.action}`);
  }

  // ==================================================================
  // 8) Kontoeinstellungen + Benachrichtigungen
  // ==================================================================
  r = await get('/account/settings', userCookie);
  ok('Kontoeinstellungen erreichbar', r.status === 200 && r.body.includes('Kontoeinstellungen'));
  r = await post('/account/settings', { notify_changes: '1' }, userCookie);
  ok('Kontoeinstellungen: Benachrichtigungen aktiviert', r.status === 302 && r.location === '/account/settings');
  const notifyUser = db.prepare('SELECT * FROM users WHERE id = ?').get(normalUser.id);
  ok('notify_changes = 1 gespeichert', notifyUser.notify_changes === 1, `value=${notifyUser.notify_changes}`);

  // Polling-Endpoint: nur eigene Tickets fuer Nutzer
  const t = db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 1').get();
  r = await get(`/api/tickets/updates?since=${encodeURIComponent('2020-01-01T00:00:00.000Z')}`, userCookie);
  ok('Benachrichtigungs-API liefert JSON', r.status === 200 && r.body.includes('tickets'));
  const updates = JSON.parse(r.body);
  const hasOwn = updates.tickets.some((x) => x.id === t.id);
  ok('Nutzer: eigenes Ticket in Updates enthalten', hasOwn);

  r = await get('/api/tickets/updates?since=kaputt', userCookie);
  ok('Benachrichtigungs-API: ungueltiges since -> 400', r.status === 400);

  // Web-Push-Subscription-API
  r = await postJson('/api/push/subscribe', {
    subscription: { endpoint: 'https://push.example/x', keys: { auth: 'YQ==', p256dh: 'YWJj' } },
  }, userCookie);
  ok('Push: Subscription gespeichert', r.status === 200 && r.body.includes('ok'));
  r = await postJson('/api/push/subscribe', { subscription: {} }, userCookie);
  ok('Push: ungueltige Subscription -> 400', r.status === 400);
  r = await postJson('/api/push/unsubscribe', { endpoint: 'https://push.example/x' }, userCookie);
  ok('Push: Unsubscribe ok', r.status === 200 && r.body.includes('ok'));

  // Discord-Rollen steuern den Zugriff auf "Interne Links"
  // Nav ist fuer normale Nutzer auf "Home" reduziert -> kein "Interne Links"-Menue,
  // aber die Tool-Kacheln auf der Home-Seite bleiben bei passender Discord-Rolle sichtbar.
  r = await get('/', userCookie);
  ok('Nutzer: keine internen Links im Menue', !r.body.includes('Interne Links'));
  const allowedRole = config.staffDiscordRoleIds && config.staffDiscordRoleIds[0];
  const firstStaffLabel = config.staffLinks && config.staffLinks[0] && config.staffLinks[0].label;
  if (allowedRole && firstStaffLabel) {
    db.prepare('UPDATE users SET discord_roles = ? WHERE id = ?').run(allowedRole, normalUser.id);
    r = await get('/', userCookie);
    ok('Nutzer mit Discord-Rolle: interne Link-Kachel sichtbar (kein Menue)', r.body.includes(firstStaffLabel) && !r.body.includes('Interne Links'));
  }

  // Ohne Login: Einstellungen nicht erreichbar
  r = await get('/account/settings');
  ok('Kontoeinstellungen ohne Login -> Login-Weiterleitung', r.status === 302 && r.location === '/login');

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

  // ==================================================================
  // 10) Admin-Optionen (Meldungen, IT-Alarm) + Backups
  // ==================================================================
  let lockUser = await discordLogin('lockuser', 'LockUser', 'lock@example.com');

  // Meldung: einfacher gelber Hinweis-Banner oben, ohne Ton, ohne Sperre
  r = await post('/account/settings/admin/alarm', { action: 'set', text: 'Wartung am Freitag' }, hrhrCookie);
  ok('Meldung: durch Inhaber gesetzt', r.status === 302);
  r = await get('/', lockUser);
  ok('Meldung: gelber Banner oben ohne Ton/Auto-Logout', r.body.includes('Meldung') && r.body.includes('Wartung am Freitag') && r.body.includes('notice-banner') && !r.body.includes('data-countdown'));
  r = await get('/api/status');
  let statusJson = JSON.parse(r.body);
  ok('API-Status: Meldung aktiv (ohne Sperre)', statusJson.meldung && statusJson.meldung.active === true && !statusJson.meldung.locked, r.body.slice(0, 160));
  r = await post('/account/settings/admin/alarm', { action: 'clear' }, hrhrCookie);
  ok('Meldung: durch Inhaber entfernt', r.status === 302);
  r = await get('/');
  ok('Meldung: Banner nach Entfernen weg', !r.body.includes('Wartung am Freitag'));

  // IT-Alarm (früher "Zugriff sperren"): rote Vollbild-Meldung + Ton + Sperre
  r = await post('/account/settings/admin/lockdown', { action: 'enable', message: 'Wegen Wartung' }, hrhrCookie);
  ok('IT-Alarm: durch Inhaber ausgeloest', r.status === 302);
  r = await get('/api/status');
  statusJson = JSON.parse(r.body);
  ok('API-Status: oeffentlich erreichbar', r.status === 200 && statusJson.lockdown && statusJson.lockdown.enabled === true, r.body.slice(0, 120));
  r = await get('/dashboard', lockUser);
  ok('IT-Alarm: nicht-Inhaber wird abgemeldet', r.status === 302 && r.location === '/login?locked=1');
  r = await get('/login?locked=1');
  ok('IT-Alarm: Login-Seite zeigt Sperrmeldung', r.body.includes('Wegen Wartung') && r.body.includes('IT-Alarm'));
  r = await get('/dashboard', hrhrCookie);
  ok('IT-Alarm: Inhaber hat weiterhin Zugriff + hoert den Alarmton', r.status === 200 && r.body.includes('Meine Tickets') && r.body.includes('isRootUser = true') && r.body.includes('playAlarm'), `${r.status}`);
  r = await post('/account/settings/admin/lockdown', { action: 'disable' }, hrhrCookie);
  ok('IT-Alarm: durch Inhaber beendet', r.status === 302);
  r = await get('/api/status');
  statusJson = JSON.parse(r.body);
  ok('API-Status: nach Beenden wieder offen', statusJson.lockdown && statusJson.lockdown.enabled === false);
  lockUser = await discordLogin('lockuser', 'LockUser', 'lock@example.com');
  r = await get('/dashboard', lockUser);
  ok('IT-Alarm: Vollbild-Overlay-Script fuer eingeloggte Bearbeiter', r.status === 200 && r.body.includes('it-alarm-overlay') && r.body.includes('/api/status'));

  // Nicht-Inhaber darf Admin-Optionen nicht nutzen
  r = await post('/account/settings/admin/restart', {}, userCookie);
  ok('Admin-Optionen: normaler Nutzer verweigert (403)', r.status === 403);

  // Backups: manuell erstellen, Slots, Download, loeschen, alles loeschen
  const backupsBefore = db.prepare('SELECT COUNT(*) AS c FROM backups').get().c;
  r = await post('/account/settings/admin/backups/create', {}, hrhrCookie);
  ok('Backup: manuell erstellt', r.status === 302);
  ok('Backup: ein Eintrag hinzugefuegt', db.prepare('SELECT COUNT(*) AS c FROM backups').get().c === backupsBefore + 1);
  r = await get('/account/settings', hrhrCookie);
  ok('Backup: Slots-Hinweis + Liste sichtbar', r.body.includes('Slots frei') && r.body.includes('Download'));
  const backupRow = db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 1').get();
  r = await get(`/account/settings/admin/backups/${backupRow.id}/download`, hrhrCookie);
  ok('Backup: Download liefert JSON mit Nutzer-/Ticketdaten', r.status === 200 && r.body.includes('users') && r.body.includes('tickets'));
  r = await post(`/account/settings/admin/backups/${backupRow.id}/delete`, {}, hrhrCookie);
  ok('Backup: einzelnes Backup loeschbar', r.status === 302);
  ok('Backup: Eintrag wieder entfernt', db.prepare('SELECT COUNT(*) AS c FROM backups').get().c === backupsBefore);
  r = await post('/account/settings/admin/backups/clear', {}, hrhrCookie);
  ok('Backup: alle Backups loeschen (jlg09)', r.status === 302);
  ok('Backup: nach clear alle weg', db.prepare('SELECT COUNT(*) AS c FROM backups').get().c === 0);

  // Session-Lebensdauer: Discord-Login-Cookie laeuft in 14 Tagen ab
  const freshAuth = await get('/auth/discord');
  const freshState = new URL(freshAuth.location).searchParams.get('state');
  mockDiscord = { id: String(Date.now() + 9e6), username: 'frisch', global_name: 'Frisch', email: 'frisch@example.com', verified: true };
  const freshCb = await get(`/auth/callback?code=FAKECODE&state=${freshState}`);
  const setCookie = (freshCb.headers && freshCb.headers.get && freshCb.headers.get('set-cookie')) || freshCb.setCookie || '';
  const maxAge = /Max-Age=(\d+)/.exec(setCookie);
  const expires = /Expires=([^;]+)/.exec(setCookie);
  const daysUntil = expires ? (new Date(expires[1]).getTime() - Date.now()) / (24 * 3600 * 1000) : null;
  const ok14d = maxAge ? Number(maxAge[1]) === 14 * 24 * 60 * 60 : (daysUntil !== null && daysUntil >= 13 && daysUntil <= 15);
  ok('Session-Cookie: 14 Tage Laufzeit', ok14d, maxAge ? `Max-Age=${maxAge[1]}` : expires ? `Expires in ${daysUntil.toFixed(1)} Tagen` : 'kein Ablaufdatum');

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
