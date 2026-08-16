'use strict';

const { db, getSetting, setSetting } = require('./db');
const config = require('./config');

// Websites, die Meldungen über /api/status und den gelben Banner empfangen.
const SITES = {
  tickets: 'TicketSystem MRB',
  anwesenheit: 'Anwesenheits-Tool',
  befehl: 'MRB-OnlineBefehl',
};
const SITE_KEYS = Object.keys(SITES);

const ROLE_LABELS = { user: 'Nutzer', hr: 'Team', hrhr: 'Inhaber' };
const STATUS_LABELS = {
  active: 'Aktiv',
  disabled: 'Deaktiviert',
  deleted: 'Gelöscht',
};

const TICKET_STATUS_LABELS = {
  open: 'Offen',
  pending: 'In Bearbeitung',
  release: 'Freigabe',
  closed: 'Geschlossen',
};

function isHR(u) {
  return !!(u && (u.role === 'hr' || u.role === 'hrhr'));
}

function isHRHR(u) {
  return !!(u && u.role === 'hrhr');
}

// "Im Script festgelegte" HR-HR (kommen aus AUTHORIZED_DISCORD_USERNAMES):
// einzige Nutzer mit Zugriff auf Account-Verwaltung, Logs und Rechtevergabe.
function isRoot(u) {
  return !!(u && u.role === 'hrhr' && u.is_root === 1);
}

function isActive(u) {
  return !!(u && u.status === 'active');
}

// Hat der Nutzer eine der in der Konfiguration hinterlegten Discord-Rollen
// (staffDiscordRoleIds)? Gespeichert wird das beim Login in user.discord_roles.
function hasStaffDiscordRole(u) {
  if (!u || !u.discord_roles) return false;
  const roles = String(u.discord_roles).split(',').map((s) => s.trim()).filter(Boolean);
  if (!roles.length) return false;
  const allowed = config.staffDiscordRoleIds || [];
  return roles.some((r) => allowed.includes(String(r)));
}

// Zugriff auf "Interne Links" / interne Bereiche: Team/Inhaber (Rolle im
// System) ODER Nutzer mit einer freigeschalteten Discord-Rolle.
function canViewStaffLinks(u) {
  return isHR(u) || hasStaffDiscordRole(u);
}

// Ticket ist ueberfaellig, wenn das Fälligkeitsdatum in der Vergangenheit
// liegt und das Ticket nicht geschlossen ist.
function isOverdue(ticket) {
  return !!(ticket && ticket.due_at && ticket.status !== 'closed' && new Date(ticket.due_at) < new Date());
}

// Bearbeiten-Recht fuer ein Ticket: Wenn das Ticket geclaimt wurde, darf
// ausschliesslich der Claimer es bearbeiten. Ungeclaimt: HR/HR-HR oder der Ersteller.
function canEditTicket(user, ticket) {
  if (!user || !ticket) return false;
  if (ticket.claimed_by) return user.id === ticket.claimed_by;
  return isHR(user) || ticket.user_id === user.id;
}

function loadUser(req, res, next) {
  if (req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    req.user = user || null;
    if (!user) req.session.destroy(() => {});
  }
  res.locals.user = req.user || null;
  res.locals.isHR = isHR(req.user);
  res.locals.isHRHR = isHRHR(req.user);
  res.locals.isRoot = isRoot(req.user);
  res.locals.canStaffLinks = canViewStaffLinks(req.user);
  res.locals.roleLabel = (r) => ROLE_LABELS[r] || r;
  res.locals.statusLabel = (s) => STATUS_LABELS[s] || s;
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireHR(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (!isHR(req.user)) {
    return res.status(403).render('error', {
      title: 'Kein Zugriff',
      message: 'Du hast keine Berechtigung fuer diese Seite. Nur Team-Mitarbeiter duerfen Tickets bearbeiten.',
      code: 403,
    });
  }
  next();
}

function requireHRHR(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (!isHRHR(req.user)) {
    return res.status(403).render('error', {
      title: 'Kein Zugriff',
      message: 'Nur Inhaber duerfen die Nutzerverwaltung nutzen.',
      code: 403,
    });
  }
  next();
}

// Nur im Script festgelegte HR-HR (is_root) duerfen Account-Verwaltung,
// Logs und Rechtevergabe nutzen.
function requireRoot(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (!isRoot(req.user)) {
    return res.status(403).render('error', {
      title: 'Kein Zugriff',
      message: 'Diese Seite ist nur fuer festgelegte Inhaber-Accounts (aus der Konfiguration) freigegeben.',
      code: 403,
    });
  }
  next();
}

// Es gibt kein Onboarding mehr (keine Einladungen, kein Passwort-Setup):
// Jeder Account ist direkt nach dem Discord-Login aktiv. Einzige Sperre ist
// die Konto-Deaktivierung/-Loeschung durch den Inhaber.
function onboardingGuard(req, res, next) {
  if (!req.user) return next();
  if (req.path.startsWith('/auth') || req.path === '/logout') {
    return next();
  }
  // Statische Dateien (CSS/JS/Bilder) und Datei-Downloads muessen immer
  // durchgelassen werden, sonst leitet der Guard z. B. /static/css/style.css
  // auf /login um und der Browser verwirft das HTML als Stylesheet.
  if (req.path.startsWith('/static/') || req.path.startsWith('/file/') || req.path === '/healthz') {
    return next();
  }
  if (req.user.status === 'disabled' || req.user.status === 'deleted') {
    req.session.destroy(() => {});
    return res.redirect('/login');
  }
  return next();
}

// Liest die Lockdown-Einstellung (JSON) aus den Settings.
function getLockdown() {
  const raw = getSetting('system_lockdown');
  if (!raw) return null;
  try {
    const lock = JSON.parse(raw);
    return lock && lock.enabled ? lock : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Meldungen (früher "IT-Alarm"): Einfacher Hinweis-Banner (gelb) oben auf allen
// Seiten für alle eingeloggten Nutzer – ohne Ton, ohne Sperre. Seit dem
// Update können mehrere Meldungen gleichzeitig gesetzt werden, jeweils gezielt
// für eine Auswahl an Websites (tickets / anwesenheit / befehl). Eine leere
// websites-Liste bedeutet "alle Websites".
// ---------------------------------------------------------------------------

function migrateLegacyAlarm() {
  const legacy = getSetting('it_alarm');
  if (!legacy) return;
  try {
    const a = JSON.parse(legacy);
    if (a && a.text) {
      addMessage({
        text: String(a.text).trim(),
        websites: [],
        set_by: a.set_by || null,
        set_at: a.set_at || new Date().toISOString(),
      });
    }
  } catch {}
  setSetting('it_alarm', '');
}

function listMessages() {
  const raw = getSetting('it_messages');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((m) => m && m.text) : [];
  } catch {
    return [];
  }
}

function saveMessages(messages) {
  setSetting('it_messages', JSON.stringify(messages));
}

function addMessage(msg) {
  const messages = listMessages();
  messages.push({
    id: msg.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    text: String(msg.text || '').trim(),
    websites: Array.isArray(msg.websites)
      ? [...new Set(msg.websites.filter((w) => SITE_KEYS.includes(w)))]
      : [],
    set_by: msg.set_by || null,
    set_at: msg.set_at || new Date().toISOString(),
  });
  saveMessages(messages);
  return messages;
}

function removeMessage(id) {
  saveMessages(listMessages().filter((m) => m.id !== id));
}

// Liefert alle Meldungen; optional gefiltert auf eine Website. Meldungen ohne
// Website-Auswahl gelten für alle Websites.
function getMessages(site) {
  const all = listMessages();
  if (!site || !SITE_KEYS.includes(site)) return all;
  return all.filter((m) => !m.websites || m.websites.length === 0 || m.websites.includes(site));
}

// Meldungen für die Haupt-App (TicketSystem MRB) – Rückwärtskompatibel für
// bestehende Aufrufer, liefert jetzt aber ein Array statt eines Objekts.
function getAlarm() {
  return getMessages('tickets');
}

// Zugriff für alle sperren (außer dem festgelegten Inhaber): Sobald der
// Lockdown aktiv ist, wird jeder eingeloggte Nicht-Inhaber sofort ausgeloggt
// (Session zerstört) – egal auf welcher Seite (auch /login, damit ein Umweg
// über die Login-Seite nicht die Session erhält). Öffentliche Seiten
// (Startseite, Login, statische Dateien) bleiben für anonyme Besucher
// erreichbar, damit die Sperrmeldung sichtbar ist; anonyme Besucher werden
// zusätzlich clientseitig nach 4 s zur Login-Seite geleitet.
function lockdownGuard(req, res, next) {
  if (req.path === '/healthz') return next();
  const lock = getLockdown();
  if (!lock) return next();
  // Der festgelegte Inhaber (is_root) hat immer Zugriff und bleibt eingeloggt.
  if (isRoot(req.user)) return next();
  // Jeder eingeloggte Nicht-Inhaber verliert sofort den Zugriff.
  if (req.user) {
    req.session.destroy(() => {});
    res.locals.user = null;
    return res.redirect('/login?locked=1');
  }
  // Öffentliche Seiten (Startseite, Login, statische Dateien) bleiben
  // erreichbar, damit die Sperrmeldung sichtbar ist.
  if (req.path === '/' || req.path === '/login' || req.path === '/sw.js' ||
      req.path === '/impressum' || req.path === '/datenschutz' || req.path === '/api/status' ||
      req.path.startsWith('/auth/') || req.path.startsWith('/static/')) return next();
  return res.redirect('/login?locked=1');
}

function categories() {
  return config.categories;
}

function nextActions() {
  return config.nextActions;
}

function priorities() {
  return ['low', 'medium', 'high', 'urgent'];
}

function priorityLabel(p) {
  return { low: 'Niedrig', medium: 'Mittel', high: 'Hoch', urgent: 'Kritisch' }[p] || p;
}

function statusLabel(s) {
  return TICKET_STATUS_LABELS[s] || s;
}

module.exports = {
  loadUser,
  requireLogin,
  requireHR,
  requireHRHR,
  requireRoot,
  onboardingGuard,
  lockdownGuard,
  getLockdown,
  getAlarm,
  SITES,
  SITE_KEYS,
  listMessages,
  addMessage,
  removeMessage,
  getMessages,
  migrateLegacyAlarm,
  isHR,
  isHRHR,
  isRoot,
  isActive,
  hasStaffDiscordRole,
  canViewStaffLinks,
  canEditTicket,
  isOverdue,
  categories,
  nextActions,
  priorities,
  priorityLabel,
  statusLabel,
  ROLE_LABELS,
  STATUS_LABELS,
  TICKET_STATUS_LABELS,
};
