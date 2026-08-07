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
    disabled_reason   TEXT,
    disabled_at       TEXT,
    disabled_by       INTEGER,
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
}
migrateUsers();
migrateTickets();
migrateMessages();

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
};
