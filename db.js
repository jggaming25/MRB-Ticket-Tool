'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Datenbank: Lokal (node:sqlite) oder Turso in der Cloud.
// Setzt man TURSO_URL (und ggf. TURSO_AUTH_TOKEN) in der .env bzw. als
// Umgebungsvariable, wird die synchrone libsql-Verbindung zu Turso verwendet.
// Das ist fuer Render/Deploys gedacht, damit keine Daten verloren gehen.
// ---------------------------------------------------------------------------
// Im Testmodus (NODE_ENV='test') nie Remote nutzen – auch wenn TURSO_URL
// in der .env steht. Sonst wuerde ein Test die Produktionsdatenbank
// veraendern/verschmutzen.
const isRemote = process.env.NODE_ENV !== 'test' && !!(process.env.TURSO_URL);

let db;

if (isRemote) {
  const Database = require('libsql');
  db = new Database(process.env.TURSO_URL, {
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = process.env.DB_DIR || path.join(__dirname, 'data');
  const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'tickets.db');
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  db = new DatabaseSync(DB_PATH);
}

// PRAGMAs, die lokal sinnvoll sind. Remote (Turso) werden sie ignoriert,
// weil sie dort teils nicht unterstuetzt werden.
try { db.exec('PRAGMA journal_mode = WAL;'); } catch { /* remote */ }
try { db.exec('PRAGMA foreign_keys = ON;'); } catch { /* remote */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id        TEXT UNIQUE,
    discord_username  TEXT,
    username          TEXT NOT NULL,
    global_name       TEXT,
    discriminator     TEXT,
    avatar            TEXT,
    email             TEXT,
    password_hash     TEXT,
    role              TEXT NOT NULL DEFAULT 'user',
    status            TEXT NOT NULL DEFAULT 'active',
    is_root           INTEGER NOT NULL DEFAULT 0,
    otp_hash          TEXT,
    otp_expires       TEXT,
    invite_token      TEXT,
    verify_token      TEXT,
    reset_token       TEXT,
    reset_expires     TEXT,
    pending_email     TEXT,
    notify_changes    INTEGER NOT NULL DEFAULT 0,
    discord_roles     TEXT,
    disabled_reason   TEXT,
    disabled_at       TEXT,
    disabled_by       INTEGER,
    disable_until     TEXT,
    delete_at         TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    last_login        TEXT
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    number        INTEGER NOT NULL UNIQUE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject       TEXT NOT NULL,
    category      TEXT NOT NULL,
    priority      TEXT NOT NULL DEFAULT 'medium',
    status        TEXT NOT NULL DEFAULT 'open',
    assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    claimed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due_at        TEXT,
    next_action   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at     TEXT,
    closed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body          TEXT NOT NULL,
    author_role   TEXT NOT NULL DEFAULT 'user',
    is_system     INTEGER NOT NULL DEFAULT 0,
    attachment    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS account_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
    actor_id    INTEGER,
    action      TEXT NOT NULL,
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS account_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
    author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL,
    keys_auth    TEXT NOT NULL,
    keys_p256dh  TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, endpoint)
  );

  CREATE TABLE IF NOT EXISTS ticket_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id   INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    actor_id    INTEGER,
    action      TEXT NOT NULL,
    details     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`);

// Sanfte Migration fuer bestehende Datenbanken (neue Spalten ergaenzen).
function migrateTickets() {
  const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  const add = (name, def) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${def}`);
      cols.push(name);
    }
  };
  add('claimed_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  add('due_at', 'TEXT');
  add('next_action', 'TEXT');
  add('locked_by', 'INTEGER');
  add('locked_at', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id   INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
      actor_id    INTEGER,
      action      TEXT NOT NULL,
      details     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function migrateMessages() {
  // Anhaenge werden ab jetzt als Blob direkt in der Datenbank gespeichert
  // (wichtig fuer Render, wo das Dateisystem fluechtig ist).
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  const add = (name, def) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${def}`);
      cols.push(name);
    }
  };
  add('attachment_name', 'TEXT');
  add('attachment_mime', 'TEXT');
  add('attachment_data', 'BLOB');
}

function migrateUsers() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const add = (name, def) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
      cols.push(name);
    }
  };
  add('discord_username', 'TEXT');
  add('email', 'TEXT');
  add('password_hash', 'TEXT');
  add('role', "TEXT NOT NULL DEFAULT 'user'");
  add('status', "TEXT NOT NULL DEFAULT 'active'");
  add('otp_hash', 'TEXT');
  add('otp_expires', 'TEXT');
  add('invite_token', 'TEXT');
  add('verify_token', 'TEXT');
  add('pending_email', 'TEXT');
  add('last_mail_sent_at', 'TEXT');
  add('disabled_reason', 'TEXT');
  add('disabled_at', 'TEXT');
  add('disabled_by', 'INTEGER');
  add('is_root', 'INTEGER NOT NULL DEFAULT 0');
  add('reset_token', 'TEXT');
  add('reset_expires', 'TEXT');
  add('notify_changes', 'INTEGER NOT NULL DEFAULT 0');
  add('discord_roles', 'TEXT');
  add('disable_until', 'TEXT');
  add('delete_at', 'TEXT');
  // Altes is_staff-Flag auf neue Rollen abbilden
  if (cols.includes('is_staff') && !cols.includes('role')) {
    db.exec("UPDATE users SET role = 'hr' WHERE is_staff = 1");
  }
  // Bisherige HR-HR gelten als "im Script festgelegte" Root-Accounts
  db.exec("UPDATE users SET is_root = 1 WHERE role = 'hrhr' AND is_root = 0");
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
      actor_id    INTEGER,
      action      TEXT NOT NULL,
      reason      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
      author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      note        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint     TEXT NOT NULL,
      keys_auth    TEXT NOT NULL,
      keys_p256dh  TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, endpoint)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS backups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kind         TEXT NOT NULL DEFAULT 'auto',
      created_by   INTEGER,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      size         INTEGER NOT NULL DEFAULT 0,
      data         TEXT NOT NULL
    );
  `);
}
migrateUsers();
migrateTickets();
migrateMessages();

// Anzeigenamen fuer Audit-Log-Aktionen (Roh-Keys -> deutsche Beschriftung).
const LOG_ACTION_LABELS = {
  // Ticket-Aktionen
  created: 'Erstellt',
  reply: 'Antwort',
  closed: 'Geschlossen',
  reopened: 'Wieder geöffnet',
  status: 'Status geändert',
  claimed: 'Übernommen',
  unclaimed: 'Übernahme freigegeben',
  transferred: 'Übertragen',
  release_requested: 'Freigabe beantragt',
  due_set: 'Fälligkeit gesetzt',
  // Konto-Aktionen
  hrhr_created: 'Inhaber angelegt',
  lockdown_enabled: 'Zugriff gesperrt',
  lockdown_disabled: 'Zugriff freigegeben',
  alarm_set: 'Meldung gesetzt',
  alarm_cleared: 'Meldung aufgehoben',
  system_restart: 'Neustart',
  backups_cleared: 'Backups gelöscht',
  disabled: 'Deaktiviert',
  delete_scheduled: 'Löschung geplant',
  deleted: 'Gelöscht',
  enabled: 'Aktiviert',
  enabled_auto: 'Auto-Reaktivierung',
  deleted_auto: 'Auto-Löschung',
  role_changed: 'Rolle geändert',
  note_added: 'Notiz hinzugefügt',
  // Legacy-Keys (ältere Einträge, die vor der Umbenennung geschrieben wurden)
  activated: 'Konto aktiviert',
  invited: 'Eingeladen',
  password_reset: 'Passwort zurückgesetzt',
};

// Beschriftung fuer die UI: bekannte Aktionen -> deutsches Label,
// sonst lesbarer Ersatz statt eines rohen Keys bzw. "unbekannt".
// Die Action-Spalte kann je nach DB-Schema "action" oder "ACTION" heissen
// (Turso legt sie historisch grossgeschrieben an) – daher case-insensitiv.
function logActionLabel(action, detail) {
  const key = action == null ? '' : String(action);
  if (LOG_ACTION_LABELS[key]) return LOG_ACTION_LABELS[key];
  if (LOG_ACTION_LABELS[key.toLowerCase()]) return LOG_ACTION_LABELS[key.toLowerCase()];
  if (key && key.toLowerCase() !== 'unbekannt') return key;
  return 'Unbekannt';
}

// Best-Effort-Rekonstruktion fehlender Aktionen aus den Detail-/Begruendungs-
// Texten (aeltere Eintraege besassen keine Aktion). Reihenfolge wichtig:
// speziellere Muster vor allgemeinen.
const TICKET_ACTION_BY_TEXT = [
  [/wieder geöffnet|wieder geoeffnet/i, 'reopened'],
  [/Freigabe zur Schliessung beantragt|Freigabe zur Schließung beantragt|Freigabe beantragt/i, 'release_requested'],
  [/Übernahme von .* aufgehoben|Übernahme von .* freigegeben|freigegeben|aufgehoben/i, 'unclaimed'],
  [/Übernommen von/i, 'claimed'],
  [/Übergeben an|übergeben/i, 'transferred'],
  [/Fälligkeit/i, 'due_set'],
  [/geschlossen/i, 'closed'],
  [/Status →|Status zu/i, 'status'],
  [/Nachricht von/i, 'reply'],
  [/erstellt/i, 'created'],
];
const ACCOUNT_ACTION_BY_TEXT = [
  [/HR-HR-Account|Inhaber-Account/i, 'hrhr_created'],
  [/Meldung aufgehoben/i, 'alarm_cleared'],
  [/Meldung gesetzt/i, 'alarm_set'],
  [/IT-Alarm deaktiviert/i, 'alarm_cleared'],
  [/IT-Alarm gesetzt/i, 'alarm_set'],
  [/Backups manuell gelöscht/i, 'backups_cleared'],
  [/Neustart/i, 'system_restart'],
  [/Automatische Reaktivierung/i, 'enabled_auto'],
  [/Automatische Löschung/i, 'deleted_auto'],
  [/Löschung geplant/i, 'delete_scheduled'],
  [/reaktiviert/i, 'enabled'],
  [/E-Mail verifiziert|Einladung abgeschlossen|Konto aktiviert|aktiviert/i, 'activated'],
  [/Eingeladen als/i, 'invited'],
  [/Passwort per .* zurückgesetzt|Passwort-Reset|Passwort per "Vergessen"/i, 'password_reset'],
  [/Rolle/i, 'role_changed'],
  [/Notiz/i, 'note_added'],
  [/gesperrt/i, 'lockdown_enabled'],
  [/freigegeben/i, 'lockdown_disabled'],
  [/Löschung|gelöscht/i, 'deleted'],
  [/deaktiviert/i, 'disabled'],
];

function guessTicketAction(details) {
  const d = details || '';
  for (const [re, key] of TICKET_ACTION_BY_TEXT) {
    if (re.test(d)) return key;
  }
  return null;
}

function guessAccountAction(reason) {
  const r = reason || '';
  for (const [re, key] of ACCOUNT_ACTION_BY_TEXT) {
    if (re.test(r)) return key;
  }
  return null;
}

// Bereinigt alte/leere Audit-Log-Eintraege: Fehlende Aktionen werden so gut
// wie moeglich aus Details/Begruendung rekonstruiert, statt dauerhaft
// "unbekannt" anzuzeigen. Laueft bei jedem Start und repariert auch bereits
// auf "unbekannt" gesetzte Alteintraege.
function migrateLogActions() {
  try {
    const rows = db.prepare(
      "SELECT id, details FROM ticket_logs WHERE action IS NULL OR lower(trim(action)) IN ('', 'unbekannt')"
    ).all();
    const upd = db.prepare('UPDATE ticket_logs SET action = ? WHERE id = ?');
    for (const r of rows) {
      upd.run(guessTicketAction(r.details) || 'unbekannt', r.id);
    }
  } catch {}
  try {
    const rows = db.prepare(
      "SELECT id, reason FROM account_logs WHERE action IS NULL OR lower(trim(action)) IN ('', 'unbekannt')"
    ).all();
    const upd = db.prepare('UPDATE account_logs SET action = ? WHERE id = ?');
    for (const r of rows) {
      upd.run(guessAccountAction(r.reason) || 'unbekannt', r.id);
    }
  } catch {}
}
migrateLogActions();

const stmts = {
  nextNumber: db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM tickets'),
};

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function nextTicketNumber() {
  return stmts.nextNumber.get().next;
}

// System-Nachricht als Unterstuetzer "System" schreiben (kein User noetig).
function insertSystemMessage(ticketId, text) {
  db.prepare(`
    INSERT INTO messages (ticket_id, user_id, body, author_role, is_system)
    VALUES (?, NULL, ?, 'staff', 1)
  `).run(ticketId, text);
}

function logAccountAction(accountId, actorId, action, reason = null) {
  db.prepare(`
    INSERT INTO account_logs (account_id, actor_id, action, reason)
    VALUES (?, ?, ?, ?)
  `).run(accountId, actorId, action, reason);
}

function logTicketAction(ticketId, actorId, action, details = null) {
  db.prepare(`
    INSERT INTO ticket_logs (ticket_id, actor_id, action, details)
    VALUES (?, ?, ?, ?)
  `).run(ticketId, actorId, action, details);
}

function addAccountNote(accountId, authorId, note) {
  db.prepare(`
    INSERT INTO account_notes (account_id, author_id, note)
    VALUES (?, ?, ?)
  `).run(accountId, authorId, note);
}

module.exports = {
  db,
  isRemote,
  DB_PATH: isRemote ? null : (process.env.DB_PATH || path.join(process.env.DB_DIR || path.join(__dirname, 'data'), 'tickets.db')),
  getSetting,
  setSetting,
  nextTicketNumber,
  insertSystemMessage,
  logAccountAction,
  logTicketAction,
  logActionLabel,
  migrateLogActions,
  addAccountNote,
};
