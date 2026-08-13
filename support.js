'use strict';

// ---------------------------------------------------------------------------
// Voice-Support / Support-Hotline
// ---------------------------------------------------------------------------
// HR/Inhaber können sich für den Voice-Support ein- und ausstempeln
// (support_shifts). Eingeloggte Nutzer können die Hotline über die Website
// "anrufen" (support_calls): Der Anruf landet in der Warteschleife, wird
// automatisch einem verfügbaren Mitarbeiter zugewiesen und über WebRTC als
// Sprachanruf verbunden. Die Warteschleife läuft ohne festes Zeitlimit – der
// Anrufer bleibt so lange in der Musik, bis ein Mitarbeiter frei wird oder er
// selbst auflegt.
// ---------------------------------------------------------------------------

const { db, getSetting, setSetting, logAccountAction } = require('./db');
const config = require('./config');
const push = require('./push');
const whatsapp = require('./whatsapp');

function nowIso() {
  return new Date().toISOString();
}

function berlinTime(date) {
  try {
    return new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  } catch {
    return date;
  }
}

// Wochentag-Name (1=Mo … 7=So) fuer die Zeiten-Anzeige.
const WEEKDAY_LABELS = {
  1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 7: 'So',
};

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
      ringTimeoutMs: toPositiveInt(o.ringTimeoutMs, d.ringTimeoutMs, 5000, 120000),
      pollMs: toPositiveInt(o.pollMs, d.pollMs, 1000, 60000),
      hotlinePrefix: String(o.hotlinePrefix || d.hotlinePrefix).trim(),
      noStaffMessage: String(o.noStaffMessage || d.noStaffMessage),
      queueEstimateLabel: String(o.queueEstimateLabel || d.queueEstimateLabel),
      minutesPerCall: toPositiveInt(o.minutesPerCall, d.minutesPerCall, 1, 30),
      queueAlertThreshold: toPositiveInt(o.queueAlertThreshold, d.queueAlertThreshold, 1, 50),
      supportHours: normalizeSupportHours(o.supportHours, d.supportHours),
      stunServers: Array.isArray(o.stunServers) && o.stunServers.length
        ? o.stunServers.map((s) => String(s).trim()).filter(Boolean)
        : d.stunServers,
    };
  } catch {
    return d;
  }
}

// Support-Zeiten normalisieren: { enabled, days:[1-7], start:'HH:MM', end:'HH:MM' }
function normalizeSupportHours(input, fallback) {
  const f = fallback || config.support.supportHours || {};
  if (!input || typeof input !== 'object') return { ...f };
  const days = Array.isArray(input.days)
    ? input.days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    : (Array.isArray(f.days) ? f.days : []);
  const timeOk = (t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t);
  return {
    enabled: !!input.enabled,
    days: days.length ? days : (Array.isArray(f.days) ? f.days : []),
    start: timeOk(input.start) ? input.start : (timeOk(f.start) ? f.start : '09:00'),
    end: timeOk(input.end) ? input.end : (timeOk(f.end) ? f.end : '18:00'),
  };
}

// Ist der Support gerade (in Europe/Berlin) erreichbar?
function isSupportOpen(now) {
  const h = getSettings().supportHours;
  if (!h || !h.enabled || !h.days || !h.days.length) return { open: true };
  const t = berlinTime(now || new Date());
  const day = t.getDay() === 0 ? 7 : t.getDay(); // 1=Mo … 7=So
  if (!h.days.includes(day)) return { open: false, closedLabel: 'Heute geschlossen' };
  const [sh, sm] = h.start.split(':').map(Number);
  const [eh, em] = h.end.split(':').map(Number);
  const nowMin = t.getHours() * 60 + t.getMinutes();
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  return { open: nowMin >= startMin && nowMin < endMin };
}

// Text der Support-Zeiten, z. B. "Mo–Fr 09:00–18:00" oder "Immer erreichbar".
function supportHoursLabel() {
  const h = getSettings().supportHours;
  if (!h || !h.enabled || !h.days || !h.days.length) return 'Jederzeit erreichbar';
  const order = [1, 2, 3, 4, 5, 6, 7].filter((d) => h.days.includes(d));
  const dayStr = order.map((d) => WEEKDAY_LABELS[d]).join(' ');
  return `${dayStr} ${h.start}–${h.end} Uhr`;
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

  const minutesPerCall = toPositiveInt(input.minutesPerCall, d.minutesPerCall, 1, 30);
  if (input.minutesPerCall != null && String(input.minutesPerCall).trim() !== '' && Number(input.minutesPerCall) !== minutesPerCall) {
    errors.push('Wartezeit-Faktor: zwischen 1 und 30 Minuten.');
  }
  const queueAlertThreshold = toPositiveInt(input.queueAlertThreshold, d.queueAlertThreshold, 1, 50);
  if (input.queueAlertThreshold != null && String(input.queueAlertThreshold).trim() !== '' && Number(input.queueAlertThreshold) !== queueAlertThreshold) {
    errors.push('Warteschlangen-Alarm: zwischen 1 und 50 Anrufern.');
  }
  const supportHours = normalizeSupportHours({
    enabled: input.supportHoursEnabled === true || input.supportHoursEnabled === '1' || input.supportHoursEnabled === 'on',
    days: Array.isArray(input.supportHoursDays)
      ? input.supportHoursDays.map(Number)
      : [],
    start: number(input.supportHoursStart),
    end: number(input.supportHoursEnd),
  }, d.supportHours);

  const payload = {
    ringTimeoutMs,
    pollMs,
    hotlinePrefix,
    noStaffMessage,
    queueEstimateLabel,
    stunServers,
    minutesPerCall,
    queueAlertThreshold,
    supportHours,
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
// Mitarbeiter-Durchwahl: Jeder Mitarbeiter bekommt automatisch eine eindeutige
// Nummer (1, 2, 3, …). Frei werdende Nummern werden wiederverwendet.
// ---------------------------------------------------------------------------
function nextExtension() {
  const used = new Set(db.prepare(
    "SELECT extension FROM users WHERE extension IS NOT NULL AND role IN ('hr','hrhr')"
  ).all().map((r) => r.extension));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function getOrAssignExtension(userId) {
  const u = db.prepare('SELECT id, extension FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  if (u.extension) return u.extension;
  const ext = nextExtension();
  db.prepare('UPDATE users SET extension = ? WHERE id = ?').run(ext, u.id);
  return ext;
}

function extensionOf(userId) {
  if (!userId) return null;
  const u = db.prepare('SELECT extension FROM users WHERE id = ?').get(userId);
  return u && u.extension ? u.extension : null;
}

function extensionLabel(userId) {
  const ext = extensionOf(userId);
  return ext != null ? `#${ext}` : '';
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
  const extension = getOrAssignExtension(userId);
  db.prepare(`
    INSERT INTO support_shifts (user_id, clocked_in_at) VALUES (?, ?)
  `).run(userId, nowIso());
  logAccountAction(userId, userId, 'support_clockin',
    `Für den Voice-Support eingestempelt (Durchwahl #${extension})`);
  return { ok: true, extension };
}

function clockOut(userId) {
  const shift = activeShiftOf(userId);
  if (!shift) return { ok: true, already: true };
  db.prepare('UPDATE support_shifts SET clocked_out_at = ? WHERE id = ?').run(nowIso(), shift.id);
  logAccountAction(userId, userId, 'support_clockout', 'Aus dem Voice-Support ausgestempelt');
  // Ggf. gerade ein laufender Anruf -> beenden.
  const handled = currentHandledCall(userId);
  if (handled && handled.status !== 'ended') {
    const user = db.prepare('SELECT global_name, username FROM users WHERE id = ?').get(userId);
    const who = user ? (user.global_name || user.username) : 'Ein Mitarbeiter';
    whatsappNotify(`${who} hat sich ausgestempelt, während ${callDisplayNumber(handled.id)} lief – Anruf beendet.`);
    endCallInternal(handled.id, 'ended', 'Mitarbeiter aus dem Voice-Support ausgestempelt');
  }
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

// Push-Benachrichtigung an alle freien, eingestempelten Mitarbeiter, dass ein
// neuer Anrufer in der Warteschlange ist (Annahme muss der Mitarbeiter klicken).
function notifyStaffNewCaller(call) {
  try {
    if (!push.isConfigured()) return;
    const caller = db.prepare('SELECT username, global_name FROM users WHERE id = ?').get(call.caller_id);
    const name = caller ? (caller.global_name || caller.username) : 'ein Nutzer';
    const staffIds = availableStaffIds();
    for (const staffId of staffIds) {
      push.sendToUser(staffId, {
        title: '📞 Neuer Support-Anrufer',
        body: `${callDisplayNumber(call.id)} von ${name} wartet – bitte annehmen.`,
        url: '/support/staff',
        actions: [
          { action: 'open', title: 'To Website' },
        ],
      });
    }
  } catch (e) {
    console.error('Support-Push fehlgeschlagen:', e.message);
  }
}

// Weist wartende Anrufe an freie Mitarbeiter zu (nur fuer Weiterleitung).
// excludeStaffId verhindert, dass der weiterleitende Mitarbeiter den Anrufer
// sofort wieder uebernimmt.
function assignWaitingCalls({ excludeStaffId } = {}) {
  let assigned = 0;
  for (;;) {
    const waiting = db.prepare(`
      SELECT * FROM support_calls WHERE status = 'waiting' ORDER BY id ASC LIMIT 1
    `).get();
    if (!waiting) break;
    const free = availableStaffIds().filter((id) => id !== excludeStaffId);
    if (!free.length) break;
    const staffId = free[0];
    db.prepare(`
      UPDATE support_calls SET staff_id = ?, status = 'ringing', assigned_at = ? WHERE id = ?
    `).run(staffId, nowIso(), waiting.id);
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
  // Keine automatische Zuweisung: Der Anrufer wartet, bis ein Mitarbeiter ihn
  // ueber die Warteschlange annimmt.
  notifyStaffNewCaller(call);
  return { ok: true, call: getCall(call.id) };
}

// Mitarbeiter nimmt einen wartenden Anruf an (Button in der Warteschlange).
function acceptCall(staffId, callId) {
  const call = getCall(callId);
  if (!call) return { ok: false, reason: 'notfound' };
  if (call.status !== 'waiting') return { ok: false, reason: 'invalid' };
  if (!isClockedIn(staffId)) return { ok: false, reason: 'notclocked' };
  if (currentHandledCall(staffId)) return { ok: false, reason: 'busy' };
  getOrAssignExtension(staffId);
  db.prepare(`
    UPDATE support_calls SET staff_id = ?, status = 'ringing', assigned_at = ? WHERE id = ?
  `).run(staffId, nowIso(), call.id);
  return { ok: true, call: getCall(call.id) };
}

// Aktiven Anruf an den naechsten freien Mitarbeiter weiterleiten. Der Anrufer
// bleibt vorn in der Warteschlange und wird direkt neu zugewiesen; wenn kein
// anderer frei ist, wartet er dort auf die naechste Annahme.
function transferCall(staffId, callId) {
  const call = getCall(callId);
  if (!call) return { ok: false, reason: 'notfound' };
  if (call.staff_id !== staffId) return { ok: false, reason: 'forbidden' };
  if (!['ringing', 'active'].includes(call.status)) return { ok: false, reason: 'invalid' };
  const staff = db.prepare('SELECT global_name, username FROM users WHERE id = ?').get(staffId);
  const who = staff ? (staff.global_name || staff.username) : 'Ein Mitarbeiter';
  db.prepare(`
    UPDATE support_calls
    SET staff_id = NULL, status = 'waiting', assigned_at = NULL, started_at = NULL,
        offer_staff = NULL, answer_caller = NULL
    WHERE id = ?
  `).run(call.id);
  whatsappNotify(`${who} hat ${callDisplayNumber(call.id)} weitergeleitet – Anrufer bleibt vorn in der Warteschlange.`);
  const assigned = assignWaitingCalls({ excludeStaffId: staffId });
  return { ok: true, reassigned: assigned > 0 };
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
  return { ok: true };
}

// WebRTC-Signal (SDP) speichern. Seit der manuellen Annahme erstellt der
// MITARBEITER das Angebot (offer -> offer_staff) und der ANRUFER antwortet
// (answer -> answer_caller). Die Antwort verbindet den Anruf (status -> active).
function setSignal(userId, callId, role, sdp) {
  const call = getCall(callId);
  if (!call) return { ok: false, reason: 'notfound' };
  const isCaller = call.caller_id === userId;
  const isStaff = call.staff_id === userId;
  if (role === 'offer' && !isStaff) return { ok: false, reason: 'forbidden' };
  if (role === 'answer' && !isCaller) return { ok: false, reason: 'forbidden' };
  if (!sdp || typeof sdp !== 'string' || sdp.length > 65535) {
    return { ok: false, reason: 'invalid' };
  }
  if (role === 'offer') {
    db.prepare('UPDATE support_calls SET offer_staff = ?, answer_caller = NULL WHERE id = ?').run(sdp, call.id);
  } else {
    db.prepare(`
      UPDATE support_calls
      SET answer_caller = ?, started_at = COALESCE(started_at, ?),
          status = CASE WHEN status = 'ringing' THEN 'active' ELSE status END
      WHERE id = ?
    `).run(sdp, nowIso(), call.id);
    if (call.status === 'ringing') {
      const staff = db.prepare('SELECT global_name, username FROM users WHERE id = ?').get(call.staff_id);
      const who = staff ? (staff.global_name || staff.username) : 'ein Mitarbeiter';
      whatsappNotify(`📞 ${callDisplayNumber(call.id)} verbunden (${who})`);
    }
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
    ? db.prepare('SELECT id, username, global_name, extension FROM users WHERE id = ?').get(call.staff_id)
    : null;

  return {
    ok: true,
    call: {
      id: call.id,
      display: callDisplayNumber(call.id),
      status: call.status,
      callerName: caller ? (caller.global_name || caller.username) : 'Unbekannt',
      staffName: staff ? (staff.global_name || staff.username) : null,
      staffExtension: staff && staff.extension != null ? `#${staff.extension}` : null,
      joinedAt: call.joined_at,
      assignedAt: call.assigned_at,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      endedReason: call.ended_reason,
      queuePosition: call.status === 'waiting' ? queuePositionOf(call.id) : null,
      queueWaitMinutes: call.status === 'waiting'
        ? queuePositionOf(call.id) * getSettings().minutesPerCall
        : null,
      availableStaff: availableStaffCount(),
      offer: isCaller ? call.offer_staff : null,
      answer: isStaff ? call.answer_caller : null,
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
  const openNow = isSupportOpen();
  return {
    hotline: hotlineNumber(),
    available: availableStaffCount(),
    ringTimeoutMs: settings.ringTimeoutMs,
    pollMs: settings.pollMs,
    queueEstimateLabel: settings.queueEstimateLabel,
    noStaffMessage: settings.noStaffMessage,
    minutesPerCall: settings.minutesPerCall,
    supportHoursLabel: supportHoursLabel(),
    supportOpen: openNow.open,
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
  // Alle eingestempelten Mitarbeiter inkl. deren Status (frei/im Gespraech).
  const busy = db.prepare(`
    SELECT c.staff_id, c.status, u.global_name, u.username, u.extension
    FROM support_calls c
    JOIN users u ON u.id = c.staff_id
    WHERE c.status IN ('ringing','active')
  `).all();
  const busyStaff = busy.map((b) => ({
    id: b.staff_id,
    name: b.global_name || b.username,
    extension: b.extension != null ? `#${b.extension}` : null,
    status: b.status,
  }));
  return {
    hotline: hotlineNumber(),
    available: availableStaffCount(),
    clockedIn: !!shift,
    extension: getOrAssignExtension(user.id),
    shiftSince: shift ? shift.clocked_in_at : null,
    myCall: handled ? {
      id: handled.id,
      display: callDisplayNumber(handled.id),
      status: handled.status,
      callerName: null,
    } : null,
    queue,
    busyStaff,
    history: shiftHistory(user.id),
    ringTimeoutMs: settings.ringTimeoutMs,
    pollMs: settings.pollMs,
    noStaffMessage: settings.noStaffMessage,
    minutesPerCall: settings.minutesPerCall,
    supportHoursLabel: supportHoursLabel(),
  };
}

// ---------------------------------------------------------------------------
// Scheduler (läuft zyklisch im Server).
// Es gibt KEINE feste Wartezeit mehr: Anrufer bleiben in der Warteschleife,
// bis ein Mitarbeiter frei wird oder sie selbst auflegen. Ein zugewiesener
// Mitarbeiter, der nicht rechtzeitig annimmt (Klingelzeit), gibt den Anruf
// zurück in die Warteschlange, damit ihn der nächste freie Mitarbeiter
// übernehmen kann.
// ---------------------------------------------------------------------------
function runScheduler() {
  const settings = getSettings();
  const now = Date.now();

  // Alte Aufzeichnungen (älter als 4 Monate) einmal pro Tag löschen.
  if (!runScheduler.lastRecordingCleanup || now - runScheduler.lastRecordingCleanup >= 24 * 3600 * 1000) {
    try { cleanupOldRecordings(4); } catch (e) { console.error('Aufzeichnungs-Cleanup fehlgeschlagen:', e.message); }
    runScheduler.lastRecordingCleanup = now;
  }

  // Zugeteilter Mitarbeiter nimmt nicht rechtzeitig an -> zurück in die Warteschlange.
  const ringing = db.prepare(`
    SELECT * FROM support_calls WHERE status = 'ringing'
  `).all();
  for (const call of ringing) {
    const assigned = new Date(call.assigned_at).getTime();
    if (!Number.isNaN(assigned) && now - assigned >= settings.ringTimeoutMs) {
      db.prepare(`
        UPDATE support_calls
        SET staff_id = NULL, status = 'waiting', assigned_at = NULL,
            offer_staff = NULL, answer_caller = NULL
        WHERE id = ?
      `).run(call.id);
    }
  }

  // WhatsApp-Hinweise zu wichtigen Situationen (gedeckelt, damit das
  // CallMeBot-Limit von ~16 Nachrichten/240 min nicht gesprengt wird).
  const waitingCount = db.prepare("SELECT COUNT(*) AS c FROM support_calls WHERE status = 'waiting'").get().c;
  const clockedIn = db.prepare(`
    SELECT COUNT(*) AS c FROM support_shifts
    WHERE clocked_out_at IS NULL
  `).get().c;
  if (waitingCount > 0 && clockedIn === 0) {
    debouncedWhatsApp('no-staff-waiting', 20 * 60 * 1000,
      `🚨 Wartende Anrufer, aber KEIN Mitarbeiter eingestempelt (${waitingCount} in der Warteschlange).`);
  } else if (waitingCount >= settings.queueAlertThreshold && settings.queueAlertThreshold > 0) {
    debouncedWhatsApp(`queue-${settings.queueAlertThreshold}`, 20 * 60 * 1000,
      `⚠️ Warteschlange: ${waitingCount} Anrufer warten (${availableStaffCount()} frei).`);
  }
}

// WhatsApp-Nachricht senden (fire-and-forget), mit Zeitdeckelung pro Key.
function whatsappNotify(text) {
  try {
    if (whatsapp.isConfigured()) whatsapp.sendMessage(String(text).slice(0, 500));
  } catch (e) {
    console.error('WhatsApp-Benachrichtigung fehlgeschlagen:', e.message);
  }
}

function debouncedWhatsApp(key, minIntervalMs, text) {
  const now = Date.now();
  if (debouncedWhatsApp.last && debouncedWhatsApp.last[key] && now - debouncedWhatsApp.last[key] < minIntervalMs) return;
  if (!debouncedWhatsApp.last) debouncedWhatsApp.last = {};
  debouncedWhatsApp.last[key] = now;
  whatsappNotify(text);
}

// ---------------------------------------------------------------------------
// Warteschleifenmusik (dauerhaft in der DB gespeichert).
// Der Inhaber kann mehrere Songs hochladen; der Client spielt sie in der
// Warteschleife in zufälliger Reihenfolge durch (Endlosschleife). Ist keine
// Datei vorhanden, greift der Client auf die mitgelieferte Standard-Musik
// (public/audio/hold-music.wav) zurück.
// ---------------------------------------------------------------------------
function listHoldMusic() {
  return db.prepare(`
    SELECT id, name, mime, size, added_by, added_at FROM hold_music ORDER BY id ASC
  `).all();
}

function getHoldMusic(id) {
  return db.prepare('SELECT * FROM hold_music WHERE id = ?').get(Number(id)) || null;
}

function addHoldMusic({ name, mime, size, data, userId }) {
  const info = db.prepare(`
    INSERT INTO hold_music (name, mime, size, data, added_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(name || 'Song'), String(mime || 'audio/mpeg'), Number(size) || 0, data, userId || null);
  return info.lastInsertRowid;
}

function deleteHoldMusic(id) {
  db.prepare('DELETE FROM hold_music WHERE id = ?').run(Number(id));
}

// ---------------------------------------------------------------------------
// Aufzeichnungen (Voice-Support).
// Gespräche werden clientseitig vom zugewiesenen Mitarbeiter aufgezeichnet
// und hier dauerhaft (in der DB) gespeichert. Alte Aufzeichnungen werden nach
// 4 Monaten automatisch gelöscht (cleanupOldRecordings, läuft im Scheduler).
// ---------------------------------------------------------------------------
function addCallRecording({ callId, staffId, mime, size, data }) {
  const call = getCall(callId);
  if (!call) return { ok: false, reason: 'notfound' };
  if (call.staff_id !== staffId) return { ok: false, reason: 'forbidden' };
  const info = db.prepare(`
    INSERT INTO call_recordings (call_id, staff_id, mime, size, data)
    VALUES (?, ?, ?, ?, ?)
  `).run(call.id, staffId, String(mime || 'audio/webm'), Number(size) || 0, data);
  return { ok: true, id: info.lastInsertRowid };
}

function listRecordings() {
  return db.prepare(`
    SELECT r.id, r.call_id, r.staff_id, r.mime, r.size, r.created_at,
           cu.username AS caller_username, cu.global_name AS caller_global,
           su.username AS staff_username, su.global_name AS staff_global
    FROM call_recordings r
    LEFT JOIN support_calls c ON c.id = r.call_id
    LEFT JOIN users cu ON cu.id = c.caller_id
    LEFT JOIN users su ON su.id = r.staff_id
    ORDER BY r.id DESC
  `).all();
}

function getCallRecording(id) {
  return db.prepare('SELECT * FROM call_recordings WHERE id = ?').get(Number(id)) || null;
}

function deleteCallRecording(id) {
  db.prepare('DELETE FROM call_recordings WHERE id = ?').run(Number(id));
}

// Löscht alle Aufzeichnungen, die älter als `months` sind (Standard: 4).
function cleanupOldRecordings(months) {
  const m = months == null ? 4 : Number(months);
  const cutoff = new Date(Date.now() - m * 30 * 24 * 3600 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const info = db.prepare('DELETE FROM call_recordings WHERE created_at < ?').run(cutoff);
  if (info.changes > 0) {
    console.log(`Aufzeichnungen bereinigt: ${info.changes} alte(r) Eintrag/Einträge gelöscht (älter als ${m} Monate).`);
  }
  return info.changes;
}

module.exports = {
  getSettings,
  saveSettings,
  hotlineNumber,
  callDisplayNumber,
  isSupportOpen,
  supportHoursLabel,
  getOrAssignExtension,
  extensionOf,
  isClockedIn,
  clockIn,
  clockOut,
  shiftHistory,
  startCall,
  acceptCall,
  transferCall,
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
  listHoldMusic,
  getHoldMusic,
  addHoldMusic,
  deleteHoldMusic,
  addCallRecording,
  listRecordings,
  getCallRecording,
  deleteCallRecording,
  cleanupOldRecordings,
};
