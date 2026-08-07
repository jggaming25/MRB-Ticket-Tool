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
const bcrypt = require('bcryptjs');

const { db, isRemote, DB_PATH: dbPaths, nextTicketNumber, insertSystemMessage, logAccountAction, logTicketAction } = require('./db');
const discord = require('./discord');
const mailer = require('./mailer');
const config = require('./config');
const {
  loadUser,
  requireLogin,
  requireHR,
  requireHRHR,
  requireRoot,
  onboardingGuard,
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
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 Tage
  },
}));

app.use(loadUser);
app.use(onboardingGuard);

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
  res.locals.isRoot = (u) => isRoot(u);
  res.locals.isOverdue = isOverdue;
  res.locals.accountStatusLabel = (s) => STATUS_LABELS[s] || s;
  res.locals.fmtDate = (iso) => {
    if (!iso) return '–';
    const d = new Date(iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  };
  next();
});

app.use('/static', express.static(path.join(__dirname, 'public')));

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

function genOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendOtpEmail(user) {
  const otp = genOtp();
  const otpHash = await bcrypt.hash(otp, 10);
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET otp_hash = ?, otp_expires = ? WHERE id = ?').run(otpHash, expires, user.id);
  await mailer.sendInvite(user.email, `${BASE_URL}/invite/${user.invite_token}`, otp);
}

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

async function notifyCustomer(ticket, subject, summary) {
  const to = customerEmailOf(ticket);
  if (!to) return;
  try {
    await mailer.sendTicketActivity(to, ticket.number, ticket.subject, summary);
  } catch (err) {
    console.error('Kundenmail fehlgeschlagen:', err.message);
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

// ---- Backups ---------------------------------------------------------------
// Nur bei der lokalen Datenbank sinnvoll. Bei Turso (Remote) sichert der
// Anbieter die Daten selbst – das Dateisystem ist dort ohnehin fluechtig.
function runBackup() {
  if (isRemote) {
    console.log('[BACKUP] Turso-Datenbank: Datei-Backup uebersprungen (Turso sichert selbst).');
    return;
  }
  const dir = config.backup.dir;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const target = path.join(dir, `ticketsystem-${stamp}.db`);
  try {
    fs.copyFileSync(dbPaths.DB_PATH, target);
  } catch (err) {
    console.error('Backup fehlgeschlagen:', err.message);
    return;
  }
  // alte Backups aufraeumen
  try {
    const cutoff = Date.now() - config.backup.keepDays * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('ticketsystem-') || !f.endsWith('.db')) continue;
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch (err) {
    console.error('Backup-Aufräumen fehlgeschlagen:', err.message);
  }
  console.log(`[BACKUP] Datenbank gesichert nach ${target}`);
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
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anmeldeversuche. Bitte warte 15 Minuten.' },
});

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
  res.render('login', { title: 'Login', values: {} });
});

app.post('/auth/login', loginLimiter, async (req, res) => {
  const identifier = String(req.body.identifier || '').trim();
  const password = String(req.body.password || '');

  const user = db.prepare(`
    SELECT * FROM users
    WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) OR LOWER(discord_username) = LOWER(?)
  `).get(identifier, identifier, identifier);

  if (!user || !user.password_hash) {
    return res.status(400).render('login', {
      title: 'Login',
      error: 'Login fehlgeschlagen. Bitte pruefe deine Zugangsdaten.',
      values: { identifier },
    });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(400).render('login', {
      title: 'Login',
      error: 'Login fehlgeschlagen. Bitte pruefe deine Zugangsdaten.',
      values: { identifier },
    });
  }

  if (user.status === 'disabled' || user.status === 'deleted') {
    return res.status(403).render('login', {
      title: 'Login',
      error: `Dein Konto ist deaktiviert.${user.disabled_reason ? ` Grund: ${user.disabled_reason}` : ''}`,
      values: { identifier },
    });
  }
  if (user.status !== 'active') {
    return res.status(403).render('login', {
      title: 'Login',
      error: 'Dein Konto ist noch nicht vollstaendig aktiviert. Schliesse die Einladung oder das Setup ab.',
      values: { identifier },
    });
  }

  db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?').run(user.id);
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = user.id;
    res.redirect('/dashboard');
  });
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

    // 1) Passende offene Einladung? (wichtigste Pruefung zuerst)
    const pendingInvites = db.prepare(`
      SELECT * FROM users WHERE status = 'invited' AND discord_username IS NOT NULL
    `).all();
    const invite = pendingInvites.find((u) => discord.matchesDiscordUsername(u.discord_username, dUser));

    let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(dUser.id);

    if (invite) {
      if (!user) {
        // Discord-Konto noch unbekannt -> an Einladung haengen
        db.prepare(`
          UPDATE users
          SET discord_id = ?, discord_username = ?, username = ?, global_name = ?,
              avatar = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(dUser.id, dUser.username, dUser.global_name || dUser.username, dUser.global_name || null, dUser.avatar || null, invite.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(invite.id);
      } else if (user.id !== invite.id) {
        // Konto existiert bereits (normaler Nutzer) -> zur HR-Einladung erhoehen
        db.prepare(`
          UPDATE users
          SET role = 'hr', status = 'invited', invite_token = ?, otp_hash = ?, otp_expires = ?,
              discord_username = ?, username = ?, global_name = ?, avatar = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(invite.invite_token, invite.otp_hash, invite.otp_expires, dUser.username,
          dUser.global_name || dUser.username, dUser.global_name || null, dUser.avatar || null, user.id);
        db.prepare("UPDATE users SET status = 'deleted', disabled_reason = 'Durch bestehendes Konto ersetzt' WHERE id = ?").run(invite.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      }
    }

    // 2) Neues Konto
    if (!user) {
      if (discord.isAuthorizedDiscord(dUser)) {
        // HR-HR: erstes Login -> Setup (Email + Passwort)
        const info = db.prepare(`
          INSERT INTO users (discord_id, discord_username, username, global_name, avatar, email, role, status, is_root, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'hrhr', 'pending_setup', 1, datetime('now'), datetime('now'))
        `).run(dUser.id, dUser.username, dUser.global_name || dUser.username, dUser.global_name || null,
          dUser.avatar || null, discordEmail);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
        logAccountAction(user.id, user.id, 'hrhr_created', 'Inhaber-Account per Discord-Registrierung angelegt');
      } else {
        // Normaler Nutzer (Kunde) – E-Mail aus Discord übernehmen, damit wir ihn
        // per E-Mail benachrichtigen koennen, sobald er ein Ticket erstellt.
        const info = db.prepare(`
          INSERT INTO users (discord_id, discord_username, username, global_name, avatar, email, role, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'user', 'active', datetime('now'), datetime('now'))
        `).run(dUser.id, dUser.username, dUser.global_name || dUser.username, dUser.global_name || null,
          dUser.avatar || null, discordEmail);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      }
    } else {
      // Bestehendes Konto: Status pruefen
      if (user.status === 'disabled' || user.status === 'deleted') {
        return renderError(res, 403, 'Konto gesperrt',
          `Dein Konto ist deaktiviert.${user.disabled_reason ? ` Grund: ${user.disabled_reason}` : ''}`);
      }
      db.prepare(`
        UPDATE users
        SET username = ?, global_name = ?, avatar = ?, discord_username = ?,
            email = CASE WHEN ? IS NOT NULL AND (email IS NULL OR email = '') THEN ? ELSE email END,
            last_login = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(dUser.global_name || dUser.username, dUser.global_name || null, dUser.avatar || null,
        dUser.username, discordEmail, discordEmail, user.id);
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
// Einladungs-Landingpage
// ---------------------------------------------------------------------------
app.get('/invite/:token', (req, res) => {
  const invite = db.prepare(`
    SELECT * FROM users WHERE invite_token = ? AND status = 'invited'
  `).get(req.params.token);

  if (!invite) {
    return renderError(res, 404, 'Einladung nicht gefunden',
      'Dieser Einladungslink ist ungueltig oder wurde bereits verwendet.');
  }

  // Falls der eingeloggte Nutzer nicht der Eingeladene ist -> Hinweis
  if (req.user && !discord.matchesDiscordUsername(invite.discord_username, {
    username: req.user.discord_username, global_name: req.user.global_name, discriminator: req.user.discriminator,
  })) {
    return renderError(res, 403, 'Falsches Konto',
      `Diese Einladung ist fuer "${invite.discord_username}" (${invite.email}). Du bist als ${req.user.username} eingeloggt.`);
  }

  res.render('invite', {
    title: 'Einladung annehmen',
    invite,
    inviteUrl: `${BASE_URL}/invite/${req.params.token}`,
  });
});

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
app.get('/onboard/setup', requireLogin, (req, res) => {
  if (req.user.status !== 'pending_setup') return res.redirect('/');
  res.render('onboard-setup', { title: 'Konto einrichten', values: {} });
});

app.post('/onboard/setup', requireLogin, async (req, res) => {
  if (req.user.status !== 'pending_setup') return res.redirect('/');

  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirm = String(req.body.password_confirm || '');
  const errors = [];

  if (!EMAIL_RE.test(email)) errors.push('Bitte gib eine gueltige E-Mail-Adresse an.');
  if (password.length < 8) errors.push('Das Passwort muss mindestens 8 Zeichen lang sein.');
  if (password !== confirm) errors.push('Die Passwoerter stimmen nicht ueberein.');

  const emailTaken = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(email, req.user.id);
  if (emailTaken) errors.push('Diese E-Mail-Adresse wird bereits von einem anderen Konto verwendet.');

  if (errors.length) {
    return res.status(400).render('onboard-setup', { title: 'Konto einrichten', errors, values: { email } });
  }

  const code = genOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const passwordHash = await bcrypt.hash(password, 10);

  db.prepare(`
    UPDATE users
    SET pending_email = ?, password_hash = ?, verify_token = ?, status = 'pending_email',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(email, passwordHash, codeHash, req.user.id);

  await mailer.sendVerificationCode(email, code);
  flash(req, 'success', 'Ein Verifizierungscode wurde an deine E-Mail-Adresse gesendet.');
  res.redirect('/onboard/verify');
});

app.get('/onboard/verify', requireLogin, (req, res) => {
  if (req.user.status !== 'pending_email') return res.redirect('/');
  res.render('onboard-verify', { title: 'E-Mail verifizieren' });
});

app.post('/onboard/verify', requireLogin, async (req, res) => {
  if (req.user.status !== 'pending_email') return res.redirect('/');

  const code = String(req.body.code || '').trim();
  const ok = req.user.verify_token && (await bcrypt.compare(code, req.user.verify_token));

  if (!ok) {
    return res.status(400).render('onboard-verify', {
      title: 'E-Mail verifizieren',
      error: 'Der Code ist ungueltig. Bitte pruefe die E-Mail.',
    });
  }

  db.prepare(`
    UPDATE users
    SET email = pending_email, pending_email = NULL, verify_token = NULL,
        status = 'active', updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id);

  logAccountAction(req.user.id, req.user.id, 'activated', 'E-Mail verifiziert, Konto aktiviert');
  flash(req, 'success', 'E-Mail verifiziert. Dein Konto ist jetzt aktiv!');
  res.redirect('/dashboard');
});

app.get('/onboard/otp', requireLogin, (req, res) => {
  if (req.user.status !== 'invited') return res.redirect('/');
  res.render('onboard-otp', { title: 'Einmalpasswort eingeben', inviteEmail: req.user.email });
});

app.post('/onboard/otp', requireLogin, async (req, res) => {
  if (req.user.status !== 'invited') return res.redirect('/');

  const otp = String(req.body.otp || '').trim();
  const ok = req.user.otp_hash
    && req.user.otp_expires && new Date(req.user.otp_expires) > new Date()
    && (await bcrypt.compare(otp, req.user.otp_hash));

  if (!ok) {
    return res.status(400).render('onboard-otp', {
      title: 'Einmalpasswort eingeben',
      error: 'Das Einmalpasswort ist ungueltig oder abgelaufen.',
      inviteEmail: req.user.email,
    });
  }

  db.prepare(`
    UPDATE users SET otp_hash = NULL, otp_expires = NULL, status = 'pending_password',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id);

  res.redirect('/onboard/password');
});

app.get('/onboard/password', requireLogin, (req, res) => {
  if (req.user.status !== 'pending_password') return res.redirect('/');
  res.render('onboard-password', { title: 'Passwort festlegen' });
});

app.post('/onboard/password', requireLogin, async (req, res) => {
  if (req.user.status !== 'pending_password') return res.redirect('/');

  const password = String(req.body.password || '');
  const confirm = String(req.body.password_confirm || '');
  const errors = [];
  if (password.length < 8) errors.push('Das Passwort muss mindestens 8 Zeichen lang sein.');
  if (password !== confirm) errors.push('Die Passwoerter stimmen nicht ueberein.');

  if (errors.length) {
    return res.status(400).render('onboard-password', { title: 'Passwort festlegen', errors });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  db.prepare(`
    UPDATE users SET password_hash = ?, invite_token = NULL, status = 'active',
        last_login = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(passwordHash, req.user.id);

  logAccountAction(req.user.id, req.user.id, 'activated', 'HR-Einladung abgeschlossen, Passwort gesetzt');
  flash(req, 'success', 'Dein Konto ist jetzt vollstaendig aktiv!');
  res.redirect('/dashboard');
});

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

app.get('/impressum', (req, res) => {
  res.render('impressum', { title: 'Impressum' });
});

app.get('/datenschutz', (req, res) => {
  res.render('datenschutz', { title: 'Datenschutzerklärung' });
});

app.get('/dashboard', requireLogin, (req, res) => {
  const quickNumber = String(req.query.number || '').trim();
  const myTickets = db.prepare(`
    SELECT t.*, u.username, u.global_name, u.avatar
    FROM tickets t JOIN users u ON u.id = t.user_id
    WHERE t.user_id = ?
    ORDER BY t.updated_at DESC
  `).all(req.user.id);

  for (const t of myTickets) markOverdue(t);

  const openCount = myTickets.filter((t) => t.status !== 'closed').length;

  res.render('dashboard', {
    title: 'Meine Tickets',
    myTickets,
    openCount,
    quickNumber,
    quickError: null,
  });
});

// Schnellsprung: Ticketnummer im Dashboard-Eingabefeld -> direkt zum Ticket
app.post('/dashboard/jump', requireLogin, (req, res) => {
  const input = String(req.body.number || '').trim().replace(/^#/, '');
  if (!/^\d+$/.test(input)) {
    return res.render('dashboard', {
      title: 'Meine Tickets',
      myTickets: db.prepare(`
        SELECT t.*, u.username, u.global_name, u.avatar
        FROM tickets t JOIN users u ON u.id = t.user_id
        WHERE t.user_id = ? ORDER BY t.updated_at DESC
      `).all(req.user.id),
      openCount: db.prepare(`
        SELECT COUNT(*) AS c FROM tickets WHERE user_id = ? AND status != 'closed'
      `).get(req.user.id).c,
      quickNumber: input,
      quickError: 'Bitte eine gültige Ticketnummer eingeben (z. B. 0042).',
    });
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE number = ?').get(Number(input));
  if (!ticket) {
    return res.render('dashboard', {
      title: 'Meine Tickets',
      myTickets: db.prepare(`
        SELECT t.*, u.username, u.global_name, u.avatar
        FROM tickets t JOIN users u ON u.id = t.user_id
        WHERE t.user_id = ? ORDER BY t.updated_at DESC
      `).all(req.user.id),
      openCount: db.prepare(`
        SELECT COUNT(*) AS c FROM tickets WHERE user_id = ? AND status != 'closed'
      `).get(req.user.id).c,
      quickNumber: input,
      quickError: `Es wurde kein Ticket mit der Nummer #${input} gefunden.`,
    });
  }

  const allowed = isHR(req.user) || ticket.user_id === req.user.id;
  if (!allowed) {
    flash(req, 'error', 'Du hast keinen Zugriff auf dieses Ticket.');
    return res.redirect('/dashboard');
  }
  res.redirect(`/tickets/${ticket.id}`);
});

// ---------------------------------------------------------------------------
// Passwort zurücksetzen (Vergessen) – benoetigt eine hinterlegte E-Mail.
// ---------------------------------------------------------------------------
app.get('/forgot-password', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('forgot-password', { title: 'Passwort vergessen', error: null, sent: false });
});

app.post('/forgot-password', loginLimiter, async (req, res) => {
  const identifier = String(req.body.identifier || '').trim();

  const user = db.prepare(`
    SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)
  `).get(identifier, identifier);

  // Aus Sicherheitsgruenden immer dieselbe Antwort geben
  if (!user || !user.email || !user.password_hash || user.status === 'deleted') {
    return res.render('forgot-password', {
      title: 'Passwort vergessen', error: null, sent: true,
    });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 Stunde
  db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?')
    .run(token, expires, user.id);

  await mailer.sendPasswordReset(user.email, `${BASE_URL}/reset-password?token=${token}`);
  res.render('forgot-password', { title: 'Passwort vergessen', error: null, sent: true });
});

app.get('/reset-password', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const token = String(req.query.token || '');
  const user = db.prepare(`
    SELECT * FROM users WHERE reset_token = ? AND reset_expires IS NOT NULL
  `).get(token);
  if (!user || new Date(user.reset_expires) < new Date()) {
    return renderError(res, 400, 'Ungueltiger Link',
      'Dieser Link ist ungueltig oder abgelaufen. Fordere einen neuen an.');
  }
  res.render('reset-password', { title: 'Passwort zurücksetzen', token, error: null });
});

app.post('/reset-password', async (req, res) => {
  const token = String(req.body.token || '');
  const user = db.prepare(`
    SELECT * FROM users WHERE reset_token = ? AND reset_expires IS NOT NULL
  `).get(token);
  if (!user || new Date(user.reset_expires) < new Date()) {
    return renderError(res, 400, 'Ungueltiger Link',
      'Dieser Link ist ungueltig oder abgelaufen. Fordere einen neuen an.');
  }

  const password = String(req.body.password || '');
  const confirm = String(req.body.password_confirm || '');
  if (password.length < 8 || password !== confirm) {
    return res.status(400).render('reset-password', {
      title: 'Passwort zurücksetzen', token, error: 'Das Passwort muss mindestens 8 Zeichen lang sein und beide Eingaben muessen uebereinstimmen.',
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  db.prepare(`
    UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL,
        status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'active' END,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(passwordHash, user.id);

  logAccountAction(user.id, user.id, 'password_reset', 'Passwort per "Vergessen"-Link zurückgesetzt');
  flash(req, 'success', 'Dein Passwort wurde geändert. Melde dich jetzt an.');
  res.redirect('/login');
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
    try {
      await mailer.sendTicketCreated(customerEmail, number, subjectTrim);
    } catch (err) {
      console.error('Bestätigungsmail fehlgeschlagen:', err.message);
    }
  }

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

  // HR/HR-HR-Accounts als Übergabe-Ziele
  const staffUsers = isHR(req.user)
    ? db.prepare(`
        SELECT id, username, global_name, role FROM users
        WHERE role IN ('hr','hrhr') AND status = 'active' AND id != ?
        ORDER BY username ASC
      `).all(req.user.id)
    : [];

  // Vollstaendiges Audit-Log des Tickets
  const logs = db.prepare(`
    SELECT l.*, a.username AS actor_name, a.global_name AS actor_global
    FROM ticket_logs l
    LEFT JOIN users a ON a.id = l.actor_id
    WHERE l.ticket_id = ?
    ORDER BY l.id ASC
  `).all(ticket.id);

  const isClosed = ticket.status === 'closed';

  res.render('ticket-view', {
    title: `Ticket #${String(ticket.number).padStart(4, '0')}`,
    ticket,
    messages,
    assignee: null,
    staffUsers,
    claimedBy,
    logs,
    canEdit,
    canClaim: isHR(req.user) && !ticket.claimed_by && !isClosed,
    canUnclaim: isHR(req.user) && ticket.claimed_by === req.user.id,
    // Nur HR-HR schließt Tickets. HR-Bearbeiter stellen sie zur Freigabe.
    canRelease: isHR(req.user) && !isHRHR(req.user) && ticket.status === 'pending' && ticket.claimed_by === req.user.id,
    canSetDue: canEdit && !isClosed,
    canClose: isHRHR(req.user) && ticket.status === 'release' && !isClosed,
    canReopen: isHRHR(req.user) && isClosed,
  });
});

app.post('/tickets/:id/message', requireLogin, loadTicketFor, upload.single('attachment'), async (req, res) => {
  const { ticket } = req;
  const body = String(req.body.body || '').trim();

  if (!canEditTicket(req.user, ticket)) {
    if (req.file) fs.unlinkSync(req.file.path);
    return renderError(res, 403, 'Kein Zugriff',
      ticket.claimed_by ? 'Dieses Ticket ist bereits an einen anderen Mitarbeiter vergeben.' : 'Du darfst dieses Ticket nicht bearbeiten.');
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

  res.redirect(`/tickets/${ticket.id}#last`);
});

// Schließen: ausschliesslich HR-HR und nur wenn das Ticket zur Freigabe steht.
app.post('/tickets/:id/close', requireHRHR, loadTicketFor, async (req, res) => {
  const { ticket } = req;
  if (ticket.status !== 'release') {
    flash(req, 'error', 'Ein Ticket kann nur geschlossen werden, wenn es zur Freigabe vorgelegt wurde.');
    return res.redirect(`/tickets/${ticket.id}`);
  }
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ?, due_at = NULL, updated_at = ? WHERE id = ?
  `).run(now, req.user.id, now, ticket.id);

  logTicketAction(ticket.id, req.user.id, 'closed', 'Ticket vom Inhaber geschlossen');
  insertSystemMessage(ticket.id, 'Das Ticket wurde geschlossen.');
  await notifyCustomer(ticket, ticket.subject, 'Dein Ticket wurde erfolgreich abgeschlossen.');
  flash(req, 'success', 'Ticket geschlossen.');
  res.redirect(`/tickets/${ticket.id}`);
});

// Wieder öffnen: nur HR-HR
app.post('/tickets/:id/reopen', requireHRHR, loadTicketFor, async (req, res) => {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL, due_at = ?, updated_at = ? WHERE id = ?
  `).run(freshDueDate(), now, req.ticket.id);

  logTicketAction(req.ticket.id, req.user.id, 'reopened', 'Ticket wieder geöffnet');
  insertSystemMessage(req.ticket.id, 'Das Ticket wurde wieder geoeffnet.');
  await notifyCustomer(req.ticket, req.ticket.subject, 'Dein Ticket wurde wieder geöffnet.');
  flash(req, 'success', 'Ticket wieder geöffnet.');
  res.redirect(`/tickets/${req.ticket.id}`);
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

  const status = req.body.status;
  // HR darf nur in Bearbeitung stellen; Freigabe/Schließen läuft über eigene Routen.
  if (!['open', 'pending'].includes(status)) return res.status(400).end();
  if (ticket.status === 'closed' && status !== 'pending') return res.status(400).end();

  const now = new Date().toISOString();
  db.prepare('UPDATE tickets SET status = ?, updated_at = ?, due_at = ? WHERE id = ?')
    .run(status, now, status === 'pending' ? freshDueDate() : ticket.due_at, ticket.id);

  logTicketAction(ticket.id, req.user.id, 'status', `Status → ${statusLabel(status)}`);
  insertSystemMessage(ticket.id, `Status geaendert auf "${statusLabel(status).toLowerCase()}" von ${req.user.global_name || req.user.username}.`);
  res.redirect(req.get('Referer') || `/tickets/${ticket.id}`);
});

// Ticket durch HR/HR-HR "claimen" -> nur der Claimer darf es bearbeiten
app.post('/admin/tickets/:id/claim', requireHR, (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).end();
  if (ticket.status === 'closed') {
    flash(req, 'error', 'Geschlossene Tickets koennen nicht geclaimt werden.');
    return res.redirect(`/tickets/${ticket.id}`);
  }
  if (ticket.claimed_by && ticket.claimed_by !== req.user.id) {
    flash(req, 'error', 'Dieses Ticket ist bereits von einem anderen Mitarbeiter geclaimt.');
    return res.redirect(`/tickets/${ticket.id}`);
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
  flash(req, 'success', 'Ticket uebernommen. Nur du kannst es jetzt bearbeiten.');
  res.redirect(`/tickets/${ticket.id}`);
});

// Claim aufheben (Claimer selbst oder HR-HR)
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
  logTicketAction(ticket.id, req.user.id, 'unclaimed', `Übernahme von ${who} aufgehoben`);
  insertSystemMessage(ticket.id, `Uebernahme von ${who} aufgehoben. Das Ticket ist wieder frei.`);
  flash(req, 'success', 'Uebernahme aufgehoben.');
  res.redirect(`/tickets/${ticket.id}`);
});

// ---------------------------------------------------------------------------
// Übergabe: Ticket einem anderen HR/HR-HR uebergeben (mit Begruendung).
// ---------------------------------------------------------------------------
app.post('/admin/tickets/:id/transfer', requireHR, loadTicketFor, async (req, res) => {
  const { ticket } = req;
  if (ticket.status === 'closed') {
    flash(req, 'error', 'Geschlossene Tickets können nicht übergeben werden.');
    return res.redirect(`/tickets/${ticket.id}`);
  }
  // Nur aktueller Bearbeiter oder HR-HR kann übergeben
  if (ticket.claimed_by && ticket.claimed_by !== req.user.id && !isHRHR(req.user)) {
    flash(req, 'error', 'Nur der aktuelle Bearbeiter (oder der Inhaber) kann das Ticket übergeben.');
    return res.redirect(`/tickets/${ticket.id}`);
  }

  const targetId = Number(req.body.assignee);
  const reason = String(req.body.reason || '').trim();
  if (!targetId) {
    flash(req, 'error', 'Bitte wähle einen neuen Bearbeiter aus.');
    return res.redirect(`/tickets/${ticket.id}`);
  }
  const target = db.prepare(`
    SELECT * FROM users WHERE id = ? AND role IN ('hr','hrhr') AND status = 'active'
  `).get(targetId);
  if (!target) {
    flash(req, 'error', 'Dieser Bearbeiter existiert nicht oder ist nicht aktiv.');
    return res.redirect(`/tickets/${ticket.id}`);
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

  // E-Mail an den neuen Bearbeiter + Kunden-Info
  if (target.email) {
    try {
      await mailer.sendTicketAssignedToHR(target.email, ticket.number, ticket.subject, fromName);
    } catch (err) {
      console.error('Übergabe-Mail fehlgeschlagen:', err.message);
    }
  }
  await notifyCustomer(ticket, ticket.subject, 'Dein Ticket wurde an einen anderen Mitarbeiter übergeben.');

  flash(req, 'success', `Ticket an ${target.global_name || target.username} übergeben.`);
  res.redirect(`/tickets/${ticket.id}`);
});

// ---------------------------------------------------------------------------
// Freigabe zur Schliessung: HR legt Abschlussbericht vor, HR-HR schliesst.
// ---------------------------------------------------------------------------
app.post('/admin/tickets/:id/release', requireHR, loadTicketFor, async (req, res) => {
  const { ticket } = req;
  if (ticket.status !== 'pending') {
    flash(req, 'error', 'Nur Tickets "In Bearbeitung" können zur Freigabe vorgelegt werden.');
    return res.redirect(`/tickets/${ticket.id}`);
  }
  if (ticket.claimed_by !== req.user.id) {
    flash(req, 'error', 'Nur der aktuelle Bearbeiter kann das Ticket zur Freigabe vorlegen.');
    return res.redirect(`/tickets/${ticket.id}`);
  }

  const report = String(req.body.report || '').trim();
  if (report.length < 5) {
    flash(req, 'error', 'Bitte beschreibe den Abschlussbericht (mindestens 5 Zeichen).');
    return res.redirect(`/tickets/${ticket.id}`);
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run('release', ticket.id);
  insertSystemMessage(ticket.id, `Freigabe zur Schliessung beantragt. Abschlussbericht: ${report}`);
  logTicketAction(ticket.id, req.user.id, 'release_requested', `Freigabe zur Schliessung beantragt (Abschlussbericht eingereicht)`);

  await notifyCustomer(ticket, ticket.subject, 'Dein Ticket ist bearbeitet und wartet auf die endgültige Freigabe.');
  flash(req, 'success', 'Ticket zur Freigabe vorgelegt. Der Inhaber entscheidet über das Schließen.');
  res.redirect(`/tickets/${ticket.id}`);
});

// ---------------------------------------------------------------------------
// Faelligkeit + naechste Aktion festlegen (Bearbeiter)
// ---------------------------------------------------------------------------
app.post('/admin/tickets/:id/due', requireHR, loadTicketFor, async (req, res) => {
  const { ticket } = req;
  if (!canEditTicket(req.user, ticket)) {
    flash(req, 'error', 'Du darfst dieses Ticket nicht bearbeiten.');
    return res.redirect(`/tickets/${ticket.id}`);
  }
  if (ticket.status === 'closed') {
    flash(req, 'error', 'Geschlossene Tickets haben keine Fälligkeit.');
    return res.redirect(`/tickets/${ticket.id}`);
  }

  const hours = Number(req.body.hours);
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
    flash(req, 'error', 'Ungültiger Zeitraum (1–720 Stunden).');
    return res.redirect(`/tickets/${ticket.id}`);
  }
  const nextAction = String(req.body.next_action || '').trim();
  if (nextAction && !nextActions().includes(nextAction)) {
    flash(req, 'error', 'Ungültige nächste Aktion.');
    return res.redirect(`/tickets/${ticket.id}`);
  }

  const due = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE tickets SET due_at = ?, next_action = ?, status = CASE WHEN status = 'open' THEN 'pending' ELSE status END,
        updated_at = ? WHERE id = ?
  `).run(due, nextAction || null, new Date().toISOString(), ticket.id);

  logTicketAction(ticket.id, req.user.id, 'due_set', `Fälligkeit: ${due}${nextAction ? `, Nächste Aktion: ${nextAction}` : ''}`);
  insertSystemMessage(ticket.id,
    `Fälligkeit festgelegt auf ${new Date(due).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}.` +
    (nextAction ? ` Nächste Aktion: ${nextAction}.` : ''));
  flash(req, 'success', 'Fälligkeit und nächste Aktion gespeichert.');
  res.redirect(`/tickets/${ticket.id}`);
});

// ---------------------------------------------------------------------------
// HR-HR: Account-Verwaltung
// ---------------------------------------------------------------------------
app.get('/admin/accounts', requireRoot, (req, res) => {
  const search = String(req.query.search || '').trim();
  const filter = req.query.filter || 'all';

  const where = ["u.role != 'hrhr' OR u.id = ?"];
  const params = [req.user.id];
  if (filter === 'hr') where.push("u.role = 'hr'");
  if (filter === 'disabled') where.push("u.status = 'disabled'");
  if (filter === 'invited') where.push("u.status = 'invited'");
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
      CASE u.status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 WHEN 'pending_password' THEN 1
           WHEN 'pending_setup' THEN 1 WHEN 'pending_email' THEN 1 WHEN 'disabled' THEN 2 ELSE 3 END,
      u.username ASC
  `).all(...params);

  const logs = db.prepare(`
    SELECT l.*, a.username AS account_name, ar.username AS actor_name
    FROM account_logs l
    LEFT JOIN users a ON a.id = l.account_id
    LEFT JOIN users ar ON ar.id = l.actor_id
    ORDER BY l.id DESC LIMIT 50
  `).all();

  const stats = {
    hr: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'hr' AND status != 'deleted'").get().c,
    invited: db.prepare("SELECT COUNT(*) AS c FROM users WHERE status IN ('invited','pending_password','pending_setup','pending_email')").get().c,
    disabled: db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'disabled'").get().c,
    total: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role IN ('hr','hrhr') AND status != 'deleted'").get().c,
  };

  res.render('admin-accounts', {
    title: 'Team-Verwaltung',
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
  const where = [];
  const params = [];
  if (filter === 'account') where.push("l.action IN ('invited','disabled','enabled','deleted','role_changed','activated','hrhr_created','password_reset')");
  if (filter === 'ticket') where.push('l.action IN (SELECT DISTINCT action FROM ticket_logs)');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const accountLogs = db.prepare(`
    SELECT l.*, a.username AS account_name, ar.username AS actor_name, ar.global_name AS actor_global
    FROM account_logs l
    LEFT JOIN users a ON a.id = l.account_id
    LEFT JOIN users ar ON ar.id = l.actor_id
    ${filter === 'ticket' ? 'WHERE 1=0' : whereSql}
    ORDER BY l.id DESC LIMIT 300
  `).all(...params);

  const ticketLogs = db.prepare(`
    SELECT l.*, t.number AS ticket_number, ar.username AS actor_name, ar.global_name AS actor_global
    FROM ticket_logs l
    LEFT JOIN tickets t ON t.id = l.ticket_id
    LEFT JOIN users ar ON ar.id = l.actor_id
    ORDER BY l.id DESC LIMIT 300
  `).all();

  res.render('admin-logs', {
    title: 'Audit-Log',
    accountLogs,
    ticketLogs,
    filter,
  });
});

app.post('/admin/accounts/invite', requireRoot, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const discordUsername = String(req.body.discord_username || '').trim();

  const errors = [];
  if (!EMAIL_RE.test(email)) errors.push('Bitte gib eine gueltige E-Mail-Adresse an.');
  if (!discordUsername) errors.push('Bitte gib den Discord-Username ein.');

  if (!errors.length) {
    const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = ? AND status != \'deleted\'').get(email);
    if (existingEmail) errors.push('Diese E-Mail-Adresse ist bereits vergeben.');
  }
  if (!errors.length) {
    const existingDisc = db.prepare(`
      SELECT id FROM users WHERE LOWER(discord_username) = LOWER(?) AND status != 'deleted'
    `).get(discordUsername);
    if (existingDisc) errors.push('Fuer diesen Discord-Username existiert bereits ein Konto.');
  }

  if (errors.length) {
    flash(req, 'error', errors.join(' '));
    return res.redirect('/admin/accounts');
  }

  const otp = genOtp();
  const otpHash = await bcrypt.hash(otp, 10);
  const inviteToken = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const info = db.prepare(`
    INSERT INTO users (username, discord_username, email, role, status, otp_hash, otp_expires, invite_token, created_at, updated_at)
    VALUES (?, ?, ?, 'hr', 'invited', ?, ?, ?, datetime('now'), datetime('now'))
  `).run(discordUsername, discordUsername, email, otpHash, expires, inviteToken);

  await mailer.sendInvite(email, `${BASE_URL}/invite/${inviteToken}`, otp);
  logAccountAction(info.lastInsertRowid, req.user.id, 'invited', `Eingeladen als Team (${discordUsername}, ${email})`);

  flash(req, 'success', `Einladung an ${email} gesendet (inkl. Einmalpasswort).`);
  res.redirect('/admin/accounts');
});

app.post('/admin/accounts/:id/disable', requireRoot, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.role === 'hrhr') return renderError(res, 400, 'Nicht moeglich', 'Inhaber-Accounts koennen nicht deaktiviert werden.');

  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    flash(req, 'error', 'Bitte gib eine Begruendung an.');
    return res.redirect('/admin/accounts');
  }

  db.prepare(`
    UPDATE users SET status = 'disabled', disabled_reason = ?, disabled_at = datetime('now'),
        disabled_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(reason, req.user.id, target.id);

  if (target.email) mailer.sendAccountDisabled(target.email, reason);
  logAccountAction(target.id, req.user.id, 'disabled', reason);

  flash(req, 'success', `Konto von ${target.username} deaktiviert. E-Mail wurde benachrichtigt.`);
  res.redirect('/admin/accounts');
});

app.post('/admin/accounts/:id/enable', requireRoot, async (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.status !== 'disabled') return res.redirect('/admin/accounts');

  const reason = String(req.body.reason || '').trim();
  const neverCompleted = !target.password_hash;

  if (neverCompleted) {
    // Einladung war noch nicht abgeschlossen -> erneut einladen
    const otp = genOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const inviteToken = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE users SET status = 'invited', otp_hash = ?, otp_expires = ?, invite_token = ?,
          disabled_reason = NULL, disabled_at = NULL, disabled_by = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(otpHash, expires, inviteToken, target.id);
    await mailer.sendInvite(target.email, `${BASE_URL}/invite/${inviteToken}`, otp);
  } else {
    db.prepare(`
      UPDATE users SET status = 'active', disabled_reason = NULL, disabled_at = NULL, disabled_by = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(target.id);
  }

  if (target.email) mailer.sendAccountReactivated(target.email, reason);
  logAccountAction(target.id, req.user.id, 'enabled', reason || 'Reaktiviert');

  flash(req, 'success', `Konto von ${target.username} reaktiviert. E-Mail wurde benachrichtigt.`);
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

  db.prepare(`
    UPDATE users SET status = 'deleted', disabled_reason = ?, disabled_at = datetime('now'),
        disabled_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(reason, req.user.id, target.id);

  if (target.email) mailer.sendAccountDeleted(target.email, reason);
  logAccountAction(target.id, req.user.id, 'deleted', reason);

  flash(req, 'success', `Konto von ${target.username} geloescht. E-Mail wurde benachrichtigt.`);
  res.redirect('/admin/accounts');
});

// Rolle ändern: nur Root-HR-HR. Promotion zum HR-HR geht nur, wenn der
// Nutzer ein festgelegter Root (im Script autorisiert) ist – sonst Sperre.
app.post('/admin/accounts/:id/role', requireRoot, async (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.status !== 'active' || target.id === req.user.id) {
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
  if (!['hr', 'hrhr'].includes(role)) {
    flash(req, 'error', 'Ungültige Rolle.');
    return res.redirect('/admin/accounts');
  }

  const oldRole = target.role;
  db.prepare("UPDATE users SET role = ?, is_root = CASE WHEN ? = 'hrhr' AND is_root = 0 THEN 1 ELSE is_root END, updated_at = datetime('now') WHERE id = ?")
    .run(role, role, target.id);
  logAccountAction(target.id, req.user.id, 'role_changed', `Rolle: ${oldRole} → ${role}`);

  flash(req, 'success', `Rolle von ${target.username} auf "${role === 'hrhr' ? 'Inhaber' : 'Team'}" geändert.`);
  res.redirect('/admin/accounts');
});

// Passwort eines Accounts per Admin zuruecksetzen (Root-HR-HR)
app.post('/admin/accounts/:id/reset-password', requireRoot, async (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || !target.email || target.status === 'deleted') {
    flash(req, 'error', 'Für diesen Account kann kein Passwort-Reset ausgelöst werden.');
    return res.redirect('/admin/accounts');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?')
    .run(token, expires, target.id);

  await mailer.sendPasswordReset(target.email, `${BASE_URL}/reset-password?token=${token}`);
  logAccountAction(target.id, req.user.id, 'password_reset', 'Passwort-Reset per Admin ausgelöst');

  flash(req, 'success', `Passwort-Reset-E-Mail an ${target.email} gesendet.`);
  res.redirect('/admin/accounts');
});

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
  runBackup();
  // Taegliches Backup + taegliche Überfaelligkeits-Markierung
  setInterval(() => {
    markAllOverdue();
    runBackup();
  }, 24 * 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`TicketSystem MRB läuft auf ${BASE_URL}`);
    if (!process.env.DISCORD_CLIENT_ID || process.env.DISCORD_CLIENT_ID === 'deine_client_id') {
      console.warn('WARNUNG: DISCORD_CLIENT_ID fehlt. Kopiere .env.example nach .env und trage deine Discord-Daten ein.');
    }
    if (!process.env.SMTP_HOST) {
      console.warn('WARNUNG: SMTP nicht konfiguriert. E-Mails landen im Ordner mail-log/ statt in echten Postfächern.');
    }
  });
}

module.exports = { app, sessionStore, session }; // für Tests
