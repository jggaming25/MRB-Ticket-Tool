'use strict';

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const { db, isRemote, DB_PATH: dbPaths, nextTicketNumber, insertSystemMessage, logAccountAction, logTicketAction, logActionLabel, addAccountNote, getSetting, setSetting } = require('./db');
const discord = require('./discord');
const mailer = require('./mailer');
const config = require('./config');
const push = require('./push');
const backups = require('./backups');
const {
  loadUser,
  requireLogin,
  requireHR,
  requireHRHR,
  requireRoot,
  onboardingGuard,
  lockdownGuard,
  getLockdown,
  getAlarm,
  isHR,
  isHRHR,
  isRoot,
  isActive,
  canEditTicket,
  isOverdue,
  categories,
  nextActions,
  priorities,
  priorityLabel,
  statusLabel,
  ROLE_LABELS,
  STATUS_LABELS,
} = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Deutsche Zeit (Europe/Berlin): Ein <input type="datetime-local"> liefert die
// Uhrzeit des PCs des Planers (deutsche Zeit). Diese wird hier unabhängig von
// der Server-Zeitzone (Render = UTC) korrekt in UTC umgerechnet – inkl. Sommer-
// und Winterzeit.
// ---------------------------------------------------------------------------
function berlinOffsetMs(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  if (map.hour === '24') map.hour = '0';
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - date.getTime();
}

function parseGermanLocal(raw) {
  // raw: "YYYY-MM-DDTHH:MM" (Wanduhrzeit des Planers in Deutschland)
  const date1 = new Date(raw);
  if (Number.isNaN(date1.getTime())) return null;
  const serverOffsetMs = -date1.getTimezoneOffset() * 60000;
  const berlinOffset = berlinOffsetMs(date1);
  return new Date(date1.getTime() + serverOffsetMs - berlinOffset);
}

// Aktuelle Zeit als ISO (UTC) – im Scheduler gegen die DB-Werte zu vergleichen.
function nowUtcIso() {
  return new Date().toISOString();
}

// Render läuft hinter einem Reverse-Proxy. Ohne "trust proxy" würde Express
// die Proxy-IP statt der echten Client-IP sehen – der Rate-Limiter wäre nutzlos.
app.set('trust proxy', 1);

// Cache-Busting: Versionsnummer anhand der letzten Änderung der CSS-Datei.
// Dadurch wird ein veraltetes Browser-Cache der style.css vermieden.
let assetVersion = 1;
try {
  assetVersion = fs.statSync(path.join(__dirname, 'public', 'css', 'style.css')).mtimeMs;
} catch { /* Datei existiert nicht -> Version bleibt 1 */ }

// ---------------------------------------------------------------------------
// Globale Einstellungen
// ---------------------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Carousel-Helfer (inline) + eigene JS
      styleSrc: ["'self'", "'unsafe-inline'"],  // Inline-styles in EJS-Templates
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginEmbedderPolicy: false,
}));

// Strikte Begrenzung der Request-Groessen, damit grosse Payloads weder
// Speicher noch Datenbank belasten. (Multipart-Uploads laufen ueber multer.)
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));

// Globaler Rate-Limiter: schuetzt die gesamte Website (und damit auch den
// Datenbank-Datastore) vor Anfrage-Fluten / einfachen DDoS-Angriffen.
// Statische Dateien (CSS/JS/Bilder) und der Health-Check werden ausgenommen.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 Minute
  max: 300,                     // max. 300 Requests pro Minute und IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/static/') || req.path === '/healthz',
  message: { error: 'Zu viele Anfragen. Bitte warte einen Moment und versuche es erneut.' },
});
app.use(globalLimiter);

const sessionStore = new session.MemoryStore();

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || BASE_URL.startsWith('https://'),
    maxAge: 14 * 24 * 60 * 60 * 1000, // 14 Tage (Discord-Session)
  },
}));

app.use(loadUser);
app.use(onboardingGuard);
app.use(lockdownGuard);

// Flash-Nachrichten
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  next();
});

// Globale Template-Variablen
app.use((req, res, next) => {
  res.locals.baseUrl = BASE_URL;
  res.locals.assetVersion = assetVersion;
  res.locals.currentPath = req.path;
  res.locals.priorityLabel = priorityLabel;
  res.locals.statusLabel = statusLabel;
  res.locals.categories = categories();
  res.locals.priorities = priorities();
  res.locals.nextActions = nextActions();
  res.locals.roleLabels = ROLE_LABELS;
  res.locals.brand = config.brand;
  res.locals.logo = config.logo;
  res.locals.config = config;
  res.locals.pushEnabled = push.isConfigured();
  res.locals.pushPublicKey = push.vapidPublicKey;
  res.locals.isRoot = (u) => isRoot(u);
  res.locals.isOverdue = isOverdue;
  res.locals.accountStatusLabel = (s) => STATUS_LABELS[s] || s;
  res.locals.logActionLabel = logActionLabel;
  res.locals.lockdown = getLockdown();
  res.locals.itAlarm = getAlarm();
  res.locals.fmtDate = (iso) => {
    if (!iso) return '–';
    const d = new Date(iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' });
  };
  res.locals.toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  };
  next();
});

app.use('/static', express.static(path.join(__dirname, 'public')));

// Service Worker im Root ausliefern, damit sein Scope "/" gilt
// (notwendig für zuverlässige Push-Benachrichtigungen).
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------
// Anhaenge werden direkt als Blob in der Datenbank gespeichert (nicht im
// Dateisystem). Grund: Auf Render ist das Dateisystem fluechtig – Datenbank
// (lokal oder Turso) bleibt dagegen erhalten.
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/markdown',
  'application/json', 'application/zip',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Dateityp nicht erlaubt (PNG/JPG/GIF/WebP/PDF/TXT/MD/JSON/ZIP).'));
  },
});

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------
function renderError(res, code, title, message) {
  return res.status(code).render('error', { title, message, code });
}

function flash(req, type, text) {
  req.session.flash = { type, text };
}

// Verifizierung per E-Mail-Code wurde entfernt: Die E-Mail wird direkt aus dem
// Discord-Konto uebernommen und ist nicht aenderbar. Einmalpasswörter (OTP),
// Einladungen und Passwort-Login gibt es nicht mehr – die Anmeldung läuft
// ausschliesslich über Discord.

// ---------------------------------------------------------------------------
// Kunden-/Mail-Helfer
// ---------------------------------------------------------------------------

// Kunde bekommt nur dann E-Mails, wenn in seinem Discord-Konto eine
// (verifizierte) E-Mail-Adresse hinterlegt ist.
function customerEmailOf(ticket) {
  if (!ticket || !ticket.user_id) return null;
  const u = db.prepare('SELECT email FROM users WHERE id = ?').get(ticket.user_id);
  return u && u.email ? u.email : null;
}

// E-Mail an den Kunden (fire-and-forget: Der SMTP-Versand darf den Request
// nicht blockieren, sonst dauert z. B. das Schließen eines Tickets u. U. 45s).
function notifyCustomer(ticket, subject, summary) {
  const to = customerEmailOf(ticket);
  if (!to) return;
  mailer.sendTicketActivity(to, ticket.number, ticket.subject, summary)
    .catch((err) => console.error('Kundenmail fehlgeschlagen:', err.message));
}

// Web-Push an den Ticket-Besitzer (funktioniert auch, wenn die Website
// geschlossen ist, solange der Browser läuft). Nur wenn dieser die
// Benachrichtigungen in den Kontoeinstellungen aktiviert hat. Wird nur bei
// neuen Einträgen, Übernahmen und Freigaben aufgerufen.
function notifyOwnerPush(ticket, title, body) {
  if (!ticket || !ticket.user_id) return;
  const owner = db.prepare('SELECT notify_changes FROM users WHERE id = ?').get(ticket.user_id);
  if (owner && owner.notify_changes === 1) {
    push.sendToUser(ticket.user_id, {
      title: `Ticket #${String(ticket.number).padStart(4, '0')}: ${title}`,
      body,
      url: `${BASE_URL}/tickets/${ticket.id}`,
    });
  }
}

// Web-Push an alle HR/HR-HR (Team + Inhaber), die Benachrichtigungen
// aktiviert haben. excludeUserId: der Absender benachrichtigt sich nicht selbst.
function notifyAllStaffPush(title, body, url, excludeUserId) {
  const staff = db.prepare(`
    SELECT id FROM users
    WHERE role IN ('hr','hrhr') AND status = 'active' AND notify_changes = 1
  `).all();
  for (const s of staff) {
    if (excludeUserId && s.id === excludeUserId) continue;
    push.sendToUser(s.id, { title, body, url });
  }
}

function markOverdue(ticket) {
  if (isOverdue(ticket) && ticket.status !== 'overdue') {
    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run('overdue', ticket.id);
    ticket.status = 'overdue';
  }
}

// Fälligkeit: Heute + konfiguriertes Intervall (Stunden).
function freshDueDate() {
  return new Date(Date.now() + config.due.defaultHours * 60 * 60 * 1000).toISOString();
}

// ---- Bearbeitungs-Sperre (Write-Lock) --------------------------------------
// Nur ein Bearbeiter darf gleichzeitig in einem Ticket eintragen. Solange eine
// frische Sperre (Heartbeat) eines anderen Bearbeiters besteht, ist die Eingabe
// gesperrt. Der Inhaber (HR-HR) ist immer ausgenommen.
const LOCK_TTL_MS = 90 * 1000;

function lockIsFresh(lockedAt) {
  if (!lockedAt) return false;
  return Date.now() - new Date(lockedAt).getTime() < LOCK_TTL_MS;
}

function lockOwner(ticket) {
  if (!ticket || !ticket.locked_by || !lockIsFresh(ticket.locked_at)) return null;
  return db.prepare('SELECT id, username, global_name FROM users WHERE id = ?').get(ticket.locked_by) || null;
}

function lockBlocks(ticket, user) {
  if (isHRHR(user)) return false;
  const owner = lockOwner(ticket);
  return !!(owner && owner.id !== user.id);
}

function lockErrorMessage(ticket) {
  const owner = lockOwner(ticket);
  const name = owner ? (owner.global_name || owner.username) : 'ein anderer Bearbeiter';
  return `Das Ticket wird gerade von ${name} bearbeitet. Die Eingabe ist gesperrt – versuche es später erneut.`;
}

// Ticket-URL inkl. Admin-Kontext (?ctx=admin), damit die Verwaltungs-Buttons
// nach einer Aktion sichtbar bleiben.
function ticketViewUrl(ticket, adminCtx) {
  return `/tickets/${ticket.id}` + (adminCtx ? '?ctx=admin' : '');
}

// Turso liefert die Action-Spalte der Log-Tabellen historisch als "ACTION"
// (grossgeschrieben, stammt aus einem alten Schema). SQL ist case-insensitiv,
// aber JS-Zugriffe auf l.action würden sonst undefined liefern. Die Zeilen
// werden normalisiert, damit überall l.action verfügbar ist.
function normalizeLogRows(rows) {
  return (rows || []).map((r) => {
    if (r && r.ACTION !== undefined && r.action === undefined) r.action = r.ACTION;
    return r;
  });
}

// ---- Homepage-Bilder -------------------------------------------------------
function getHomeImages() {
  const dir = config.home.imageDir;
  const exts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => exts.has(path.extname(f).toLowerCase()));
  } catch {
    // Ordner existiert (noch) nicht -> leere Liste
  }
  return files.map((f) => config.home.imageUrlPrefix + encodeURIComponent(f));
}

// ---- CSV-Export ------------------------------------------------------------
function ticketsToCsv(tickets) {
  const cols = ['Nr.', 'Status', 'Kategorie', 'Priorität', 'Betreff', 'Erstellt', 'Aktualisiert', 'Fällig', 'Überfällig', 'Bearbeiter', 'Ersteller'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = tickets.map((t) => {
    const owner = t.owner_username || '';
    const claimer = t.claimed_username || t.assigned_username || '';
    return [t.number, statusLabel(t.status), t.category, priorityLabel(t.priority), t.subject,
      t.created_at, t.updated_at, t.due_at || '', isOverdue(t) ? 'ja' : 'nein', claimer, owner]
      .map(esc).join(';');
  });
  return `\uFEFF${cols.map(esc).join(';')}\n${rows.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Auth-Routen
// ---------------------------------------------------------------------------
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte warte einen Moment.' },
});

// Schuetzt den Datei-Download vor Massenabruf (Blob-Attacken auf die Datenbank).
const fileDownloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.user,
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const lock = getLockdown();
  const lockedMsg = req.query.locked ? (lock ? lock.message : null) || config.lockdownMessage : null;
  res.render('login', { title: 'Login', lockedMsg });
});

app.get('/auth/discord', authLimiter, (req, res) => {
  const { url } = discord.getAuthUrl();
  res.redirect(url);
});

app.get('/auth/callback', authLimiter, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return renderError(res, 400, 'Login abgebrochen', 'Du hast den Login abgebrochen. Versuche es erneut.');
  }
  if (!code || !discord.verifyState(state)) {
    return renderError(res, 400, 'Ungueltige Anfrage', 'Die Login-Anfrage ist ungueltig oder abgelaufen. Bitte erneut versuchen.');
  }

  try {
    const token = await discord.exchangeCode(code);
    const dUser = await discord.fetchDiscordUser(token.access_token);

    // Zugriff gesperrt (Lockdown / IT-Alarm): Nur der festgelegte Inhaber kann
    // sich einloggen, alle anderen werden mit der Meldung abgewiesen.
    const lock = getLockdown();
    const isOwner = discord.isAuthorizedDiscord(dUser);
    if (lock && !isOwner) {
      return res.status(403).render('error', {
        title: 'Zugriff gesperrt',
        message: lock.message || config.lockdownMessage,
        code: 403,
      });
    }

    // Server-Prüfung: Der Nutzer muss Mitglied des Discord-Servers sein.
    // (DISCORD_GUILD_ID muss in .env gesetzt sein; sonst wird übersprungen.)
    if (discord.isGuildCheckEnabled()) {
      const isMember = await discord.isInGuild(token.access_token);
      if (!isMember) {
        const joinUrl = process.env.DISCORD_INVITE_URL || null;
        return res.status(403).render('error', {
          title: 'Nicht auf dem Discord-Server',
          message: 'Du bist kein Mitglied unseres Discord-Servers. Trete dem Server zuerst bei – erst danach kannst du dich anmelden.',
          code: 403,
          joinUrl,
        });
      }
    }

    // E-Mail aus dem Discord-Konto uebernehmen (Scope "identify email").
    // Nur verifizierte E-Mails sind relevant; die Pruefung passiert in discord.js.
    const discordEmail = dUser.email && discord.isEmailVerified(dUser)
      ? dUser.email.trim().toLowerCase()
      : null;

    // Discord-Rollen des Nutzers auf dem Server abrufen (bestimmt den Zugriff
    // auf "Interne Links"). Ohne konfigurierte Guild-ID bleibt die Liste leer.
    const guildRoles = await discord.fetchGuildRoles(token.access_token);
    const guildRolesStr = guildRoles.length ? guildRoles.join(',') : null;

    // Der Inhaber (aus AUTHORIZED_DISCORD_USERNAMES) braucht zwingend eine
    // verifizierte E-Mail, sonst wird der Login blockiert (Anweisung:
    // hinterlege in Discord eine E-Mail-Adresse). Normale Nutzer duerfen
    // ohne E-Mail weiter.
    if (discord.isAuthorizedDiscord(dUser) && !discordEmail) {
      return renderError(res, 403, 'E-Mail-Adresse fehlt',
        'Dein Discord-Konto hat keine verifizierte E-Mail-Adresse. Hinterlege und bestaetige '
        + 'in Discord eine E-Mail-Adresse (Discord > Einstellungen > Mein Konto). Danach kannst '
        + 'du dich hier anmelden.');
    }

    let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(dUser.id);

    if (!user) {
      // Neues Konto: Inhaber (aus der Konfiguration) bzw. normaler Nutzer.
      // Beide sind sofort aktiv – es gibt kein Setup und kein Passwort mehr.
      const isOwner = discord.isAuthorizedDiscord(dUser);
      const info = db.prepare(`
        INSERT INTO users (discord_id, discord_username, username, global_name, avatar, email, role, status, is_root, discord_roles, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, datetime('now'), datetime('now'))
      `).run(dUser.id, dUser.username, dUser.global_name || dUser.username, dUser.global_name || null,
        dUser.avatar || null, discordEmail, isOwner ? 'hrhr' : 'user', isOwner ? 1 : 0, guildRolesStr);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      if (isOwner) {
        logAccountAction(user.id, user.id, 'hrhr_created', 'Inhaber-Account per Discord-Registrierung angelegt');
      }
    } else {
      // Bestehendes Konto: Status pruefen
      if (user.status === 'disabled' || user.status === 'deleted') {
        const statusText = user.status === 'deleted' ? 'Dein Konto wurde gelöscht.' : 'Dein Konto ist deaktiviert.';
        return renderError(res, 403, 'Konto gesperrt',
          `${statusText}${user.disabled_reason ? ` Grund: ${user.disabled_reason}` : ''}`);
      }
      // Altbestand migrieren: Konten aus der alten E-Mail-Verifizierung
      // (pending_email) und alte Einladungs-/Setup-Konten (invited,
      // pending_password, pending_setup) werden direkt aktiviert.
      if (user.status !== 'active') {
        db.prepare(`
          UPDATE users
          SET email = CASE WHEN ? IS NOT NULL THEN ? ELSE COALESCE(email, pending_email) END,
              pending_email = NULL, verify_token = NULL, invite_token = NULL,
              otp_hash = NULL, otp_expires = NULL, status = 'active',
              updated_at = datetime('now')
          WHERE id = ?
        `).run(discordEmail, discordEmail, user.id);
      }
      // Der in der Konfiguration festgelegte Inhaber erhaelt seine Rolle
      // automatisch – auch wenn sie zwischenzeitlich geaendert wurde.
      if (discord.isAuthorizedDiscord(dUser) && (user.role !== 'hrhr' || user.is_root !== 1)) {
        db.prepare(`
          UPDATE users SET role = 'hrhr', is_root = 1, updated_at = datetime('now') WHERE id = ?
        `).run(user.id);
      }
      db.prepare(`
        UPDATE users
        SET username = ?, global_name = ?, avatar = ?, discord_username = ?,
            email = CASE WHEN ? IS NOT NULL AND (email IS NULL OR email = '') THEN ? ELSE email END,
            discord_roles = ?, last_login = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(dUser.global_name || dUser.username, dUser.global_name || null, dUser.avatar || null,
        dUser.username, discordEmail, discordEmail, guildRolesStr, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = user.id;
      res.redirect('/dashboard');
    });
  } catch (err) {
    console.error('OAuth-Fehler:', err.message);
    renderError(res, 500, 'Login fehlgeschlagen', 'Die Discord-Anmeldung ist fehlgeschlagen. Bitte pruefe die Konfiguration.');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------------------------------------------------------------------------
// Kontoeinstellungen
// ---------------------------------------------------------------------------
app.get('/account/settings', requireLogin, (req, res) => {
  res.render('account-settings', {
    title: 'Kontoeinstellungen',
    user: req.user,
    adminData: isRoot(req.user) ? {
      lockdown: getLockdown(),
      lockdownDefaultMsg: config.lockdownMessage,
      alarm: getAlarm(),
      backups: backups.listBackups(),
      backupSlotsFree: backups.slotsFree(),
      backupMax: backups.maxSlots(),
    } : null,
  });
});

app.post('/account/settings', requireLogin, (req, res) => {
  const notify = req.body.notify_changes === '1' ? 1 : 0;
  db.prepare('UPDATE users SET notify_changes = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(notify, req.user.id);
  req.user.notify_changes = notify;
  flash(req, 'success', 'Einstellungen gespeichert.');
  res.redirect('/account/settings');
});

// ---------------------------------------------------------------------------
// Admin-Optionen (nur festgelegte Inhaber) unter "Einstellungen"
// ---------------------------------------------------------------------------

// IT-Alarm: Zugriff für alle sperren / freigeben (ausgenommen der eigene
// Account). Alle eingeloggten Bearbeiter sehen sofort eine rote Vollbild-
// Meldung mit Alarmton ("IT-Alarm: <Text>") und werden abgemeldet.
app.post('/account/settings/admin/lockdown', requireRoot, (req, res) => {
  const enable = req.body.action === 'enable';
  if (enable) {
    const message = String(req.body.message || '').trim() || config.lockdownMessage;
    setSetting('system_lockdown', JSON.stringify({
      enabled: true,
      message,
      set_by: req.user.id,
      set_at: new Date().toISOString(),
    }));
    logAccountAction(req.user.id, req.user.id, 'lockdown_enabled', 'IT-Alarm ausgelöst (Zugriff für alle Bearbeiter gesperrt, nur Inhaber darf einloggen).');
    flash(req, 'success', 'IT-Alarm ausgelöst. Alle eingeloggten Bearbeiter sehen die rote Meldung und werden abgemeldet.');
  } else {
    setSetting('system_lockdown', '');
    logAccountAction(req.user.id, req.user.id, 'lockdown_disabled', 'IT-Alarm beendet, Zugriff für Bearbeiter wieder freigegeben.');
    flash(req, 'success', 'IT-Alarm beendet. Der Zugriff ist wieder für alle möglich.');
  }
  res.redirect('/account/settings');
});

// Meldungen: einfacher Hinweis-Banner (gelb) oben auf allen Seiten – ohne Ton,
// ohne Sperre. Nur Text für alle eingeloggten Nutzer.
app.post('/account/settings/admin/alarm', requireRoot, (req, res) => {
  if (req.body.action === 'set') {
    const text = String(req.body.text || '').trim();
    if (!text) {
      flash(req, 'error', 'Bitte gib einen Meldungstext ein.');
      return res.redirect('/account/settings');
    }
    setSetting('it_alarm', JSON.stringify({
      active: true,
      text,
      set_by: req.user.id,
      set_at: new Date().toISOString(),
    }));
    logAccountAction(req.user.id, req.user.id, 'alarm_set', 'Meldung angezeigt.');
    flash(req, 'success', 'Meldung wird oben auf allen Seiten angezeigt.');
  } else {
    setSetting('it_alarm', '');
    logAccountAction(req.user.id, req.user.id, 'alarm_cleared', 'Meldung entfernt.');
    flash(req, 'success', 'Meldung entfernt.');
  }
  res.redirect('/account/settings');
});

// Systemneustart: Prozess wird beendet (Render startet ihn neu)
app.post('/account/settings/admin/restart', requireRoot, (req, res) => {
  logAccountAction(req.user.id, req.user.id, 'system_restart', 'Systemneustart angefordert.');
  flash(req, 'success', 'System wird neu gestartet …');
  res.redirect('/account/settings');
  setTimeout(() => {
    console.log('Systemneustart durch Inhaber angefordert.');
    process.exit(0);
  }, 1500);
});

// Manuelles Backup erstellen (nur wenn Slots frei sind)
app.post('/account/settings/admin/backups/create', requireRoot, (req, res) => {
  const result = backups.createBackup('manual', req.user.id);
  if (!result.ok) {
    flash(req, 'error', `Backup nicht möglich: 0 / ${backups.maxSlots()} Slots frei. Erst aufräumen (jlg09) oder alte Backups löschen.`);
  } else {
    flash(req, 'success', `Backup erstellt (${backups.slotsFree()} / ${backups.maxSlots()} Slots frei).`);
  }
  res.redirect('/account/settings');
});

// Einzelnes Backup löschen
app.post('/account/settings/admin/backups/:id/delete', requireRoot, (req, res) => {
  backups.deleteBackup(req.params.id);
  flash(req, 'success', 'Backup gelöscht.');
  res.redirect('/account/settings');
});

// Alle Backups löschen (jlg09 kann jederzeit aufräumen)
app.post('/account/settings/admin/backups/clear', requireRoot, (req, res) => {
  backups.clearAllBackups();
  logAccountAction(req.user.id, req.user.id, 'backups_cleared', 'Alle Backups manuell gelöscht.');
  flash(req, 'success', `Alle Backups gelöscht. ${backups.maxSlots()} / ${backups.maxSlots()} Slots wieder frei.`);
  res.redirect('/account/settings');
});

// Backup herunterladen
app.get('/account/settings/admin/backups/:id/download', requireRoot, (req, res) => {
  const b = backups.getBackup(req.params.id);
  if (!b) return renderError(res, 404, 'Nicht gefunden', 'Dieses Backup existiert nicht.');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="mrb-backup-${b.created_at.replace(/[^0-9T:]/g, '-')}.json"`);
  res.send(b.data);
});

// ---- Benachrichtigungen: Änderungen an sichtbaren Tickets seit Zeitpunkt ----
// Liefert Ticket-Änderungen, die der eingeloggte Nutzer sehen darf (Nutzer:
// eigene Tickets; Team/Inhaber: alle Tickets). Der Client pollt diesen
// Endpoint und zeigt Browser-Benachrichtigungen an.
app.get('/api/tickets/updates', requireLogin, (req, res) => {
  const since = String(req.query.since || '');
  if (!since || Number.isNaN(Date.parse(since))) {
    return res.status(400).json({ error: 'since (ISO-Datumsangabe) fehlt' });
  }
  const rows = db.prepare(`
    SELECT t.id, t.number, t.subject, t.status, t.updated_at
    FROM tickets t
    WHERE t.updated_at > ?
      AND (t.user_id = ? OR (t.claimed_by = ? OR ? = 1))
    ORDER BY t.updated_at DESC
    LIMIT 20
  `).all(since, req.user.id, req.user.id, isHR(req.user) ? 1 : 0);
  res.json({ tickets: rows });
});

// ---------------------------------------------------------------------------
// Web-Push: Subscription verwalten
// ---------------------------------------------------------------------------
app.post('/api/push/subscribe', requireLogin, (req, res) => {
  const { subscription } = req.body || {};
  if (!push.isConfigured()) {
    return res.status(503).json({ error: 'Push-Benachrichtigungen sind nicht konfiguriert.' });
  }
  if (!push.saveSubscription(req.user.id, subscription)) {
    return res.status(400).json({ error: 'Ungültige Push-Subscription.' });
  }
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireLogin, (req, res) => {
  const { endpoint } = req.body || {};
  push.removeSubscription(endpoint);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Onboarding wurde entfernt: Es gibt keine Einladungen, keine Passwort-Setups
// und kein Passwort-Login mehr. Die Anmeldung laeuft ausschliesslich ueber
// Discord, und jeder Account ist direkt nach dem Login aktiv.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ticket-Routen
// ---------------------------------------------------------------------------
const ticketCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

function loadTicketFor(req, res, next) {
  const id = Number(req.params.id);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  if (!ticket) {
    return renderError(res, 404, 'Nicht gefunden', 'Dieses Ticket existiert nicht.');
  }
  const allowed = isHR(req.user) || ticket.user_id === req.user.id;
  if (!allowed) {
    return renderError(res, 403, 'Kein Zugriff', 'Du hast keinen Zugriff auf dieses Ticket.');
  }
  req.ticket = ticket;
  next();
}

app.get('/', (req, res) => {
  res.render('home', {
    title: config.brand,
    images: getHomeImages(),
    slideSeconds: config.home.slideSeconds,
  });
});

// Öffentlicher Status-Endpoint für die anderen Apps (Anwesenheits-Tool,
// MRB-OnlineBefehl): Sie prüfen hier, ob der Inhaber die Zugriffssperre
// (Lockdown / IT-Alarm) ausgelöst hat und sperren sich dann selbst.
app.get('/api/status', (req, res) => {
  const lock = getLockdown();
  const alarm = getAlarm();
  const alarmActive = alarm && alarm.text ? alarm : null;
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');
  res.json({
    app: 'mrb-tickets',
    // IT-Alarm (früher "Zugriff sperren"): sperrt den Zugriff für alle außer
    // dem Inhaber; eingeloggte Bearbeiter sehen eine rote Vollbild-Meldung.
    lockdown: {
      enabled: !!(lock && lock.enabled),
      message: (lock && lock.message) || '',
      set_by: (lock && lock.set_by) || null,
      set_at: (lock && lock.set_at) || null,
    },
    // Meldungen (früher "IT-Alarm"): nur Hinweis-Banner (gelb), ohne Sperre.
    meldung: {
      active: !!alarmActive,
      text: (alarmActive && alarmActive.text) || '',
    },
    itAlarm: {
      active: !!alarmActive,
      text: (alarmActive && alarmActive.text) || '',
    },
    ts: new Date().toISOString(),
  });
});

app.get('/impressum', (req, res) => {
  res.render('impressum', { title: 'Impressum' });
});

app.get('/datenschutz', (req, res) => {
  res.render('datenschutz', { title: 'Datenschutzerklärung' });
});

app.get('/dashboard', requireLogin, (req, res) => {
  const quickNumber = String(req.query.number || '').trim();
  const status = req.query.status || 'all';
  const sort = req.query.sort || 'updated';
  const search = String(req.query.search || '').trim();

  const where = ['t.user_id = ?'];
  const params = [req.user.id];
  if (status !== 'all') { where.push('t.status = ?'); params.push(status); }
  if (search) {
    const numSearch = /^\d+$/.test(search) ? String(Number(search)) : null;
    const like = `%${search}%`;
    where.push('(CAST(t.number AS TEXT) = ? OR printf(\'%04d\', t.number) = ? OR t.subject LIKE ?)');
    params.push(numSearch, search, like);
  }
  let orderBy = 't.updated_at DESC';
  if (sort === 'created') orderBy = 't.created_at DESC';
  else if (sort === 'status') {
    orderBy = 'CASE t.status WHEN \'open\' THEN 0 WHEN \'pending\' THEN 1 WHEN \'release\' THEN 2 ELSE 3 END, t.updated_at DESC';
  }

  const myTickets = db.prepare(`
    SELECT t.*, u.username, u.global_name, u.avatar
    FROM tickets t JOIN users u ON u.id = t.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
  `).all(...params);

  for (const t of myTickets) markOverdue(t);

  const openCount = myTickets.filter((t) => t.status !== 'closed').length;

  res.render('dashboard', {
    title: 'Meine Tickets',
    myTickets,
    openCount,
    quickNumber,
    quickError: null,
    status,
    sort,
    search,
  });
});

// Schnellsprung: Ticketnummer im Dashboard-Eingabefeld -> direkt zum Ticket
app.post('/dashboard/jump', requireLogin, (req, res) => {
  const input = String(req.body.number || '').trim().replace(/^#/, '');
  const renderBase = (quickNumber, quickError) => res.render('dashboard', {
    title: 'Meine Tickets',
    myTickets: db.prepare(`
      SELECT t.*, u.username, u.global_name, u.avatar
      FROM tickets t JOIN users u ON u.id = t.user_id
      WHERE t.user_id = ? ORDER BY t.updated_at DESC
    `).all(req.user.id),
    openCount: db.prepare(`
      SELECT COUNT(*) AS c FROM tickets WHERE user_id = ? AND status != 'closed'
    `).get(req.user.id).c,
    status: 'all',
    sort: 'updated',
    search: '',
    quickNumber,
    quickError,
  });

  if (!/^\d+$/.test(input)) {
    return renderBase(input, 'Bitte eine gültige Ticketnummer eingeben (z. B. 0042).');
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE number = ?').get(Number(input));
  if (!ticket) {
    return renderBase(input, `Es wurde kein Ticket mit der Nummer #${input} gefunden.`);
  }

  const allowed = isHR(req.user) || ticket.user_id === req.user.id;
  if (!allowed) {
    flash(req, 'error', 'Du hast keinen Zugriff auf dieses Ticket.');
    return res.redirect('/dashboard');
  }
  res.redirect(`/tickets/${ticket.id}`);
});

// ---------------------------------------------------------------------------
// CSV-Export (HR/HR-HR)
// ---------------------------------------------------------------------------
app.get('/admin/export.csv', requireHR, (req, res) => {
  const status = req.query.status || 'all';
  const category = req.query.category || 'all';
  const search = String(req.query.search || '').trim();

  const where = [];
  const params = [];
  if (status !== 'all') { where.push('t.status = ?'); params.push(status); }
  if (category !== 'all') { where.push('t.category = ?'); params.push(category); }
  if (search) {
    const like = `%${search}%`;
    where.push(`(CAST(t.number AS TEXT) = ? OR printf('%04d', t.number) = ? OR t.subject LIKE ? OR t.body LIKE ?)`);
    params.push(String(Number(search)), search, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const tickets = db.prepare(`
    SELECT t.*, u.username AS owner_username,
           c.username AS claimed_username, c.username AS assigned_username
    FROM tickets t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN users c ON c.id = t.claimed_by
    ${whereSql}
    ORDER BY t.number ASC
  `).all(...params);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tickets-${Date.now()}.csv"`);
  res.send(ticketsToCsv(tickets));
});

app.get('/tickets/new', requireLogin, (req, res) => {
  res.render('ticket-new', { title: 'Neues Ticket', values: null, errors: null });
});

app.post('/tickets', requireLogin, ticketCreateLimiter, upload.single('attachment'), async (req, res) => {
  const { subject, category, body } = req.body;
  const subjectTrim = String(subject || '').trim();
  const bodyTrim = String(body || '').trim();

  const errors = [];
  if (subjectTrim.length < 3) errors.push('Bitte gib einen Betreff mit mindestens 3 Zeichen an.');
  if (subjectTrim.length > 120) errors.push('Der Betreff darf maximal 120 Zeichen lang sein.');
  if (!categories().includes(category)) errors.push('Ungueltige Kategorie.');
  if (bodyTrim.length < 5) errors.push('Bitte beschreibe dein Anliegen (mindestens 5 Zeichen).');

  if (errors.length) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).render('ticket-new', {
      title: 'Neues Ticket',
      errors,
      values: { subject: subjectTrim, category, body: bodyTrim },
    });
  }

  const number = nextTicketNumber();
  const now = new Date().toISOString();
  const due = freshDueDate();

  const result = db.prepare(`
    INSERT INTO tickets (number, user_id, subject, category, priority, status, due_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'medium', 'open', ?, ?, ?)
  `).run(number, req.user.id, subjectTrim, category, due, now, now);

  const ticketId = result.lastInsertRowid;
  const f = req.file;
  db.prepare(`
    INSERT INTO messages (ticket_id, user_id, body, author_role, attachment, attachment_name, attachment_mime, attachment_data, created_at)
    VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)
  `).run(ticketId, req.user.id, bodyTrim,
    f ? f.originalname : null, f ? f.originalname : null, f ? f.mimetype : null, f ? f.buffer : null, now);

  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, ticketId);
  logTicketAction(ticketId, req.user.id, 'created', `Ticket erstellt (Kategorie: ${category})`);

  // Kunde per E-Mail benachrichtigen (sofern im Discord-Konto E-Mail hinterlegt)
  const customerEmail = customerEmailOf({ user_id: req.user.id });
  if (customerEmail) {
    mailer.sendTicketCreated(customerEmail, number, subjectTrim)
      .catch((err) => console.error('Bestätigungsmail fehlgeschlagen:', err.message));
  }

  // Push-Benachrichtigung an alle HR/HR-HR (ohne den Ersteller), damit neue
  // Tickets sofort sichtbar sind.
  notifyAllStaffPush(`Neues Ticket #${String(number).padStart(4, '0')}`,
    `Von ${req.user.global_name || req.user.username}: ${subjectTrim.slice(0, 100)}`,
    `${BASE_URL}/tickets/${ticketId}`, req.user.id);

  res.redirect(`/tickets/${ticketId}`);
});

app.get('/tickets/:id', requireLogin, loadTicketFor, (req, res) => {
  const { ticket } = req;
  const messages = db.prepare(`
    SELECT m.id, m.ticket_id, m.user_id, m.body, m.author_role, m.is_system,
           m.attachment, m.attachment_name, m.attachment_mime, m.created_at,
           u.username, u.global_name, u.discord_id, u.avatar, u.role
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.ticket_id = ?
    ORDER BY m.created_at ASC, m.id ASC
  `).all(ticket.id);

  const claimedBy = ticket.claimed_by
    ? db.prepare('SELECT id, username, global_name, role FROM users WHERE id = ?').get(ticket.claimed_by)
    : null;

  const canEdit = canEditTicket(req.user, ticket);
  markOverdue(ticket);

  // Vollstaendiges Audit-Log des Tickets
  const logs = normalizeLogRows(db.prepare(`
    SELECT l.*, a.username AS actor_name, a.global_name AS actor_global
    FROM ticket_logs l
    LEFT JOIN users a ON a.id = l.actor_id
    WHERE l.ticket_id = ?
    ORDER BY l.id ASC
  `).all(ticket.id));

  const isClosed = ticket.status === 'closed';

  // Verwaltungs-Aktionen (schließen, freigeben, übernehmen, Fälligkeit …) sind
  // nur sichtbar, wenn das Ticket über die Verwaltung ("Alle Tickets") geöffnet
  // wurde (?ctx=admin). Aus "Meine Tickets" heraus sehen Bearbeiter die
  // Aktions-Buttons bewusst nicht.
  const fromAdmin = req.query.ctx === 'admin';

  // HR/HR-HR-Accounts als Übergabe-Ziele
  const staffUsers = fromAdmin && isHR(req.user)
    ? db.prepare(`
        SELECT id, username, global_name, role FROM users
        WHERE role IN ('hr','hrhr') AND status = 'active' AND id != ?
        ORDER BY username ASC
      `).all(req.user.id)
    : [];

  const lockOwnerInfo = lockOwner(ticket);
  const lockBlocked = isHR(req.user) && !isHRHR(req.user) &&
    !!lockOwnerInfo && lockOwnerInfo.id !== req.user.id;

  res.render('ticket-view', {
    title: `Ticket #${String(ticket.number).padStart(4, '0')}`,
    ticket,
    messages,
    assignee: null,
    staffUsers,
    claimedBy,
    logs,
    canEdit,
    fromAdmin,
    canClaim: fromAdmin && isHR(req.user) && !ticket.claimed_by && !isClosed,
    canUnclaim: fromAdmin && isHR(req.user) && ticket.claimed_by === req.user.id,
    // "Zum Schließen Freigeben": nur wenn das Ticket übernommen wurde. Danach
    // kann nur noch der Inhaber das Ticket schließen.
    canRelease: fromAdmin && isHR(req.user) && !isClosed &&
      !!ticket.claimed_by && ticket.status !== 'release',
    canSetStatus: fromAdmin && isHR(req.user) && !isClosed &&
      ['open', 'pending', 'overdue'].includes(ticket.status),
    canSetDue: fromAdmin && canEdit && !isClosed,
    // Schließen: nur Inhaber (HR-HR) und nur, wenn der Bearbeiter das Ticket
    // zur Freigabe vorgelegt hat (Status "release").
    canClose: fromAdmin && isHRHR(req.user) && !isClosed && ticket.status === 'release',
    canReopen: fromAdmin && isHRHR(req.user) && isClosed,
    lockBlocked,
    lockHolderName: lockOwnerInfo ? (lockOwnerInfo.global_name || lockOwnerInfo.username) : null,
  });
});

app.post('/tickets/:id/message', requireLogin, loadTicketFor, upload.single('attachment'), async (req, res) => {
  const { ticket } = req;
  const body = String(req.body.body || '').trim();
  const adminCtx = req.query.ctx === 'admin';

  if (!canEditTicket(req.user, ticket)) {
    if (req.file) fs.unlinkSync(req.file.path);
    return renderError(res, 403, 'Kein Zugriff',
      ticket.claimed_by ? 'Dieses Ticket ist bereits an einen anderen Mitarbeiter vergeben.' : 'Du darfst dieses Ticket nicht bearbeiten.');
  }

  // Write-Lock: nur ein Bearbeiter darf gleichzeitig eintragen.
  if (isHR(req.user) && lockBlocks(ticket, req.user)) {
    if (req.file) fs.unlinkSync(req.file.path);
    flash(req, 'error', lockErrorMessage(ticket));
    return res.redirect(ticketViewUrl(ticket, adminCtx));
  }

  if (ticket.status === 'closed') {
    if (req.file) fs.unlinkSync(req.file.path);
    return renderError(res, 400, 'Geschlossen', 'Dieses Ticket ist geschlossen. Reoeffne es zuerst, um zu antworten.');
  }

  if (!body && !req.file) {
    return renderError(res, 400, 'Leere Antwort', 'Schreibe eine Nachricht oder haenge eine Datei an.');
  }

  const role = isHR(req.user) ? 'staff' : 'user';
  const now = new Date().toISOString();
  const f = req.file;

  db.prepare(`
    INSERT INTO messages (ticket_id, user_id, body, author_role, attachment, attachment_name, attachment_mime, attachment_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ticket.id, req.user.id, body || '(Anhang)', role,
    f ? f.originalname : null, f ? f.originalname : null, f ? f.mimetype : null, f ? f.buffer : null, now);

  // Jede Bearbeitung durch den Support verlängert die Fälligkeit (Config-Intervall).
  // Außerdem: Fälligkeit wird gesetzt, sobald ein HR sich des Tickets annimmt.
  const isStaff = isHR(req.user);
  db.prepare(`
    UPDATE tickets SET updated_at = ?, status = ?,
        due_at = CASE WHEN ? THEN ? ELSE due_at END
    WHERE id = ?
  `).run(
    now,
    isStaff ? 'pending' : 'open',
    isStaff ? 1 : 0,
    freshDueDate(),
    ticket.id
  );

  logTicketAction(ticket.id, req.user.id, 'reply', `Nachricht von ${isStaff ? 'Support' : 'Kunde'}`);
  await notifyCustomer({ ...ticket, user_id: ticket.user_id }, ticket.subject,
    isStaff ? 'Der Support hat auf dein Ticket geantwortet.' : 'Deine Antwort wurde gespeichert.');

  // Push-Benachrichtigungen bei neuen Einträgen: an den Besitzer (nur wenn der
  // Support schreibt) und an alle HR/HR-HR – jeweils mit kurzem Textausschnitt.
  const snippet = (body ? body.slice(0, 100) : '(Anhang)') + (body && body.length > 100 ? '…' : '');
  const who = req.user.global_name || req.user.username;
  if (isStaff) {
    notifyOwnerPush(ticket, 'Neue Nachricht', snippet);
    notifyAllStaffPush(`Ticket #${String(ticket.number).padStart(4, '0')}`,
      `Antwort von ${who}: ${snippet}`,
      `${BASE_URL}/tickets/${ticket.id}`, req.user.id);
  } else {
    notifyAllStaffPush(`Ticket #${String(ticket.number).padStart(4, '0')}`,
      `Neue Nachricht vom Kunden (${who}): ${snippet}`,
      `${BASE_URL}/tickets/${ticket.id}`);
  }

  res.redirect(ticketViewUrl(ticket, adminCtx) + '#last');
});

// Schließen: ausschliesslich HR-HR und nur, wenn der Bearbeiter das Ticket
// zur Freigabe vorgelegt hat (Status "release").
app.post('/tickets/:id/close', requireHRHR, loadTicketFor, async (req, res) => {
  const { ticket } = req;
  const adminCtx = req.query.ctx === 'admin';
  if (ticket.status === 'closed') {
    flash(req, 'error', 'Das Ticket ist bereits geschlossen.');
    return res.redirect(ticketViewUrl(ticket, adminCtx));
  }
  if (ticket.status !== 'release') {
    flash(req, 'error',
      'Das Ticket wurde nicht vom Bearbeiter zur Freigabe vorgelegt. Nur Tickets mit Freigabe-Status können geschlossen werden.');
    return res.redirect(ticketViewUrl(ticket, adminCtx));
  }
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ?, due_at = NULL, updated_at = ? WHERE id = ?
  `).run(now, req.user.id, now, ticket.id);

  logTicketAction(ticket.id, req.user.id, 'closed', 'Ticket vom Inhaber geschlossen');
  insertSystemMessage(ticket.id, 'Das Ticket wurde geschlossen.');
  await notifyCustomer(ticket, ticket.subject, 'Dein Ticket wurde erfolgreich abgeschlossen.');
  flash(req, 'success', 'Ticket geschlossen.');
  res.redirect(ticketViewUrl(ticket, adminCtx));
});

// Wieder öffnen: nur HR-HR
app.post('/tickets/:id/reopen', requireHRHR, loadTicketFor, async (req, res) => {
  const adminCtx = req.query.ctx === 'admin';
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL, due_at = ?, updated_at = ? WHERE id = ?
  `).run(freshDueDate(), now, req.ticket.id);

  logTicketAction(req.ticket.id, req.user.id, 'reopened', 'Ticket wieder geöffnet');
  insertSystemMessage(req.ticket.id, 'Das Ticket wurde wieder geoeffnet.');
  await notifyCustomer(req.ticket, req.ticket.subject, 'Dein Ticket wurde wieder geöffnet.');
  flash(req, 'success', 'Ticket wieder geöffnet.');
  res.redirect(ticketViewUrl(req.ticket, adminCtx));
});

// Geschuetzter Datei-Download
app.get('/file/:ticketId/:messageId/:filename', requireLogin, fileDownloadLimiter, (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.ticketId);
  if (!ticket) return res.status(404).end();
  const allowed = isHR(req.user) || ticket.user_id === req.user.id;
  if (!allowed) return res.status(403).end();

  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND ticket_id = ?').get(
    req.params.messageId, req.params.ticketId
  );
  if (!msg || !msg.attachment) return res.status(404).end();

  const name = (msg.attachment_name || msg.attachment.split('_').slice(1).join('_') || 'anhang')
    .replace(/["\r\n]/g, '');

  // Anhang liegt als Blob in der Datenbank vor (aktueller Speicherweg)
  if (msg.attachment_data && msg.attachment_data.length) {
    const buffer = Buffer.isBuffer(msg.attachment_data)
      ? msg.attachment_data
      : Buffer.from(msg.attachment_data);
    res.setHeader('Content-Type', msg.attachment_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    return res.send(buffer);
  }

  // Alter Speicherweg: Datei im Dateisystem (fruehere lokale Installationen)
  const UPLOAD_DIR = path.join(__dirname, 'uploads');
  const filePath = path.join(UPLOAD_DIR, msg.attachment);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.download(filePath, name);
});

// ---------------------------------------------------------------------------
// HR / Admin: Ticket-Bearbeitung
// ---------------------------------------------------------------------------
app.get('/admin', requireHR, (req, res) => {
  const status = req.query.status || 'all';
  const category = req.query.category || 'all';
  const search = String(req.query.search || '').trim();
  const overdue = req.query.overdue === '1';

  const where = [];
  const params = [];
  if (status !== 'all') { where.push('t.status = ?'); params.push(status); }
  if (category !== 'all') { where.push('t.category = ?'); params.push(category); }
  if (search) {
    // Ticketnummer (auch 4-stellig wie #0001), Betreff, Nutzer oder Stichwoerter in Nachrichten
    const numSearch = /^\d+$/.test(search) ? String(Number(search)) : null;
    const like = `%${search}%`;
    where.push(`(
      CAST(t.number AS TEXT) = ?
      OR printf('%04d', t.number) = ?
      OR t.subject LIKE ?
      OR u.username LIKE ? OR u.global_name LIKE ?
      OR EXISTS (SELECT 1 FROM messages m WHERE m.ticket_id = t.id AND m.body LIKE ? AND m.is_system = 0)
    )`);
    params.push(numSearch, search, like, like, like, like);
  }
  if (overdue) {
    where.push(`(t.due_at IS NOT NULL AND t.status != 'closed' AND t.due_at < ?)`);
    params.push(new Date().toISOString());
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const tickets = db.prepare(`
    SELECT t.*, u.username AS owner_username, u.global_name AS owner_global_name, u.avatar AS owner_avatar,
           u.discord_id AS owner_discord_id,
           c.username AS claimed_username, c.global_name AS claimed_global_name
    FROM tickets t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN users c ON c.id = t.claimed_by
    ${whereSql}
    ORDER BY
      CASE t.status WHEN 'open' THEN 0 WHEN 'pending' THEN 1 WHEN 'overdue' THEN 0 WHEN 'release' THEN 2 ELSE 3 END,
      t.updated_at DESC
  `).all(...params);

  for (const t of tickets) markOverdue(t);

  const overdueCount = db.prepare(`
    SELECT COUNT(*) AS c FROM tickets WHERE due_at IS NOT NULL AND status != 'closed' AND due_at < ?
  `).get(new Date().toISOString()).c;

  const stats = {
    open: db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE status = 'open' OR status = 'overdue'").get().c,
    pending: db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE status = 'pending'").get().c,
    release: db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE status = 'release'").get().c,
    claimed: db.prepare('SELECT COUNT(*) AS c FROM tickets WHERE claimed_by IS NOT NULL AND status != \'closed\'').get().c,
    closed: db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE status = 'closed'").get().c,
    overdue: overdueCount,
    total: db.prepare('SELECT COUNT(*) AS c FROM tickets').get().c,
    users: db.prepare('SELECT COUNT(*) AS c FROM users WHERE status = \'active\'').get().c,
  };

  res.render('admin', {
    title: 'Ticket-Verwaltung',
    tickets,
    stats,
    filters: { status, category, search, overdue },
  });
});

app.post('/admin/tickets/:id/status', requireHR, (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).end();
  if (!canEditTicket(req.user, ticket)) return res.status(403).end();

  // Write-Lock: nur ein Bearbeiter darf gleichzeitig eintragen.
  if (lockBlocks(ticket, req.user)) {
    flash(req, 'error', lockErrorMessage(ticket));
    return res.redirect(ticketViewUrl(ticket, true));
  }

  const status = req.body.status;
  // HR darf nur Offen/In Bearbeitung setzen; Freigabe/Schließen läuft über eigene Routen.
  if (!['open', 'pending'].includes(status)) return res.status(400).end();
  if (ticket.status === 'closed') return res.status(400).end();

  const now = new Date().toISOString();
  db.prepare('UPDATE tickets SET status = ?, updated_at = ?, due_at = ? WHERE id = ?')
    .run(status, now, status === 'pending' ? freshDueDate() : ticket.due_at, ticket.id);

  logTicketAction(ticket.id, req.user.id, 'status', `Status → ${statusLabel(status)}`);
  insertSystemMessage(ticket.id, `Status geaendert auf "${statusLabel(status).toLowerCase()}" von ${req.user.global_name || req.user.username}.`);
  res.redirect(req.get('Referer') || ticketViewUrl(ticket, true));
});

// Ticket durch HR/HR-HR "claimen" -> nur der Claimer darf es bearbeiten
app.post('/admin/tickets/:id/claim', requireHR, (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).end();
  if (ticket.status === 'closed') {
    flash(req, 'error', 'Geschlossene Tickets koennen nicht geclaimt werden.');
    return res.redirect(ticketViewUrl(ticket, true));
  }
  if (ticket.claimed_by && ticket.claimed_by !== req.user.id) {
    flash(req, 'error', 'Dieses Ticket ist bereits von einem anderen Mitarbeiter geclaimt.');
    return res.redirect(ticketViewUrl(ticket, true));
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tickets SET claimed_by = ?, status = CASE WHEN status = 'open' THEN 'pending' ELSE status END,
        due_at = CASE WHEN due_at IS NULL THEN ? ELSE due_at END,
        updated_at = ? WHERE id = ?
  `).run(req.user.id, freshDueDate(), now, ticket.id);

  const who = req.user.global_name || req.user.username;
  logTicketAction(ticket.id, req.user.id, 'claimed', `Übernommen von ${who}`);
  insertSystemMessage(ticket.id, `Ticket wurde von ${who} uebernommen.`);
  notifyOwnerPush(ticket, 'Ticket übernommen',
    `Dein Ticket wird jetzt von ${who} bearbeitet.`);
  notifyAllStaffPush(`Ticket #${String(ticket.number).padStart(4, '0')}`,
    `Übernommen von ${who}`,
    `${BASE_URL}/tickets/${ticket.id}`, req.user.id);
  flash(req, 'success', 'Ticket uebernommen. Nur du kannst es jetzt bearbeiten.');
  res.redirect(ticketViewUrl(ticket, true));
});

// Übernahme freigeben (Claimer selbst oder HR-HR): Damit andere Bearbeiter
// das Ticket wieder übernehmen können.
app.post('/admin/tickets/:id/unclaim', requireHR, (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).end();
  if (ticket.claimed_by !== req.user.id && !isHRHR(req.user)) return res.status(403).end();

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tickets SET claimed_by = NULL,
        status = CASE WHEN status = 'pending' THEN 'open' ELSE status END,
        updated_at = ? WHERE id = ?
  `).run(now, ticket.id);

  const who = req.user.global_name || req.user.username;
  logTicketAction(ticket.id, req.user.id, 'unclaimed', `Übernahme von ${who} freigegeben`);
  insertSystemMessage(ticket.id, `Uebernahme von ${who} freigegeben. Das Ticket ist wieder frei.`);
  flash(req, 'success', 'Übernahme freigegeben. Andere Bearbeiter können das Ticket jetzt übernehmen.');
  res.redirect(ticketViewUrl(ticket, true));
});

// ---------------------------------------------------------------------------
// Bearbeitungs-Sperre (Write-Lock): Der Bearbeiter, der das Ticket gerade
// offen hat, hält die Sperre (Heartbeat). Andere Bearbeiter können dann nicht
// gleichzeitig eintragen.
// ---------------------------------------------------------------------------
app.post('/admin/tickets/:id/lock', requireHR, (req, res) => {
  const ticket = db.prepare('SELECT id, locked_by, locked_at, status FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ ok: false });

  const action = (req.body && req.body.action) || req.query.action || 'acquire';

  if (action === 'release') {
    if (ticket.locked_by === req.user.id) {
      db.prepare('UPDATE tickets SET locked_by = NULL, locked_at = NULL WHERE id = ?').run(ticket.id);
    }
    return res.json({ ok: true });
  }

  const fresh = lockIsFresh(ticket.locked_at);
  if (ticket.locked_by && ticket.locked_by !== req.user.id && fresh) {
    const holder = db.prepare('SELECT id, username, global_name FROM users WHERE id = ?').get(ticket.locked_by);
    return res.status(409).json({
      ok: false,
      heldById: holder ? holder.id : null,
      heldByName: holder ? (holder.global_name || holder.username) : 'ein anderer Bearbeiter',
    });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE tickets SET locked_by = ?, locked_at = ? WHERE id = ?').run(req.user.id, now, ticket.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Übergabe: Ticket einem anderen HR/HR-HR uebergeben (mit Begruendung).
// ---------------------------------------------------------------------------
app.post('/admin/tickets/:id/transfer', requireHR, loadTicketFor, async (req, res) => {
  const { ticket } = req;
  if (ticket.status === 'closed') {
    flash(req, 'error', 'Geschlossene Tickets können nicht übergeben werden.');
    return res.redirect(ticketViewUrl(ticket, true));
  }
  // Nur aktueller Bearbeiter oder HR-HR kann übergeben
  if (ticket.claimed_by && ticket.claimed_by !== req.user.id && !isHRHR(req.user)) {
    flash(req, 'error', 'Nur der aktuelle Bearbeiter (oder der Inhaber) kann das Ticket übergeben.');
    return res.redirect(ticketViewUrl(ticket, true));
  }

  // Write-Lock: nur ein Bearbeiter darf gleichzeitig eintragen.
  if (lockBlocks(ticket, req.user)) {
    flash(req, 'error', lockErrorMessage(ticket));
    return res.redirect(ticketViewUrl(ticket, true));
  }

  const targetId = Number(req.body.assignee);
  const reason = String(req.body.reason || '').trim();
  if (!targetId) {
    flash(req, 'error', 'Bitte wähle einen neuen Bearbeiter aus.');
    return res.redirect(ticketViewUrl(ticket, true));
  }
  const target = db.prepare(`
    SELECT * FROM users WHERE id = ? AND role IN ('hr','hrhr') AND status = 'active'
  `).get(targetId);
  if (!target) {
    flash(req, 'error', 'Dieser Bearbeiter existiert nicht oder ist nicht aktiv.');
    return res.redirect(ticketViewUrl(ticket, true));
  }

  const fromName = req.user.global_name || req.user.username;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tickets SET assigned_to = ?, claimed_by = ?, status = 'pending',
        due_at = ?, updated_at = ? WHERE id = ?
  `).run(target.id, target.id, freshDueDate(), now, ticket.id);

  logTicketAction(ticket.id, req.user.id, 'transferred',
    `Übergeben an ${target.global_name || target.username}${reason ? ` – Begründung: ${reason}` : ''}`);
  insertSystemMessage(ticket.id,
    `Ticket von ${fromName} an ${target.global_name || target.username} übergeben.${reason ? ` Begründung: ${reason}` : ''}`);

  // E-Mail an den neuen Bearbeiter + Kunden-Info (fire-and-forget)
  if (target.email) {
    mailer.sendTicketAssignedToHR(target.email, ticket.number, ticket.subject, fromName)
      .catch((err) => console.error('Übergabe-Mail fehlgeschlagen:', err.message));
  }
  notifyCustomer(ticket, ticket.subject, 'Dein Ticket wurde an einen anderen Mitarbeiter übergeben.');

  flash(req, 'success', `Ticket an ${target.global_name || target.username} übergeben.`);
  res.redirect(ticketViewUrl(ticket, true));
});

// ---------------------------------------------------------------------------
// Freigabe ("Zum Schließen Freigeben"): jeder Bearbeiter kann das Ticket zur
// Freigabe vorlegen. Danach kann nur noch der Inhaber das Ticket schließen.
// ---------------------------------------------------------------------------
app.post('/admin/tickets/:id/release', requireHR, loadTicketFor, async (req, res) => {
  const { ticket } = req;
  if (ticket.status === 'closed') {
    flash(req, 'error', 'Geschlossene Tickets können nicht freigegeben werden.');
    return res.redirect(ticketViewUrl(ticket, true));
  }
  if (ticket.status === 'release') {
    flash(req, 'error', 'Das Ticket ist bereits zur Freigabe vorgelegt.');
    return res.redirect(ticketViewUrl(ticket, true));
  }
  if (!ticket.claimed_by) {
    flash(req, 'error', 'Das Ticket muss zuerst übernommen werden, bevor es zur Freigabe vorgelegt werden kann.');
    return res.redirect(ticketViewUrl(ticket, true));
  }

  // Write-Lock: nur ein Bearbeiter darf gleichzeitig eintragen.
  if (lockBlocks(ticket, req.user)) {
    flash(req, 'error', lockErrorMessage(ticket));
    return res.redirect(ticketViewUrl(ticket, true));
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run('release', now, ticket.id);
  insertSystemMessage(ticket.id, `Ticket wurde von ${req.user.global_name || req.user.username} zur Freigabe vorgelegt.`);
  logTicketAction(ticket.id, req.user.id, 'release_requested', 'Freigabe beantragt');

  await notifyCustomer(ticket, ticket.subject, 'Dein Ticket ist bearbeitet und wartet auf die endgültige Freigabe.');
  notifyOwnerPush(ticket, 'Freigabe',
    'Dein Ticket wurde zur Freigabe vorgelegt und wird vom Inhaber geprüft.');
  notifyAllStaffPush(`Ticket #${String(ticket.number).padStart(4, '0')}`,
    `Zur Freigabe vorgelegt von ${req.user.global_name || req.user.username}`,
    `${BASE_URL}/tickets/${ticket.id}`, req.user.id);
  flash(req, 'success', 'Ticket zur Freigabe vorgelegt. Der Inhaber entscheidet über das Schließen.');
  res.redirect(ticketViewUrl(ticket, true));
});

// ---------------------------------------------------------------------------
// Faelligkeit + naechste Aktion festlegen (Bearbeiter)
// ---------------------------------------------------------------------------
app.post('/admin/tickets/:id/due', requireHR, loadTicketFor, async (req, res) => {
  const { ticket } = req;
  if (!canEditTicket(req.user, ticket)) {
    flash(req, 'error', 'Du darfst dieses Ticket nicht bearbeiten.');
    return res.redirect(ticketViewUrl(ticket, true));
  }
  if (ticket.status === 'closed') {
    flash(req, 'error', 'Geschlossene Tickets haben keine Fälligkeit.');
    return res.redirect(ticketViewUrl(ticket, true));
  }

  // Write-Lock: nur ein Bearbeiter darf gleichzeitig eintragen.
  if (lockBlocks(ticket, req.user)) {
    flash(req, 'error', lockErrorMessage(ticket));
    return res.redirect(ticketViewUrl(ticket, true));
  }

  const dueRaw = String(req.body.due_at || '').trim();
  if (!dueRaw) {
    flash(req, 'error', 'Bitte ein Fälligkeits-Datum angeben.');
    return res.redirect(ticketViewUrl(ticket, true));
  }
  const parsedDue = parseGermanLocal(dueRaw);
  if (!parsedDue) {
    flash(req, 'error', 'Ungültiges Fälligkeits-Datum.');
    return res.redirect(ticketViewUrl(ticket, true));
  }
  const nextAction = String(req.body.next_action || '').trim();
  if (nextAction && !nextActions().includes(nextAction)) {
    flash(req, 'error', 'Ungültige nächste Aktion.');
    return res.redirect(ticketViewUrl(ticket, true));
  }

  const due = parsedDue.toISOString();
  db.prepare(`
    UPDATE tickets SET due_at = ?, next_action = ?, status = CASE WHEN status = 'open' THEN 'pending' ELSE status END,
        updated_at = ? WHERE id = ?
  `).run(due, nextAction || null, new Date().toISOString(), ticket.id);

  logTicketAction(ticket.id, req.user.id, 'due_set', `Fälligkeit: ${due}${nextAction ? `, Nächste Aktion: ${nextAction}` : ''}`);
  insertSystemMessage(ticket.id,
    `Fälligkeit festgelegt auf ${new Date(due).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' })}.` +
    (nextAction ? ` Nächste Aktion: ${nextAction}.` : ''));
  flash(req, 'success', 'Fälligkeit und nächste Aktion gespeichert.');
  res.redirect(ticketViewUrl(ticket, true));
});

// ---------------------------------------------------------------------------
// HR-HR: Account-Verwaltung
// ---------------------------------------------------------------------------
app.get('/admin/accounts', requireRoot, (req, res) => {
  const search = String(req.query.search || '').trim();
  const filter = req.query.filter || 'all';

  const where = ["u.role != 'hrhr' OR u.id = ?"];
  const params = [req.user.id];
  if (filter === 'user') where.push("u.role = 'user'");
  if (filter === 'hr') where.push("u.role = 'hr'");
  if (filter === 'disabled') where.push("u.status = 'disabled'");
  if (filter === 'deleted') where.push("u.status = 'deleted'");
  if (search) {
    where.push('(u.username LIKE ? OR u.email LIKE ? OR u.discord_username LIKE ? OR u.global_name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const users = db.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM tickets t WHERE t.user_id = u.id) AS ticket_count
    FROM users u
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE u.role WHEN 'hrhr' THEN 0 ELSE 1 END,
      CASE u.status WHEN 'active' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END,
      u.username ASC
  `).all(...params);

  const logs = normalizeLogRows(db.prepare(`
    SELECT l.*, a.username AS account_name, ar.username AS actor_name
    FROM account_logs l
    LEFT JOIN users a ON a.id = l.account_id
    LEFT JOIN users ar ON ar.id = l.actor_id
    ORDER BY l.id DESC LIMIT 50
  `).all());

  const stats = {
    hr: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'hr' AND status != 'deleted'").get().c,
    disabled: db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'disabled'").get().c,
    total: db.prepare("SELECT COUNT(*) AS c FROM users WHERE status != 'deleted'").get().c,
  };

  res.render('admin-accounts', {
    title: 'Nutzerverwaltung',
    users,
    logs,
    stats,
    search,
    filter,
    myId: req.user.id,
  });
});

// Vollstaendiges Audit-Log aller Account-Aktionen (nur Root-HR-HR)
app.get('/admin/logs', requireRoot, (req, res) => {
  const filter = req.query.filter || 'all';
  const action = req.query.action || 'all';
  const userQuery = String(req.query.user || '').trim();
  const days = Math.max(0, Number(req.query.days) || 0);
  const since = days > 0 ? new Date(Date.now() - days * 24 * 3600 * 1000).toISOString() : null;
  const sinceSql = since ? ' AND l.created_at >= ?' : '';
  const userLike = userQuery ? `%${userQuery}%` : null;

  let accountLogs = [];
  let ticketLogs = [];

  if (filter !== 'ticket') {
    const where = [];
    const p = [];
    if (action !== 'all' && action !== 'ticket') { where.push('l.action = ?'); p.push(action); }
    if (userLike) {
      where.push('(a.username LIKE ? OR a.global_name LIKE ? OR ar.username LIKE ? OR ar.global_name LIKE ?)');
      p.push(userLike, userLike, userLike, userLike);
    }
    if (since) p.push(since);
    accountLogs = normalizeLogRows(db.prepare(`
      SELECT l.*, a.username AS account_name, a.global_name AS account_global,
             ar.username AS actor_name, ar.global_name AS actor_global
      FROM account_logs l
      LEFT JOIN users a ON a.id = l.account_id
      LEFT JOIN users ar ON ar.id = l.actor_id
      WHERE ${where.length ? where.join(' AND ') : '1=1'}${sinceSql}
      ORDER BY l.id DESC LIMIT 300
    `).all(...p));
  }

  if (filter !== 'account') {
    const where = [];
    const p = [];
    if (action !== 'all' && action !== 'account') { where.push('l.action = ?'); p.push(action); }
    if (userLike) {
      where.push('(ar.username LIKE ? OR ar.global_name LIKE ?)');
      p.push(userLike, userLike);
    }
    if (since) p.push(since);
    ticketLogs = normalizeLogRows(db.prepare(`
      SELECT l.*, t.number AS ticket_number, ar.username AS actor_name, ar.global_name AS actor_global
      FROM ticket_logs l
      LEFT JOIN tickets t ON t.id = l.ticket_id
      LEFT JOIN users ar ON ar.id = l.actor_id
      WHERE ${where.length ? where.join(' AND ') : '1=1'}${sinceSql}
      ORDER BY l.id DESC LIMIT 300
    `).all(...p));
  }

  // Alle bisher bekannten Aktionen für das Dropdown (ohne Platzhalter,
  // mit deutscher Beschriftung)
  const actions = db.prepare('SELECT DISTINCT action FROM account_logs UNION SELECT DISTINCT action FROM ticket_logs ORDER BY action')
    .all().map((r) => r.action || r.ACTION).filter((a) => a && a.trim() && a !== 'unbekannt')
    .map((a) => ({ value: a, label: logActionLabel(a) }));

  res.render('admin-logs', {
    title: 'Audit-Log',
    accountLogs,
    ticketLogs,
    filter,
    action,
    userQuery,
    days,
    actions,
  });
});

// Einladungen wurden komplett entfernt: Alle Konten entstehen per
// Discord-Login. Der Inhaber vergibt die Rollen direkt hier in der
// Account-Übersicht.

app.post('/admin/accounts/:id/disable', requireRoot, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.role === 'hrhr') return renderError(res, 400, 'Nicht moeglich', 'Inhaber-Accounts koennen nicht deaktiviert werden.');

  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    flash(req, 'error', 'Bitte gib eine Begruendung an.');
    return res.redirect('/admin/accounts');
  }

  const duration = req.body.duration;
  let disableUntil = null;
  if (duration === 'custom') {
    const raw = String(req.body.disable_until || '').trim();
    if (!raw) {
      flash(req, 'error', 'Bitte gib den Zeitpunkt der automatischen Freigabe an (oder wähle "Manuell").');
      return res.redirect('/admin/accounts');
    }
    const d = parseGermanLocal(raw);
    if (!d) {
      flash(req, 'error', 'Ungültiges Freigabe-Datum.');
      return res.redirect('/admin/accounts');
    }
    disableUntil = d.toISOString();
  }

  db.prepare(`
    UPDATE users SET status = 'disabled', disabled_reason = ?, disabled_at = datetime('now'),
        disabled_by = ?, disable_until = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(reason, req.user.id, disableUntil, target.id);

  if (target.email) mailer.sendAccountDisabled(target.email, reason);
  logAccountAction(target.id, req.user.id, 'disabled',
    `${reason}${disableUntil ? ` (automatische Freigabe: ${new Date(disableUntil).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' })})` : ' (nur manuelle Freigabe)'}`);

  flash(req, 'success', `Konto von ${target.username} deaktiviert. E-Mail wurde benachrichtigt.`);
  res.redirect('/admin/accounts');
});

app.post('/admin/accounts/:id/delete', requireRoot, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.id === req.user.id || target.role === 'hrhr') {
    return renderError(res, 400, 'Nicht moeglich', 'Dieser Account kann nicht geloescht werden.');
  }

  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    flash(req, 'error', 'Bitte gib eine Begruendung an.');
    return res.redirect('/admin/accounts');
  }

  const raw = String(req.body.delete_at || '').trim();
  let when;
  if (raw) {
    // Datumsangabe: Konto wird zu diesem Zeitpunkt (deutsche Zeit) geloescht.
    when = parseGermanLocal(raw);
    if (!when) {
      flash(req, 'error', 'Ungültiges Lösch-Datum.');
      return res.redirect('/admin/accounts');
    }
  } else {
    // Feld frei gelassen -> sofort und unbegrenzt (bis zur manuellen Reaktivierung).
    when = new Date();
  }
  const deleteAt = when.toISOString();
  const now = new Date();

  if (when <= now) {
    // Sofort loeschen
    db.prepare(`
      UPDATE users SET status = 'deleted', disabled_reason = ?, disabled_at = datetime('now'),
          disabled_by = ?, disable_until = NULL, delete_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(reason, req.user.id, target.id);
    if (target.email) mailer.sendAccountDeleted(target.email, reason);
    logAccountAction(target.id, req.user.id, 'deleted', reason);
    flash(req, 'success', `Konto von ${target.username} geloescht. E-Mail wurde benachrichtigt.`);
  } else {
    // Geplante Loeschung: erst zum angegebenen Zeitpunkt
    db.prepare(`
      UPDATE users SET delete_at = ?, disabled_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(deleteAt, reason, target.id);
    logAccountAction(target.id, req.user.id, 'delete_scheduled',
      `${reason} (geplante Löschung: ${new Date(deleteAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' })})`);
    flash(req, 'success', `Löschung von ${target.username} für ${new Date(deleteAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' })} geplant.`);
  }
  res.redirect('/admin/accounts');
});

app.post('/admin/accounts/:id/enable', requireRoot, async (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || (target.status !== 'disabled' && target.status !== 'deleted')) return res.redirect('/admin/accounts');

  const reason = String(req.body.reason || '').trim();
  db.prepare(`
    UPDATE users SET status = 'active', disabled_reason = NULL, disabled_at = NULL, disabled_by = NULL,
        delete_at = NULL, disable_until = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(target.id);

  if (target.email) mailer.sendAccountReactivated(target.email, reason);
  logAccountAction(target.id, req.user.id, 'enabled', reason || 'Reaktiviert');

  flash(req, 'success', `Konto von ${target.username} reaktiviert. E-Mail wurde benachrichtigt.`);
  res.redirect('/admin/accounts');
});

// Rolle ändern: nur Inhaber (Root). Nutzer/Team/Inhaber sind waehlbar;
// Inhaber nur, wenn der Nutzer in der Konfiguration als Inhaber festgelegt ist.
app.post('/admin/accounts/:id/role', requireRoot, async (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.status === 'deleted' || target.id === req.user.id) {
    flash(req, 'error', 'Dieser Account kann nicht umgestellt werden.');
    return res.redirect('/admin/accounts');
  }

  const role = req.body.role;
  if (role === 'hrhr') {
    const authorized = discord.isAuthorizedDiscord({
      username: target.discord_username,
      global_name: target.global_name,
    });
    if (!authorized) {
      flash(req, 'error', `"${target.username}" ist nicht in der Config als Inhaber festgelegt und kann nicht zum Inhaber befördert werden.`);
      return res.redirect('/admin/accounts');
    }
  }
  if (!['user', 'hr', 'hrhr'].includes(role)) {
    flash(req, 'error', 'Ungültige Rolle.');
    return res.redirect('/admin/accounts');
  }

  const oldRole = target.role;
  db.prepare("UPDATE users SET role = ?, is_root = CASE WHEN ? = 'hrhr' AND is_root = 0 THEN 1 ELSE is_root END, updated_at = datetime('now') WHERE id = ?")
    .run(role, role, target.id);
  logAccountAction(target.id, req.user.id, 'role_changed', `Rolle: ${ROLE_LABELS[oldRole] || oldRole} → ${ROLE_LABELS[role] || role}`);

  flash(req, 'success', `Rolle von ${target.username} auf "${ROLE_LABELS[role]}" geändert.`);
  res.redirect('/admin/accounts');
});

// ---------------------------------------------------------------------------
// Account-Verlauf & Notizen (ab Team erreichbar)
// ---------------------------------------------------------------------------
app.get('/admin/accounts/:id', requireHR, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return renderError(res, 404, 'Nicht gefunden', 'Dieser Account existiert nicht.');

  const logs = normalizeLogRows(db.prepare(`
    SELECT l.*, ar.username AS actor_name, ar.global_name AS actor_global
    FROM account_logs l
    LEFT JOIN users ar ON ar.id = l.actor_id
    WHERE l.account_id = ?
    ORDER BY l.id DESC LIMIT 200
  `).all(target.id));

  const notes = db.prepare(`
    SELECT n.*, u.username, u.global_name
    FROM account_notes n
    LEFT JOIN users u ON u.id = n.author_id
    WHERE n.account_id = ?
    ORDER BY n.id DESC
  `).all(target.id);

  res.render('admin-account', {
    title: `Verlauf: ${target.global_name || target.username}`,
    target,
    logs,
    notes,
    canManage: isRoot(req.user),
  });
});

app.post('/admin/accounts/:id/note', requireHR, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    flash(req, 'error', 'Dieser Account existiert nicht.');
    return res.redirect('/admin/accounts');
  }
  const note = String(req.body.note || '').trim();
  if (!note) {
    flash(req, 'error', 'Bitte gib eine Notiz ein.');
    return res.redirect(`/admin/accounts/${target.id}`);
  }
  addAccountNote(target.id, req.user.id, note);
  logAccountAction(target.id, req.user.id, 'note_added', 'Notiz hinzugefügt');
  flash(req, 'success', 'Notiz gespeichert.');
  res.redirect(`/admin/accounts/${target.id}`);
});

// ---------------------------------------------------------------------------
// Geplante Reaktivierungen/Löschungen abarbeiten (alle 60 s)
// ---------------------------------------------------------------------------
// Einmalige Korrektur bestehender Planungen: Vor diesem Fix wurde ein
// "datetime-local"-Wert direkt als Server-Zeit interpretiert. Auf Render
// (Server = UTC) lagen damit alle geplanten Löschungen/Freigaben um die
// deutsche Zeitverschiebung (+1/+2 h) daneben. Die Migration läuft nur auf
// UTC-Servern und nur einmal (per Settings-Flag).
function migrateScheduledTimes() {
  if (new Date().getTimezoneOffset() !== 0) return;
  if (getSetting('tz_migration_v1')) return;
  const rows = db.prepare(`
    SELECT id, delete_at, disable_until FROM users
    WHERE delete_at IS NOT NULL OR disable_until IS NOT NULL
  `).all();
  let fixed = 0;
  for (const r of rows) {
    const fix = (iso) => {
      if (!iso) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      return new Date(d.getTime() - berlinOffsetMs(d)).toISOString();
    };
    const deleteAt = fix(r.delete_at);
    const disableUntil = fix(r.disable_until);
    if (deleteAt || disableUntil) {
      db.prepare('UPDATE users SET delete_at = ?, disable_until = ? WHERE id = ?')
        .run(deleteAt, disableUntil, r.id);
      fixed++;
    }
  }
  setSetting('tz_migration_v1', new Date().toISOString());
  if (fixed > 0) {
    console.log(`Migration: ${fixed} geplante Löschung(en)/Freigabe(n) auf deutsche Zeit (Europe/Berlin) korrigiert.`);
  }
}

function runAccountScheduler() {
  const now = nowUtcIso();
  const toEnable = db.prepare(`
    SELECT * FROM users WHERE status = 'disabled' AND disable_until IS NOT NULL AND disable_until <= ?
  `).all(now);
  for (const u of toEnable) {
    db.prepare(`
      UPDATE users SET status = 'active', disable_until = NULL, disabled_reason = NULL,
          disabled_at = NULL, disabled_by = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, u.id);
    logAccountAction(u.id, null, 'enabled_auto', 'Automatische Reaktivierung nach festgelegter Zeit');
    if (u.email) mailer.sendAccountReactivated(u.email, 'Automatische Reaktivierung nach festgelegter Zeit');
  }
  const toDelete = db.prepare(`
    SELECT * FROM users WHERE delete_at IS NOT NULL AND delete_at <= ?
  `).all(now);
  for (const u of toDelete) {
    db.prepare(`
      UPDATE users SET status = 'deleted', delete_at = NULL,
          disabled_reason = COALESCE(disabled_reason, 'Geplante Löschung'), disabled_at = ?,
          disabled_by = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, now, u.id);
    logAccountAction(u.id, null, 'deleted_auto', 'Automatische Löschung nach festgelegter Zeit');
    if (u.email) mailer.sendAccountDeleted(u.email, 'Ihr Konto wurde nach festgelegter Zeit gelöscht.');
  }
}

// ---------------------------------------------------------------------------
// Fehlerbehandlung
// ---------------------------------------------------------------------------
// Health-Check fuer Render (Keep-Awake-Cron fragt diese Route regelmaessig ab)
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send('ok');
});

app.use((req, res) => {
  renderError(res, 404, 'Nicht gefunden', 'Die angeforderte Seite existiert nicht.');
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) {
    return renderError(res, 400, 'Upload-Fehler',
      err.code === 'LIMIT_FILE_SIZE' ? 'Die Datei ist zu gross (max. 5 MB).' : 'Upload fehlgeschlagen.');
  }
  renderError(res, 500, 'Fehler', err.message || 'Interner Serverfehler.');
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function markAllOverdue() {
  // Alle offenen Tickets mit ueberschrittener Faelligkeit markieren
  db.prepare(`
    UPDATE tickets SET status = 'overdue'
    WHERE due_at IS NOT NULL AND status IN ('open','pending') AND due_at < ?
  `).run(new Date().toISOString());
}

if (require.main === module) {
  markAllOverdue();
  migrateScheduledTimes();
  // Account-Scheduler: automatische Freigaben/Löschungen alle 60 Sekunden
  runAccountScheduler();
  setInterval(runAccountScheduler, 60 * 1000);
  // Backup-Scheduler: wöchentliches Auto-Backup + monatliches Aufräumen.
  // Zeitstempel liegen in den Settings – überlebt damit Server-Neustarts.
  backups.runWeeklyAutoBackupIfDue();
  backups.runMonthlyCleanupIfDue();
  setInterval(() => {
    backups.runWeeklyAutoBackupIfDue();
    backups.runMonthlyCleanupIfDue();
  }, 60 * 60 * 1000);
  // Taegliche Überfaelligkeits-Markierung
  setInterval(markAllOverdue, 24 * 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`TicketSystem MRB läuft auf ${BASE_URL}`);
    if (!process.env.DISCORD_CLIENT_ID || process.env.DISCORD_CLIENT_ID === 'deine_client_id') {
      console.warn('WARNUNG: DISCORD_CLIENT_ID fehlt. Kopiere .env.example nach .env und trage deine Discord-Daten ein.');
    }
    if (!process.env.SMTP_HOST) {
      console.warn('WARNUNG: SMTP nicht konfiguriert. E-Mails landen im Ordner mail-log/ statt in echten Postfächern.');
    }
    // Einmaliger SMTP-Selbsttest: loggt sofort sichtbar, ob der Versand
    // überhaupt funktionieren kann (oder warum nicht).
    mailer.testConnection();
  });
}

module.exports = { app, sessionStore, session, runAccountScheduler }; // für Tests
