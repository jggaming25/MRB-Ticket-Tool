'use strict';

const { db, getSetting, setSetting } = require('./db');
const config = require('./config');

// ---------------------------------------------------------------------------
// Backups: Alle Daten (Nutzer, Tickets, Nachrichten, Anhänge, Logs, ...)
// werden als JSON-Dump in der Datenbank-Tabelle `backups` gespeichert. Damit
// funktionieren Backups auch bei Turso/Render (kein Dateisystem noetig).
// Limit: config.backup.max (20). Automatisch wöchentlich; monatlich wird
// automatisch aufgeräumt (die neuesten monthlyKeep bleiben). Der Inhaber kann
// jederzeit manuell aufräumen und einzelne Backups löschen/herunterladen.
// ---------------------------------------------------------------------------

function maxSlots() {
  return config.backup.max || 20;
}

function listBackups() {
  return db.prepare(`
    SELECT id, kind, created_by, created_at, size FROM backups
    ORDER BY id DESC
  `).all();
}

function countBackups() {
  return db.prepare('SELECT COUNT(*) AS c FROM backups').get().c;
}

function slotsFree() {
  return Math.max(0, maxSlots() - countBackups());
}

// BLOB-Spalten (z. B. Anhänge) base64-kodieren, damit der Dump gültiges JSON
// ist und vollständig restauriert werden kann.
function dumpAll() {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'backups'
    ORDER BY name
  `).all().map((r) => r.name);

  const data = {};
  for (const t of tables) {
    data[t] = db.prepare(`SELECT * FROM "${t}"`).all().map((row) => {
      const out = {};
      for (const key in row) {
        const v = row[key];
        out[key] = (v instanceof Uint8Array || Buffer.isBuffer(v))
          ? { $blob: Buffer.from(v).toString('base64') }
          : v;
      }
      return out;
    });
  }
  return JSON.stringify(data);
}

function createBackup(kind, createdBy = null) {
  if (countBackups() >= maxSlots()) {
    return { ok: false, reason: 'limit', free: 0 };
  }
  const data = dumpAll();
  const size = Buffer.byteLength(data, 'utf8');
  const info = db.prepare(`
    INSERT INTO backups (kind, created_by, size, data) VALUES (?, ?, ?, ?)
  `).run(kind, createdBy, size, data);
  return { ok: true, id: info.lastInsertRowid, size, free: slotsFree() };
}

function getBackup(id) {
  return db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
}

function deleteBackup(id) {
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
}

// Nur für den Inhaber (jlg09): löscht ALLE Backups, um alle Slots freizugeben.
function clearAllBackups() {
  db.prepare('DELETE FROM backups').run();
}

// BLOB-Werte aus dem Dump zurueck in Binärdaten wandeln
// ({ $blob: "<base64>" } -> Buffer).
function decodeValue(v) {
  if (v && typeof v === 'object' && typeof v.$blob === 'string') {
    return Buffer.from(v.$blob, 'base64');
  }
  return v;
}

function trySetForeignKeys(on) {
  try {
    db.exec(on ? 'PRAGMA foreign_keys = ON' : 'PRAGMA foreign_keys = OFF');
    return true;
  } catch {
    return false;
  }
}

// Ein Backup wieder einspielen: Alle Tabellen werden geleert und mit den
// gespeicherten Daten neu befuellt (Backup-Tabelle selbst bleibt unberührt).
// Liefert { ok, restored: { tabelle: anzahl }, error? }.
function restoreBackup(id) {
  const backup = getBackup(id);
  if (!backup) return { ok: false, reason: 'notfound' };
  let data;
  try {
    data = JSON.parse(backup.data);
  } catch (e) {
    return { ok: false, reason: 'corrupt', error: 'Backup-Datei ist beschädigt (kein gültiges JSON).' };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, reason: 'corrupt', error: 'Backup-Datei ist beschädigt (leerer Inhalt).' };
  }

  const tables = Object.keys(data).filter((t) =>
    !t.startsWith('sqlite_') && t !== 'backups' && Array.isArray(data[t]));

  // Fremdschlüssel während des Wiederherstellens deaktivieren, damit die
  // Zeilen unabhängig von der alphabetischen Reihenfolge eingespielt werden
  // können. Beim Turso/liblsql wird die PRAGMA ignoriert -> kein Problem.
  trySetForeignKeys(false);
  const result = { ok: true, restored: {} };
  try {
    db.exec('BEGIN');
    try {
      for (const t of tables) db.exec(`DELETE FROM "${t}"`);
      try { db.exec('DELETE FROM sqlite_sequence'); } catch (e) { /* nicht überall vorhanden */ }
    } catch (e) {
      db.exec('ROLLBACK');
      trySetForeignKeys(true);
      return { ok: false, reason: 'error', error: e.message };
    }
    try {
      for (const t of tables) {
        const rows = data[t];
        if (!rows.length) { result.restored[t] = 0; continue; }
        const cols = Object.keys(rows[0]);
        const ins = db.prepare(
          `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) ` +
          `VALUES (${cols.map(() => '?').join(', ')})`);
        for (const row of rows) {
          ins.run(...cols.map((c) => decodeValue(row[c])));
        }
        result.restored[t] = rows.length;
      }
    } catch (e) {
      db.exec('ROLLBACK');
      trySetForeignKeys(true);
      return { ok: false, reason: 'error', error: e.message };
    }
    db.exec('COMMIT');
  } catch (e) {
    return { ok: false, reason: 'error', error: e.message };
  } finally {
    trySetForeignKeys(true);
  }
  return result;
}

// Monatliches automatisches Aufräumen: die neuesten `monthlyKeep` bleiben,
// alles Ältere wird entfernt. Läuft über getSetting-Flag nur einmal pro
// Zeitraum (aufrufender Scheduler setzt das Flag nach Erfolg).
function monthlyCleanup() {
  const keep = config.backup.monthlyKeep || 16;
  const rows = db.prepare(`
    SELECT id FROM backups ORDER BY id DESC LIMIT -1 OFFSET ?
  `).all(keep);
  let removed = 0;
  for (const r of rows) {
    db.prepare('DELETE FROM backups WHERE id = ?').run(r.id);
    removed++;
  }
  return removed;
}

function lastAutoBackupAt() {
  return getSetting('last_auto_backup_at') || null;
}

function lastMonthlyCleanupAt() {
  return getSetting('last_monthly_cleanup_at') || null;
}

// Wöchentliches Auto-Backup, falls fällig. Bei 20/20 wird NICHT automatisch
// gelöscht – das Backup wird dann übersprungen (nur jlg09 kann aufräumen).
function runWeeklyAutoBackupIfDue() {
  const last = lastAutoBackupAt();
  const interval = (config.backup.autoIntervalDays || 7) * 24 * 60 * 60 * 1000;
  if (last && Date.now() - new Date(last).getTime() < interval) return { ran: false };
  const res = createBackup('auto');
  setSetting('last_auto_backup_at', new Date().toISOString());
  if (!res.ok) {
    console.log('[BACKUP] Wöchentliches Backup übersprungen: Limit 20/20 erreicht.');
    return { ran: false, skipped: true };
  }
  console.log(`[BACKUP] Automatisches Backup erstellt (${res.size} Bytes, ${res.free} Slots frei).`);
  return { ran: true, ...res };
}

// Monatliches automatisches Aufräumen, falls fällig.
function runMonthlyCleanupIfDue() {
  const last = lastMonthlyCleanupAt();
  const interval = (config.backup.monthlyCleanupDays || 30) * 24 * 60 * 60 * 1000;
  if (last && Date.now() - new Date(last).getTime() < interval) return { ran: false };
  const removed = monthlyCleanup();
  setSetting('last_monthly_cleanup_at', new Date().toISOString());
  if (removed > 0) {
    console.log(`[BACKUP] Monatliches Aufräumen: ${removed} alte Backup(s) entfernt.`);
  }
  return { ran: true, removed };
}

module.exports = {
  maxSlots,
  listBackups,
  countBackups,
  slotsFree,
  createBackup,
  getBackup,
  deleteBackup,
  clearAllBackups,
  restoreBackup,
  monthlyCleanup,
  runWeeklyAutoBackupIfDue,
  runMonthlyCleanupIfDue,
};
