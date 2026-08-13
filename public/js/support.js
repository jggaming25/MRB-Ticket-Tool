'use strict';

// ---------------------------------------------------------------------------
// Voice-Support / Support-Hotline – Client-Logik
// ---------------------------------------------------------------------------
// Läuft auf /support (Anrufer) und /support/staff (Mitarbeiter-Konsole).
// Der Server-Zustand wird per Polling abgefragt; der eigentliche Sprachanruf
// läuft über WebRTC direkt zwischen den Browsern. Die Signalisierung (SDP)
// wird über die Datenbank ausgetauscht (kein Socket.io nötig).
// ---------------------------------------------------------------------------
(function () {
  const STAFF = window.SUPPORT_STAFF === true;
  const PUSH_KEY = window.SUPPORT_PUSH_KEY || '';
  const POLL_MS = Math.max(1000, Number(window.SUPPORT_POLL_MS) || 3000);
  const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  // ---- Kleine Helfer ------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }
  function text(id, t) { const el = $(id); if (el) el.textContent = t; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtTime(iso) {
    if (!iso) return '–';
    const d = new Date(iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return '–';
    return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')} min`;
  }
  async function getJson(url) {
    try { const r = await fetch(url, { cache: 'no-store' }); return await r.json(); }
    catch { return { ok: false }; }
  }
  async function post(url, body) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return await r.json();
    } catch { return { ok: false }; }
  }
  function urlB64ToUint8Array(b64) {
    const padding = '='.repeat((4 - (b64.length % 4)) % 4);
    const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
    return out;
  }

  // ---- Warteschleifenmusik & Signaltöne ------------------------------------
  // Spielt einen vom Inhaber hochgeladenen Song aus der Datenbank
  // (/api/support/hold-music). Bei mehreren Songs wird pro Anruf zufällig
  // einer gewählt. Ohne hochgeladene Songs fällt er auf die mitgelieferte
  // Standard-Warteschleifenmusik und schließlich einen sanften Synth-Loop zurück.
  function HoldMusic() {
    let audio = null;
    let playing = false;
    let synth = null;
    let songs = [];
    const DEFAULT_SRC = '/static/audio/hold-music.wav';

    async function loadSongs() {
      try {
        const r = await fetch('/api/support/hold-music', { cache: 'no-store' });
        const j = await r.json();
        if (j.ok && Array.isArray(j.songs)) songs = j.songs.filter((s) => s && s.id);
      } catch (e) { songs = []; }
    }

    function pickSrc() {
      if (songs.length) {
        const s = songs[Math.floor(Math.random() * songs.length)];
        return `/api/support/hold-music/${s.id}`;
      }
      return DEFAULT_SRC;
    }

    function startSynth() {
      if (synth) return;
      try {
        synth = (function () {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          gain.gain.value = 0.05;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          const notes = [523.25, 659.25, 783.99];
          let i = 0;
          const step = () => {
            if (!playing) return;
            osc.frequency.setValueAtTime(notes[i % notes.length], ctx.currentTime);
            i++;
            timer = setTimeout(step, 450);
          };
          let timer = setTimeout(step, 450);
          return { ctx, osc, gain, timer };
        })();
      } catch (e) { /* Audio nicht verfügbar */ }
    }

    function stopSynth() {
      if (synth) {
        try {
          clearTimeout(synth.timer);
          synth.osc.stop();
          synth.ctx.close();
        } catch (e) { /* ignore */ }
        synth = null;
      }
    }

    this.start = async function () {
      if (playing) return;
      playing = true;
      if (!songs.length) await loadSongs();
      const src = pickSrc();
      try {
        if (!audio) {
          audio = new Audio();
          audio.loop = true;
          audio.volume = 0.4;
        }
        audio.src = src;
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => startSynth()); // z. B. Autoplay-Sperre beim Wiederaufnehmen
        }
      } catch (e) {
        startSynth();
      }
    };
    this.stop = function () {
      playing = false;
      try {
        if (audio) { audio.pause(); audio.currentTime = 0; }
      } catch (e) { /* ignore */ }
      stopSynth();
    };
  }

  function playEndTone() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);
      let t = ctx.currentTime + 0.05;
      [880, 660, 440].forEach((f) => {
        osc.frequency.setValueAtTime(f, t);
        gain.gain.setValueAtTime(0.06, t);
        t += 0.18;
      });
      gain.gain.setValueAtTime(0.0001, t);
      osc.start();
      osc.stop(t + 0.05);
    } catch (e) { /* ignore */ }
  }

  // ---- WebRTC-Verwaltung ---------------------------------------------------
  const CallManager = {
    pc: null,
    localStream: null,
    audioEl: null,
    remoteStream: null,
    async getStream() {
      if (this.localStream) return this.localStream;
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return this.localStream;
    },
    createPeer() {
      if (this.pc) this.pc.close();
      this.pc = new RTCPeerConnection({ iceServers: STUN });
      if (this.localStream) {
        this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream));
      }
      this.remoteStream = new MediaStream();
      this.pc.addEventListener('track', (e) => {
        this.remoteStream.addTrack(e.track);
        this.ensureAudio();
      });
      return this.pc;
    },
    ensureAudio() {
      if (this.audioEl) return;
      this.audioEl = document.createElement('audio');
      this.audioEl.autoplay = true;
      this.audioEl.srcObject = this.remoteStream;
      this.audioEl.play().catch(() => {});
    },
    setMuted(m) {
      if (this.localStream) this.localStream.getAudioTracks().forEach((t) => { t.enabled = !m; });
    },
    async waitGathering(pc, timeoutMs) {
      if (pc.iceGatheringState === 'complete') return;
      await new Promise((resolve) => {
        const done = () => { pc.removeEventListener('icegatheringstatechange', done); clearTimeout(t); resolve(); };
        const t = setTimeout(done, timeoutMs || 5000);
        pc.addEventListener('icegatheringstatechange', done);
      });
    },
    cleanup() {
      if (this.audioEl) { try { this.audioEl.pause(); } catch (e) { /* ignore */ } this.audioEl.srcObject = null; this.audioEl = null; }
      if (this.pc) { try { this.pc.close(); } catch (e) { /* ignore */ } this.pc = null; }
      if (this.localStream) { this.localStream.getTracks().forEach((t) => t.stop()); this.localStream = null; }
      this.remoteStream = null;
    },
  };

  // ---- Push für Mitarbeiter aktivieren (SW registrieren + abonnieren) -------
  async function ensurePush() {
    if (!PUSH_KEY || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(PUSH_KEY),
        });
      }
      await post('/api/push/subscribe', { subscription: sub.toJSON() });
    } catch (e) {
      console.warn('Push-Benachrichtigungen konnten nicht aktiviert werden.', e);
    }
  }

  function notifyInPage(title, body, url, actions) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const opts = { body, icon: '/static/logo.png', tag: 'support-call', data: { url } };
      if (actions && 'actions' in Notification.prototype && actions.length) opts.actions = actions;
      const n = new Notification(title, opts);
      n.onclick = () => {
        n.close();
        window.focus();
        if (url && window.location.pathname !== url) window.location.href = url;
      };
    } catch (e) { /* ignore */ }
  }

  // =========================================================================
  // MITARBEITER-KONSOLE (/support/staff)
  // =========================================================================
  if (STAFF) {
    const shiftBtn = $('shiftBtn');
    const queueList = $('queueList');
    const myCallContent = $('myCallContent');
    let clockedIn = false;
    let currentCallId = null;
    let offerSentFor = null;
    let notifiedCalls = {};

    function renderShift(st) {
      clockedIn = !!st.clockedIn;
      $('shiftDot').classList.toggle('staff-on', clockedIn);
      $('shiftDot').classList.toggle('staff-off', !clockedIn);
      text('shiftStatus', clockedIn ? 'Eingestempelt – du bist für Anrufe verfügbar' : 'Ausgestempelt – nicht für Anrufe verfügbar');
      shiftBtn.textContent = clockedIn ? 'Ausstempeln' : 'Einstempeln';
      shiftBtn.classList.toggle('btn-primary', !clockedIn);
      shiftBtn.classList.toggle('btn-danger', clockedIn);
      text('shiftSince', clockedIn ? `Seit ${fmtTime(st.shiftSince)}` : '');
      text('staffAvailability', `Freie Mitarbeiter: ${st.available}`);
      text('staffHotline', `Support-Nummer: ${st.hotline}`);
      const hist = st.history || [];
      $('shiftHistory').innerHTML = hist.length
        ? `<ul class="history-list">${hist.map((h) =>
            `<li>${fmtTime(h.clocked_in_at)} → ${h.clocked_out_at ? fmtTime(h.clocked_out_at) : 'läuft'}</li>`).join('')}</ul>`
        : '<p class="muted">Noch keine Schichten.</p>';
    }

    function renderQueue(queue) {
      if (!queue.length) {
        queueList.innerHTML = '<p class="muted">Keine wartenden Anrufer.</p>';
        return;
      }
      queueList.innerHTML = `<ul class="queue-list">${queue.map((c) => `
        <li class="queue-item">
          <div class="queue-item-main">
            <strong>${esc(c.callerName)}</strong>
            <span class="muted">${esc(c.display)} · Position ${c.position} · seit ${fmtTime(c.joinedAt)}</span>
          </div>
          <button class="btn btn-sm" data-accept="${c.id}">Anruf annehmen</button>
        </li>`).join('')}</ul>`;
      queueList.querySelectorAll('[data-accept]').forEach((b) => {
        b.addEventListener('click', () => acceptFromQueue(Number(b.dataset.accept)));
      });
    }

    async function acceptFromQueue(callId) {
      const r = await post('/api/support/call/accept', { callId });
      if (r.ok) { currentCallId = callId; notifyInPage('📞 Anruf angenommen', 'Warte auf die Verbindung zum Anrufer.', '/support/staff'); }
      else if (r.reason === 'notclocked') alert('Bitte stempel dich zuerst ein, um Anrufe anzunehmen.');
      else if (r.reason === 'busy') alert('Du hast bereits einen aktiven Anruf.');
      else alert('Der Anruf ist nicht mehr verfügbar.');
    }

    async function handleMyCall(callId) {
      if (currentCallId === callId && offerSentFor === callId) return;
      if (currentCallId && currentCallId !== callId) {
        CallManager.cleanup();
        offerSentFor = null;
      }
      currentCallId = callId;
      const s = await getJson(`/api/support/call/${callId}`);
      const c = s.call;
      if (!s.ok || !c) { currentCallId = null; renderMyCall(null); return; }

      if (c.status === 'ended' || c.status === 'timeout') {
        CallManager.cleanup();
        offerSentFor = null;
        renderMyCall({ ended: true, text: c.endedReason || 'Anruf beendet.' });
        return;
      }
      if (c.status === 'ringing' && c.offer) {
        // SDP-Angebot des Anrufers liegt vor -> Answer erzeugen.
        if (offerSentFor !== callId) {
          offerSentFor = callId;
          notifyInPage('📞 Neuer Support-Anruf', `${c.callerName} wartet – du wirst verbunden.`, '/support/staff', [
            { action: 'open', title: 'To Website' },
          ]);
          await createAnswer(callId, c.offer);
        }
        renderMyCall({ status: 'ringing', display: c.display, callerName: c.callerName });
        return;
      }
      if (c.status === 'active' || c.status === 'ringing') {
        renderMyCall({ status: c.status, display: c.display, callerName: c.callerName });
        return;
      }
      renderMyCall({ status: c.status, display: c.display, callerName: c.callerName });
    }

    async function createAnswer(callId, offerSdp) {
      try {
        const stream = await CallManager.getStream();
        const pc = CallManager.createPeer();
        await pc.setRemoteDescription(JSON.parse(offerSdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await CallManager.waitGathering(pc, 6000);
        await post('/api/support/call/signal', { callId, role: 'answer', sdp: JSON.stringify(pc.localDescription) });
        renderMyCall({ status: 'active', display: callId, callerName: 'Mitarbeiter' });
      } catch (e) {
        console.error('Answer fehlgeschlagen:', e);
      }
    }

    function renderMyCall(info) {
      if (!info) { myCallContent.innerHTML = '<p class="muted">Kein aktiver Anruf.</p>'; return; }
      if (info.ended) { myCallContent.innerHTML = `<p>${esc(info.text)}</p>`; return; }
      myCallContent.innerHTML = `
        <div class="my-call">
          <span class="badge ${info.status === 'active' ? 'badge-active' : 'badge-ringing'}">${info.status === 'active' ? 'Im Gespräch' : 'Klingelt'}</span>
          <strong>${esc(info.display)}</strong>
          <span class="muted">Anrufer: ${esc(info.callerName || '–')}</span>
          <div class="my-call-actions">
            <button class="btn btn-sm" id="staffMuteBtn">🔇 Stumm</button>
            <button class="btn btn-danger btn-sm" id="staffHangupBtn">Beenden</button>
          </div>
        </div>`;
      let muted = false;
      const muteBtn = $('staffMuteBtn');
      if (muteBtn) muteBtn.addEventListener('click', () => {
        muted = !muted;
        CallManager.setMuted(muted);
        muteBtn.textContent = muted ? '🔊 Ton an' : '🔇 Stumm';
      });
      const hangup = $('staffHangupBtn');
      if (hangup) hangup.addEventListener('click', async () => {
        await post('/api/support/call/end', { callId: currentCallId });
        CallManager.cleanup();
        currentCallId = null;
        offerSentFor = null;
      });
    }

    shiftBtn.addEventListener('click', async () => {
      if (!clockedIn && Notification.permission !== 'granted' && 'Notification' in window) {
        const p = await Notification.requestPermission();
        if (p === 'granted') ensurePush();
      }
      const r = clockedIn ? await post('/api/support/clockout') : await post('/api/support/clockin');
      if (r.ok) refreshStaff();
    });

    async function refreshStaff() {
      const st = await getJson('/api/support/staff/state');
      if (!st.hotline) return;
      renderShift(st);
      renderQueue(st.queue || []);
      if (st.myCall) handleMyCall(st.myCall.id);
      else if (currentCallId) {
        CallManager.cleanup();
        currentCallId = null;
        offerSentFor = null;
        renderMyCall(null);
      }
    }

    refreshStaff();
    setInterval(refreshStaff, POLL_MS);
    return;
  }

  // =========================================================================
  // ANRUFER-SEITE (/support)
  // =========================================================================
  const waitMusic = new HoldMusic();
  let callId = null;
  let offerSent = false;
  let streamReady = false;
  let timerInt = null;
  let joinedAtMs = null;

  const startBtn = $('startCallBtn');
  const callAgainBtn = $('callAgainBtn');
  const hangupWaitingBtn = $('hangupWaitingBtn');
  const hangupConnectingBtn = $('hangupConnectingBtn');
  const hangupActiveBtn = $('hangupActiveBtn');
  const muteBtn = $('muteBtn');

  function showStage(name) {
    hide($('supportIdle'));
    hide($('supportWaiting'));
    hide($('supportConnecting'));
    hide($('supportActive'));
    hide($('supportEnded'));
    const map = {
      idle: 'supportIdle',
      waiting: 'supportWaiting',
      connecting: 'supportConnecting',
      active: 'supportActive',
      ended: 'supportEnded',
    };
    show($(map[name]));
  }

  function startTimer() {
    stopTimer();
    joinedAtMs = joinedAtMs || Date.now();
    timerInt = setInterval(() => {
      text('waitTimer', `Bereits gewartet: ${fmtDuration(Date.now() - joinedAtMs)}`);
    }, 1000);
  }
  function stopTimer() {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
  }

  async function refreshIdle() {
    const st = await getJson('/api/support/state');
    if (!st.hotline) return;
    text('hotlineNumber', st.hotline);
    text('availabilityText', st.available > 0
      ? `${st.available} Mitarbeiter derzeit verfügbar.`
      : 'Derzeit ist kein Mitarbeiter verfügbar – dein Anruf wird trotzdem in die Warteschleife gestellt.');
    if (st.call) {
      // Bereits ein laufender Anruf -> fortführen
      callId = st.call;
      joinedAtMs = Date.now();
      pollCall();
    }
  }

  async function startCall() {
    try {
      await CallManager.getStream();
      streamReady = true;
    } catch (e) {
      alert('Kein Mikrofon-Zugriff. Bitte erlaube den Mikrofon-Zugriff, um den Support anzurufen.');
      return;
    }
    const r = await post('/api/support/call/start');
    if (!r.ok || !r.call) { alert('Der Anruf konnte nicht gestartet werden. Bitte erneut versuchen.'); return; }
    callId = r.call.id;
    joinedAtMs = Date.now();
    showStage('waiting');
    startTimer();
    waitMusic.start();
    pollCall();
  }

  async function sendOffer() {
    if (offerSent || !callId) return;
    offerSent = true;
    try {
      const pc = CallManager.createPeer();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await CallManager.waitGathering(pc, 6000);
      await post('/api/support/call/signal', { callId, role: 'offer', sdp: JSON.stringify(pc.localDescription) });
    } catch (e) {
      console.error('Offer fehlgeschlagen:', e);
    }
  }

  async function pollCall() {
    if (!callId) return;
    const s = await getJson(`/api/support/call/${callId}`);
    if (!s.ok || !s.call) { endCleanup(); showStage('idle'); refreshIdle(); return; }
    const c = s.call;

    if (c.status === 'waiting') {
      showStage('waiting');
      waitMusic.start();
      startTimer();
      text('queuePositionText', `Ihre Position in der Warteschlange: ${c.queuePosition}.`);
      return;
    }
    if (c.status === 'ringing') {
      showStage('connecting');
      waitMusic.stop();
      stopTimer();
      if (!streamReady) {
        try { await CallManager.getStream(); streamReady = true; } catch (e) { /* Mikrofon nicht verfügbar */ }
      }
      if (streamReady && !offerSent) sendOffer();
      return;
    }
    if (c.status === 'active') {
      if (c.answer && offerSent && CallManager.pc) {
        const pc = CallManager.pc;
        if (pc.signalingState === 'stable') { /* bereits verbunden */ }
        else if (pc.signalingState === 'have-local-offer') {
          try {
            await pc.setRemoteDescription(JSON.parse(c.answer));
          } catch (e) { console.error('Answer übernehmen fehlgeschlagen:', e); }
        }
      }
      showStage('active');
      waitMusic.stop();
      stopTimer();
      if (c.staffName) text('activeStaffName', c.staffName);
      return;
    }
    if (c.status === 'timeout') {
      waitMusic.stop();
      stopTimer();
      playEndTone();
      text('endedTitle', 'Derzeit kein Mitarbeiter verfügbar');
      text('endedText', c.endedReason || 'Bitte versuchen Sie es später noch einmal.');
      endCleanup();
      showStage('ended');
      return;
    }
    if (c.status === 'ended') {
      waitMusic.stop();
      stopTimer();
      text('endedTitle', 'Anruf beendet');
      text('endedText', c.endedReason || 'Vielen Dank für Ihren Anruf.');
      endCleanup();
      showStage('ended');
      return;
    }
  }

  function endCleanup() {
    callId = null;
    offerSent = false;
    streamReady = false;
    joinedAtMs = null;
    CallManager.cleanup();
  }

  startBtn.addEventListener('click', startCall);
  callAgainBtn.addEventListener('click', () => { showStage('idle'); refreshIdle(); });
  hangupWaitingBtn.addEventListener('click', async () => {
    if (callId) await post('/api/support/call/end', { callId });
    waitMusic.stop();
    stopTimer();
    endCleanup();
    showStage('idle');
    refreshIdle();
  });
  hangupConnectingBtn.addEventListener('click', async () => {
    if (callId) await post('/api/support/call/end', { callId });
    endCleanup();
    showStage('idle');
    refreshIdle();
  });
  hangupActiveBtn.addEventListener('click', async () => {
    if (callId) await post('/api/support/call/end', { callId });
    endCleanup();
    showStage('idle');
    refreshIdle();
  });

  let muted = false;
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    CallManager.setMuted(muted);
    muteBtn.textContent = muted ? '🔊 Ton an' : '🔇 Mikrofon stumm';
  });

  refreshIdle();
  // Ein gemeinsamer Poll-Zyklus: aktiver Anruf -> Anruf-Zustand, sonst -> Idle.
  setInterval(() => {
    if (callId) pollCall();
    else refreshIdle();
  }, POLL_MS);
})();
