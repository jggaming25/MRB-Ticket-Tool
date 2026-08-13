'use strict';

// ---------------------------------------------------------------------------
// Voice-Support / Support-Hotline
// ---------------------------------------------------------------------------
// HR/Inhaber können sich für den Voice-Support ein- und ausstempeln
// (support_shifts). Eingeloggte Nutzer können die Hotline über die Website
// "anrufen" (support_calls): Der Anruf landet in der Warteschleife, wird
// automatisch einem verfügbaren Mitarbeiter zugewiesen und über WebRTC als
// Sprachanruf verbunden. Ist innerhalb der festen Wartezeit kein Mitarbeiter
// verfügbar, endet der Anruf mit einer professionellen Hinweis-Meldung.
// ---------------------------------------------------------------------------

const { db, getSetting, setSetting, logAccountAction } = require('./db');
const config = require('./config');
const push = require('./push');

function nowIso() {
  return new Date().toISOString();
}

function toPositiveInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return Math.round(n);
}

// Aktuelle Support-Einstellungen: gespeicherte Overrides (support_settings)
// überlagern die Standardwerte aus config.js – ohne Server-Neustart wirksam.
function getSettings() {
  const d = config.support;
  const raw = getSetting('support_settings');
  if (!raw) return d;
  try {
    const o = JSON.parse(raw);
    return {
      ...d,
      ...o,
      waitMaxMs: toPositiveInt(o.waitMaxMs, d.waitMaxMs, 10000, 600000),
      ringTimeoutMs: toPositiveInt(o.ringTimeoutMs, d.ringTimeoutMs, 5000, 120000),
      pollMs: toPositiveInt(o.pollMs, d.pollMs, 1000, 60000),
      hotlinePrefix: String(o.hotlinePrefix || d.hotlinePrefix).trim(),
      noStaffMessage: String(o.noStaffMessage || d.noStaffMessage),
      queueEstimateLabel: String(o.queueEstimateLabel || d.queueEstimateLabel),
      stunServers: Array.isArray(o.stunServers) && o.stunServers.length
        ? o.stunServers.map((s) => String(s).trim()).filter(Boolean)
        : d.stunServers,
    };
  } catch {
    return d;
  }
}

// "Support-Nummer" – wird einmalig aus den vorhandenen Datenwerten abgeleitet
// (Tickets, aktive Nutzer, offene Tickets, aktive Bearbeiter) und gespeichert.
function hotlineNumber() {
  const cached = getSetting('support_hotline');
  if (cached) return cached;
  const settings = getSettings();
  const count = (sql) => { try { return db.prepare(sql).get().c; } catch { return 0; } };
  const totalTickets = count('SELECT COUNT(*) AS c FROM tickets');
  const activeUsers = count("SELECT COUNT(*) AS c FROM users WHERE status = 'active'");
  const openTickets = count("SELECT COUNT(*) AS c FROM tickets WHERE status IN ('open','pending','overdue')");
  const staff = count("SELECT COUNT(*) AS c FROM users WHERE role IN ('hr','hrhr') AND status = 'active'");
  const code = String(((totalTickets * 7 + activeUsers * 13 + openTickets * 29 + staff * 37) % 9000) + 1000);
  const number = `${settings.hotlinePrefix || '0800'} ${code.slice(0, 2)} ${code.slice(2)} ${String(staff).padStart(2, '0')}`;
  setSetting('support_hotline', number);
  return number;
}

// Einstellungen speichern (nur Inhaber). Liefert { ok, errors }.
function saveSettings(input) {
  const d = config.support;
  const errors = [];
  const number = (v) => String(v == null ? '' : v).trim();

  const waitMaxMs = toPositiveInt(input.waitMaxMs, d.waitMaxMs, 10000, 600000);
  if (input.waitMaxMs != null && String(input.waitMaxMs).trim() !== '' && Number(input.waitMaxMs) !== waitMaxMs) {
    errors.push('Wartezeit: zwischen 10 und 600 Sekunden.');
  }
  const ringTimeoutMs = toPositiveInt(input.ringTimeoutMs, d.ringTimeoutMs, 5000, 120000);
  if (input.ringTimeoutMs != null && String(input.ringTimeoutMs).trim() !== '' && Number(input.ringTimeoutMs) !== ringTimeoutMs) {
    errors.push('Klingel-Zeit: zwischen 5 und 120 Sekunden.');
  }
  const pollMs = toPositiveInt(input.pollMs, d.pollMs, 1000, 60000);
  if (input.pollMs != null && String(input.pollMs).trim() !== '' && Number(input.pollMs) !== pollMs) {
    errors.push('Aktualisierung: zwischen 1 und 60 Sekunden.');
  }

  const oldPrefix = getSettings().hotlinePrefix;
  const hotlinePrefix = number(input.hotlinePrefix) || d.hotlinePrefix;
  const noStaffMessage = number(input.noStaffMessage) || d.noStaffMessage;
  const queueEstimateLabel = number(input.queueEstimateLabel) || d.queueEstimateLabel;
  const stunInput = Array.isArray(input.stunServers)
    ? input.stunServers.map((s) => number(s)).filter(Boolean)
    : [];
  const stunServers = stunInput.length ? stunInput : d.stunServers;

  const payload = {
    waitMaxMs,
    ringTimeoutMs,
    pollMs,
    hotlinePrefix,
    noStaffMessage,
    queueEstimateLabel,
    stunServers,
  };
  setSetting('support_settings', JSON.stringify(payload));
  // Vorwahl geändert -> Hotline-Nummer neu ableiten.
  if (oldPrefix !== hotlinePrefix) {
    setSetting('support_hotline', '');
  }
  return { ok: errors.length === 0, errors, settings: getSettings() };
}

function callDisplayNumber(id) {
  return `#SUP-${String(id).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Ein-/Ausstempeln
// ---------------------------------------------------------------------------
function activeShiftOf(userId) {
  return db.prepare(`
    SELECT * FROM support_shifts WHERE user_id = ? AND clocked_out_at IS NULL ORDER BY id DESC LIMIT 1
  `).get(userId) || null;
}

function isClockedIn(userId) {
  return !!activeShiftOf(userId);
}

function clockIn(userId) {
  if (isClockedIn(userId)) {
    return { ok: true, already: true };
  }
  db.prepare(`
    INSERT INTO support_shifts (user_id, clocked_in_at) VALUES (?, ?)
  `).run(userId, nowIso());
  logAccountAction(userId, userId, 'support_clockin', 'Für den Voice-Support eingestempelt');
  const assigned = assignWaitingCalls();
  return { ok: true, assigned };
}

function clockOut(userId) {
  const shift = activeShiftOf(userId);
  if (!shift) return { ok: true, already: true };
  db.prepare('UPDATE support_shifts SET clocked_out_at = ? WHERE id = ?').run(nowIso(), shift.id);
  logAccountAction(userId, userId, 'support_clockout', 'Aus dem Voice-Support ausgestempelt');
  // Ggf. gerade ein laufender Anruf -> beenden, dann andere Wartende zuweisen.
  const handled = currentHandledCall(userId);
  if (handled && handled.status !== 'ended') {
    endCallInternal(handled.id, 'ended', 'Mitarbeiter aus dem Voice-Support ausgestempelt');
  }
  assignWaitingCalls();
  return { ok: true };
}

function shiftHistory(userId, limit = 5) {
  return db.prepare(`
    SELECT id, clocked_in_at, clocked_out_at FROM support_shifts
    WHERE user_id = ? ORDER BY id DESC LIMIT ?
  `).all(userId, limit);
}

// ---------------------------------------------------------------------------
// Warteschlange / Zuweisung
// ---------------------------------------------------------------------------
function getCall(id) {
  return db.prepare('SELECT * FROM support_calls WHERE id = ?').get(id) || null;
}

function activeCallOf(userId) {
  return db.prepare(`
    SELECT * FROM support_calls
    WHERE caller_id = ? AND status IN ('waiting','ringing','active')
    ORDER BY id DESC LIMIT 1
  `).get(userId) || null;
}

function currentHandledCall(staffId) {
  return db.prepare(`
    SELECT * FROM support_calls
    WHERE staff_id = ? AND status IN ('ringing','active')
    ORDER BY id DESC LIMIT 1
  `).get(staffId) || null;
}

function availableStaffIds() {
  return db.prepare(`
    SELECT s.user_id AS id
    FROM support_shifts s
    JOIN users u ON u.id = s.user_id
    WHERE s.clocked_out_at IS NULL AND u.status = 'active' AND u.role IN ('hr','hrhr')
      AND NOT EXISTS (
        SELECT 1 FROM support_calls c
        WHERE c.staff_id = s.user_id AND c.status IN ('ringing','active')
      )
    ORDER BY s.clocked_in_at ASC
  `).all().map((r) => r.id);
}

function availableStaffCount() {
  return db.prepare(`
    SELECT COUNT(*) AS c
    FROM support_shifts s
    JOIN users u ON u.id = s.user_id
    WHERE s.clocked_out_at IS NULL AND u.status = 'active' AND u.role IN ('hr','hrhr')
      AND NOT EXISTS (
        SELECT 1 FROM support_calls c
        WHERE c.staff_id = s.user_id AND c.status IN ('ringing','active')
      )
  `).get().c;
}

function waitingQueue() {
  return db.prepare(`
    SELECT c.id, c.caller_id, c.joined_at,
           u.username, u.global_name
    FROM support_calls c
    LEFT JOIN users u ON u.id = c.caller_id
    WHERE c.status = 'waiting'
    ORDER BY c.id ASC
  `).all();
}

function queuePositionOf(callId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM support_calls
    WHERE status = 'waiting' AND id < ?
  `).get(callId);
  return (row ? row.c : 0) + 1;
}

function notifyStaffPush(staffId, call) {
  try {
    if (!push.isConfigured() || !staffId) return;
    const caller = db.prepare('SELECT username, global_name FROM users WHERE id = ?').get(call.caller_id);
    const name = caller ? (caller.global_name || caller.username) : 'ein Nutzer';
    push.sendToUser(staffId, {
      title: '📞 Neuer Support-Anruf',
      body: `${callDisplayNumber(call.id)} von ${name} – jetzt auf der Website annehmen.`,
      url: '/support/staff',
      actions: [
        { action: 'open', title: 'To Website' },
        { action: 'accept', title: 'Anruf annehmen' },
      ],
    });
  } catch (e) {
    console.error('Support-Push fehlgeschlagen:', e.message);
  }
}

// Weist wartende Anrufe an verfügbare Mitarbeiter zu (FIFO). Liefert Anzahl
// der neu zugewiesenen Anrufe.
function assignWaitingCalls() {
  let assigned = 0;
  for (;;) {
    const waiting = db.prepare(`
      SELECT * FROM support_calls WHERE status = 'waiting' ORDER BY id ASC LIMIT 1
    `).get();
    if (!waiting) break;
    const free = availableStaffIds();
    if (!free.length) break;
    const staffId = free[0];
    db.prepare(`
      UPDATE support_calls SET staff_id = ?, status = 'ringing', assigned_at = ? WHERE id = ?
    `).run(staffId, nowIso(), waiting.id);
    notifyStaffPush(staffId, getCall(waiting.id));
    assigned++;
  }
  return assigned;
}

// ---------------------------------------------------------------------------
// Anruf-Lebenszyklus
// ---------------------------------------------------------------------------
function startCall(userId) {
  const existing = activeCallOf(userId);
  if (existing) return { ok: true, call: getCall(existing.id) };
  const info = db.prepare(`
    INSERT INTO support_calls (caller_id, status, joined_at) VALUES (?, 'waiting', ?)
  `).run(userId, nowIso());
  const call = getCall(info.lastInsertRowid);
  // Sofort einem verfügbaren Mitarbeiter zuweisen, falls einer eingestempelt ist.
  assignWaitingCalls();
  return { ok: true, call: getCall(call.id) };
}

function acceptCall(staffId, callId) {
  const call = getCall(callId);
  if (!call) return { ok: false, reason: 'notfound' };
  if (call.status === 'ended' || call.status === 'timeout') {
    return { ok: false, reason: 'ended' };
  }
  if (!isClockedIn(staffId)) {
    return { ok: false, reason: 'notclocked' };
  }
  const busy = currentHandledCall(staffId);
  if (busy) return { ok: false, reason: 'busy' };
  // Nur der zugewiesene Mitarbeiter oder jeder eingestempelte bei "waiting".
  if (call.status === 'ringing' && call.staff_id !== staffId) {
    return { ok: false, reason: 'notassigned' };
  }
  db.prepare(`
    UPDATE support_calls SET staff_id = ?, status = 'ringing', assigned_at = ? WHERE id = ?
  `).run(staffId, call.status === 'ringing' ? call.assigned_at : nowIso(), call.id);
  return { ok: true, call: getCall(call.id) };
}

function endCallInternal(callId, status, reason) {
  db.prepare(`
    UPDATE support_calls SET status = ?, ended_at = ?, ended_reason = ? WHERE id = ?
  `).run(status, nowIso(), reason || null, callId);
}

function endCall(userId, callId) {
  const call = getCall(callId);
  if (!call) return { ok: false, reason: 'notfound' };
  const isCaller = call.caller_id === userId;
  const isStaff = call.staff_id === userId;
  if (!isCaller && !isStaff) return { ok: false, reason: 'forbidden' };
  endCallInternal(call.id, 'ended', isCaller ? 'Anruf durch den Anrufer beendet' : 'Anruf durch den Mitarbeiter beendet');
  assignWaitingCalls();
  return { ok: true };
}

// WebRTC-Signal (SDP) speichern. "offer" nur vom Anrufer, "answer" nur vom
// zugewiesenen Mitarbeiter.
function setSignal(userId, callId, role, sdp) {
  const call = getCall(callId);
  if (!call) return { ok: false, reason: 'notfound' };
  const isCaller = call.caller_id === userId;
  const isStaff = call.staff_id === userId;
  if (role === 'offer' && !isCaller) return { ok: false, reason: 'forbidden' };
  if (role === 'answer' && !isStaff) return { ok: false, reason: 'forbidden' };
  if (!sdp || typeof sdp !== 'string' || sdp.length > 65535) {
    return { ok: false, reason: 'invalid' };
  }
  if (role === 'offer') {
    db.prepare('UPDATE support_calls SET offer_caller = ? WHERE id = ?').run(sdp, call.id);
  } else {
    db.prepare('UPDATE support_calls SET answer_staff = ?, started_at = COALESCE(started_at, ?), status = CASE WHEN status = \'ringing\' THEN \'active\' ELSE status END WHERE id = ?')
      .run(sdp, nowIso(), call.id);
  }
  return { ok: true };
}

// Zustand eines Anrufs für einen berechtigten Nutzer (Anrufer oder Mitarbeiter).
function callStateFor(userId, callId) {
  const call = getCall(callId);
  if (!call) return { ok: false, reason: 'notfound' };
  const isCaller = call.caller_id === userId;
  const isStaff = call.staff_id === userId;
  if (!isCaller && !isStaff) return { ok: false, reason: 'forbidden' };

  const caller = db.prepare('SELECT id, username, global_name FROM users WHERE id = ?').get(call.caller_id);
  const staff = call.staff_id
    ? db.prepare('SELECT id, username, global_name FROM users WHERE id = ?').get(call.staff_id)
    : null;

  return {
    ok: true,
    call: {
      id: call.id,
      display: callDisplayNumber(call.id),
      status: call.status,
      callerName: caller ? (caller.global_name || caller.username) : 'Unbekannt',
      staffName: staff ? (staff.global_name || staff.username) : null,
      joinedAt: call.joined_at,
      assignedAt: call.assigned_at,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      endedReason: call.ended_reason,
      queuePosition: call.status === 'waiting' ? queuePositionOf(call.id) : null,
      offer: isStaff ? call.offer_caller : null,
      answer: isCaller ? call.answer_staff : null,
      role: isCaller ? 'caller' : 'staff',
    },
  };
}

// ---------------------------------------------------------------------------
// Zustand für die Seiten
// ---------------------------------------------------------------------------
function publicState(user) {
  const settings = getSettings();
  const call = activeCallOf(user.id);
  return {
    hotline: hotlineNumber(),
    available: availableStaffCount(),
    waitMaxMs: settings.waitMaxMs,
    ringTimeoutMs: settings.ringTimeoutMs,
    pollMs: settings.pollMs,
    queueEstimateLabel: settings.queueEstimateLabel,
    noStaffMessage: settings.noStaffMessage,
    call: call ? call.id : null,
  };
}

function staffState(user) {
  const settings = getSettings();
  const shift = activeShiftOf(user.id);
  const handled = currentHandledCall(user.id);
  const queue = waitingQueue().map((c) => ({
    id: c.id,
    display: callDisplayNumber(c.id),
    callerName: c.global_name || c.username,
    joinedAt: c.joined_at,
    position: queuePositionOf(c.id),
  }));
  return {
    hotline: hotlineNumber(),
    available: availableStaffCount(),
    clockedIn: !!shift,
    shiftSince: shift ? shift.clocked_in_at : null,
    myCall: handled ? { id: handled.id, display: callDisplayNumber(handled.id), status: handled.status, callerName: null } : null,
    queue,
    history: shiftHistory(user.id),
    waitMaxMs: settings.waitMaxMs,
    ringTimeoutMs: settings.ringTimeoutMs,
    pollMs: settings.pollMs,
    noStaffMessage: settings.noStaffMessage,
  };
}

// ---------------------------------------------------------------------------
// Scheduler: feste Wartezeiten durchsetzen (läuft zyklisch im Server).
// ---------------------------------------------------------------------------
function runScheduler() {
  const settings = getSettings();
  const now = Date.now();

  // Wartend ohne Mitarbeiter nach Ablauf der festen Wartezeit -> beenden.
  const timeouts = db.prepare(`
    SELECT * FROM support_calls WHERE status = 'waiting'
  `).all();
  for (const call of timeouts) {
    const joined = new Date(call.joined_at).getTime();
    if (!Number.isNaN(joined) && now - joined >= settings.waitMaxMs) {
      endCallInternal(call.id, 'timeout', settings.noStaffMessage);
      // Anrufer per Push informieren, dass gerade kein Mitarbeiter verfügbar ist.
      try {
        if (push.isConfigured()) {
          push.sendToUser(call.caller_id, {
            title: '📵 Kein Mitarbeiter verfügbar',
            body: settings.noStaffMessage,
            url: '/support',
          });
        }
      } catch (e) { /* ignore */ }
    }
  }

  // Zugeteilter Mitarbeiter nimmt nicht rechtzeitig an -> wieder in die Warteschlange.
  const ringing = db.prepare(`
    SELECT * FROM support_calls WHERE status = 'ringing'
  `).all();
  for (const call of ringing) {
    const assigned = new Date(call.assigned_at).getTime();
    if (!Number.isNaN(assigned) && now - assigned >= settings.ringTimeoutMs) {
      db.prepare(`
        UPDATE support_calls SET staff_id = NULL, status = 'waiting', assigned_at = NULL WHERE id = ?
      `).run(call.id);
    }
  }

  assignWaitingCalls();
}

module.exports = {
  getSettings,
  saveSettings,
  hotlineNumber,
  callDisplayNumber,
  isClockedIn,
  clockIn,
  clockOut,
  shiftHistory,
  startCall,
  acceptCall,
  endCall,
  setSignal,
  callStateFor,
  publicState,
  staffState,
  activeCallOf,
  currentHandledCall,
  waitingQueue,
  availableStaffCount,
  runScheduler,
};
