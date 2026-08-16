'use strict';

// ---------------------------------------------------------------------------
// Voice-Support / Support-Hotline – Client-Logik
// ---------------------------------------------------------------------------
// Läuft auf /support (Anrufer) und /support/staff (Mitarbeiter-Konsole).
// Der Server-Zustand wird per Polling abgefragt; der eigentliche Sprachanruf
// läuft über WebRTC direkt zwischen den Browsern. Die Signalisierung (SDP)
// wird über die Datenbank ausgetauscht (kein Socket.io nötig).
//
// Ablauf (manuelle Annahme):
//   1. Anrufer ruft an -> Warteschlange (Musik + geschätzte Wartezeit).
//   2. Ein eingestempelter Mitarbeiter klickt in der Warteschlange auf
//      "Annehmen" (dieser Klick erlaubt dem Browser auch das Mikrofon).
//   3. Der Mitarbeiter erstellt das WebRTC-Angebot (offer), der Anrufer
//      antwortet (answer) -> Verbindung steht, beide reden sofort los.
//   4. Der Mitarbeiter kann den Anruf an den nächsten freien Mitarbeiter
//      weiterleiten; der Anrufer bleibt dabei vorn in der Warteschlange.
// ---------------------------------------------------------------------------
(function () {
  const STAFF = window.SUPPORT_STAFF === true;
  const PUSH_KEY = window.SUPPORT_PUSH_KEY || '';
  const POLL_MS = Math.max(1000, Number(window.SUPPORT_POLL_MS) || 3000);
  const ANNOUNCE_MS = Math.max(5000, Number(window.SUPPORT_ANNOUNCE_MS) || 30000);
  const STUN_LIST = Array.isArray(window.SUPPORT_STUN) && window.SUPPORT_STUN.length
    ? window.SUPPORT_STUN.map((u) => ({ urls: u }))
    : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  // ---- Kleine Helfer ------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }
  function text(id, t) { const el = $(id); if (el) el.textContent = t; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // Uebersichtliche Support-Zeiten: gruppierte Tage als Zeilen (Mo–Fr 09:00–18:00).
  function renderSupportHours(el, table, label) {
    if (!el) return;
    const fallback = label || 'Jederzeit erreichbar';
    if (!table || !table.length) {
      el.innerHTML = `<span class="support-hours-anytime">Support-Zeiten: ${esc(fallback)}</span>`;
      return;
    }
    el.innerHTML =
      '<span class="support-hours-title">Support-Zeiten</span>' +
      '<span class="support-hours-rows">' +
      table.map((r) =>
        `<span class="support-hours-row">` +
        `<span class="support-hours-days">${esc(r.days)}</span>` +
        `<span class="support-hours-time">${esc(r.start)}–${esc(r.end)} Uhr</span>` +
        `</span>`).join('') +
      '</span>';
  }
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

  // ---- Audio entsperren (Browser blockiert Autoplay ohne Nutzeraktion) ----
  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    document.addEventListener('pointerdown', () => {
      document.querySelectorAll('audio').forEach((a) => {
        if (a.paused) a.play().catch(() => {});
      });
    }, { passive: true });
  }
  unlockAudio();

  // ---- Warteschleifenmusik & Signaltöne ------------------------------------
  function HoldMusic() {
    let audio = null;
    let playing = false;
    let synth = null;
    let playlist = [];
    let index = 0;
    let endHandlerAttached = false;
    const DEFAULT_SRC = '/static/audio/hold-music.wav';

    function shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    async function loadSongs() {
      let songs = [];
      try {
        const r = await fetch('/api/support/hold-music', { cache: 'no-store' });
        const j = await r.json();
        if (j.ok && Array.isArray(j.songs)) songs = j.songs.filter((s) => s && s.id);
      } catch (e) { songs = []; }
      playlist = songs.length
        ? shuffle(songs.map((s) => `/api/support/hold-music/${s.id}`))
        : [DEFAULT_SRC];
      index = 0;
    }

    function playIndex(i) {
      index = ((i % playlist.length) + playlist.length) % playlist.length;
      try {
        audio.src = playlist[index];
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            if (playlist.length > 1) playIndex(index + 1);
            else startSynth();
          });
        }
      } catch (e) {
        startSynth();
      }
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
      if (!playlist.length) await loadSongs();
      try {
        if (!audio) {
          audio = new Audio();
          audio.volume = 0.4;
          endHandlerAttached = false;
        }
        if (!endHandlerAttached) {
          endHandlerAttached = true;
          audio.addEventListener('ended', () => {
            if (playing) playIndex(index + 1);
          });
          audio.addEventListener('error', () => {
            if (playing && playlist.length > 1) playIndex(index + 1);
          });
        }
        playIndex(0);
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

  // ---- KI-Ansagen in der Warteschleife (deutsch + englisch) -----------------
  // Sagt in regelmässigen Abständen die Position und die Anzahl verfügbarer
  // Mitarbeiter an. Läuft nur, solange der Anrufer in der Warteschleife ist.
  function Announcer() {
    let muted = false;
    let timer = null;
    let enTimer = null;
    let lastStatus = null;
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];

    function voiceFor(lang) {
      if (!voices.length) {
        // getVoices() kann initial leer sein -> beim onvoiceschanged nachladen
        const all = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
        return all.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang)) || null;
      }
      return voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang)) || null;
    }

    function speak(text, lang) {
      if (!window.speechSynthesis || muted) return;
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        u.rate = 0.95;
        u.pitch = 1;
        const v = voiceFor(lang);
        if (v) u.voice = v;
        window.speechSynthesis.speak(u);
      } catch (e) { /* Sprachsynthese nicht verfügbar */ }
    }

    function say(status) {
      if (muted || !status) return;
      lastStatus = status;
      const avail = status.availableStaff != null ? status.availableStaff : status.available;
      const pos = status.queuePosition || 1;
      const de = avail > 0
        ? `Vielen Dank für Ihren Anruf beim MRB Support. Sie sind Position ${pos} in der Warteschleife. Es sind derzeit ${avail} Mitarbeiter verfügbar. Bitte bleiben Sie am Apparat.`
        : 'Es ist derzeit kein Mitarbeiter verfügbar. Bitte bleiben Sie am Apparat. Ihr Anruf wird verbunden, sobald ein Mitarbeiter frei wird.';
      const en = avail > 0
        ? `Thank you for calling MRB support. You are number ${pos} in the queue. There are currently ${avail} staff members available. Please hold.`
        : 'No staff members are available right now. Please stay on the line. Your call will be connected as soon as a staff member becomes available.';
      speak(de, 'de-DE');
      // Englische Ansage nach der deutschen abspielen
      if (enTimer) clearTimeout(enTimer);
      enTimer = setTimeout(() => speak(en, 'en-US'), 5000);
    }

    this.isMuted = () => muted;
    this.setMuted = (m) => {
      muted = !!m;
      if (muted && window.speechSynthesis) window.speechSynthesis.cancel();
    };
    this.update = (status) => { lastStatus = status; };
    this.start = (status) => {
      this.stop();
      lastStatus = status;
      say(status);
      timer = setInterval(() => say(lastStatus), ANNOUNCE_MS);
    };
    this.stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
      if (enTimer) { clearTimeout(enTimer); enTimer = null; }
      if (window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      }
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
    // Stream, der ueber WebRTC versendet wird: normalisierter Stream (falls die
    // Audio-Kette aktiv ist) oder das rohe Mikrofon (Fallback).
    sentStream: null,
    audioCtx: null,
    micSource: null,
    compressor: null,
    processedDest: null,
    audioEl: null,
    remoteStream: null,
    muted: false,
    // Rauschunterdrückung: Standardmäßig an, Wahl des Nutzers wird dauerhaft
    // gespeichert (localStorage), damit sie bei jedem Anruf gilt.
    noiseSuppression: (() => {
      try { return localStorage.getItem('support_noise_suppression') !== '0'; } catch (e) { return true; }
    })(),
    audioConstraints() {
      return {
        echoCancellation: true,
        noiseSuppression: !!this.noiseSuppression,
        autoGainControl: true,
      };
    },
    // Immer das Standard-Mikrofon des genutzten Geräts verwenden. Es wird per
    // enumerateDevices ermittelt (Gerät mit deviceId 'default') und explizit
    // angefordert, damit der Anruf am Standard-Eingang bleibt. Scheitert die
    // Auswahl, wird schrittweise auf die normale Anforderung bzw. auf
    // { audio: true } (Browser-Standard) zurückgefallen.
    async pickDefaultMicDeviceId() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const input = devices.find((d) => d.kind === 'audioinput' && d.deviceId === 'default');
        return input ? input.deviceId : null;
      } catch (e) { return null; }
    },
    async openMicStream() {
      const deviceId = await this.pickDefaultMicDeviceId();
      const attempts = [];
      if (deviceId) attempts.push({ audio: { ...this.audioConstraints(), deviceId: { exact: deviceId } } });
      attempts.push({ audio: this.audioConstraints() });
      attempts.push({ audio: true });
      let lastErr = null;
      for (const constraints of attempts) {
        try { return await navigator.mediaDevices.getUserMedia(constraints); }
        catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('Kein Mikrofon-Zugriff');
    },
    async getStream() {
      if (this.localStream) return this.localStream;
      this.localStream = await this.openMicStream();
      this.sentStream = await this.buildAudioChain(this.localStream);
      if (this.muted) this.setMuted(true);
      return this.localStream;
    },
    // Audio-Normalisierung: Das Mikrofon laeuft durch eine Web-Audio-Kette mit
    // DynamicsCompressor, damit Lautstaerke-Schwankungen und leises Sprechen
    // ausgeglichen werden und der Sprecher auch bei schlechter Mikrofon-Qualitaet
    // deutlich zu verstehen ist. Steht der AudioContext nicht auf "running"
    // (z. B. Autoplay-Blockade), wird das rohe Mikrofon versendet (Fallback).
    async buildAudioChain(rawStream) {
      this.teardownAudioChain();
      if (!rawStream) return rawStream;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return rawStream;
        if (this.audioCtx && this.audioCtx.state === 'closed') this.audioCtx = null;
        if (!this.audioCtx) this.audioCtx = new Ctx();
        if (this.audioCtx.state === 'suspended') {
          try { await this.audioCtx.resume(); } catch (e) { /* ignore */ }
        }
        if (this.audioCtx.state !== 'running') return rawStream;
        this.micSource = this.audioCtx.createMediaStreamSource(rawStream);
        this.compressor = this.audioCtx.createDynamicsCompressor();
        this.compressor.threshold.value = -45;
        this.compressor.knee.value = 15;
        this.compressor.ratio.value = 12;
        this.compressor.attack.value = 0.002;
        this.compressor.release.value = 0.2;
        const makeup = this.audioCtx.createGain();
        makeup.gain.value = 1.6;
        this.processedDest = this.audioCtx.createMediaStreamDestination();
        this.micSource.connect(this.compressor);
        this.compressor.connect(makeup);
        makeup.connect(this.processedDest);
        return this.processedDest.stream;
      } catch (e) {
        console.warn('Audio-Normalisierung nicht verfuegbar:', e);
        this.teardownAudioChain();
        return rawStream;
      }
    },
    teardownAudioChain() {
      try {
        if (this.micSource) this.micSource.disconnect();
        if (this.compressor) this.compressor.disconnect();
        if (this.processedDest) this.processedDest.disconnect();
      } catch (e) { /* ignore */ }
      this.micSource = null;
      this.compressor = null;
      this.processedDest = null;
    },
    // Rauschunterdrückung umschalten: Wird gespeichert und – falls bereits ein
    // Anruf läuft – das Mikrofon mit den neuen Einstellungen neu geöffnet und
    // der Track im laufenden Peer-Connection ersetzt (replaceTrack).
    async setNoiseSuppression(enabled) {
      this.noiseSuppression = !!enabled;
      try { localStorage.setItem('support_noise_suppression', this.noiseSuppression ? '1' : '0'); } catch (e) { /* ignore */ }
      if (!this.localStream) return;
      let newStream;
      try {
        newStream = await this.openMicStream();
      } catch (e) {
        console.warn('Mikrofon mit geänderten Einstellungen konnte nicht neu geöffnet werden:', e);
        return;
      }
      const oldStream = this.localStream;
      this.localStream = newStream;
      this.sentStream = await this.buildAudioChain(newStream);
      const pc = this.pc;
      if (pc) {
        const newTracks = this.sentStream.getAudioTracks();
        const senders = pc.getSenders();
        let i = 0;
        for (const sender of senders) {
          if (!sender.track || sender.track.kind !== 'audio') continue;
          const track = newTracks[i++];
          try { await sender.replaceTrack(track || null); } catch (e) { console.warn('replaceTrack fehlgeschlagen:', e); }
        }
      }
      oldStream.getTracks().forEach((t) => t.stop());
      if (this.muted) this.setMuted(true);
    },
    createPeer() {
      if (this.pc) this.pc.close();
      this.pc = new RTCPeerConnection({
        iceServers: STUN_LIST,
        iceCandidatePoolSize: 4,
      });
      const send = this.sentStream || this.localStream;
      if (send) {
        send.getTracks().forEach((t) => this.pc.addTrack(t, send));
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
      // Muss im DOM sein, damit der Browser das entfernte Audio abspielt.
      this.audioEl.style.display = 'none';
      this.audioEl.setAttribute('playsinline', '');
      document.body.appendChild(this.audioEl);
      this.audioEl.play().catch(() => {});
    },
    setMuted(m) {
      this.muted = !!m;
      const streams = [this.sentStream, this.localStream];
      for (const s of streams) {
        if (s) s.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
      }
    },
    unmute() {
      this.muted = false;
      const streams = [this.sentStream, this.localStream];
      for (const s of streams) {
        if (s) s.getAudioTracks().forEach((t) => { t.enabled = true; });
      }
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
      if (this.audioEl) { try { this.audioEl.pause(); } catch (e) { /* ignore */ } this.audioEl.srcObject = null; if (this.audioEl.parentNode) this.audioEl.parentNode.removeChild(this.audioEl); this.audioEl = null; }
      if (this.pc) { try { this.pc.close(); } catch (e) { /* ignore */ } this.pc = null; }
      this.teardownAudioChain();
      try { if (this.audioCtx && this.audioCtx.state !== 'closed') this.audioCtx.close(); } catch (e) { /* ignore */ }
      this.audioCtx = null;
      this.sentStream = null;
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
    const busyList = $('busyList');
    const myCallContent = $('myCallContent');
    let clockedIn = false;
    let currentCallId = null;
    let offerSentFor = null;
    let answerAppliedFor = null;
    let notifiedCalls = {};

    function renderShift(st) {
      clockedIn = !!st.clockedIn;
      $('shiftDot').classList.toggle('staff-on', clockedIn);
      $('shiftDot').classList.toggle('staff-off', !clockedIn);
      text('shiftStatus', clockedIn ? 'Eingestempelt – du bist für Anrufe verfügbar' : 'Ausgestempelt – nicht für Anrufe verfügbar');
      shiftBtn.textContent = clockedIn ? 'Ausstempeln' : 'Einstempeln';
      shiftBtn.classList.toggle('btn-primary', !clockedIn);
      shiftBtn.classList.toggle('btn-danger', clockedIn);
      text('staffExtension', st.extension ? `Deine Nummer: #${st.extension}` : '');
      text('shiftSince', clockedIn ? `Seit ${fmtTime(st.shiftSince)}` : '');
      text('staffAvailability', `Freie Mitarbeiter: ${st.available}`);
      text('staffHotline', `Support-Nummer: ${st.hotline}`);
      renderSupportHours($('staffHours'), st.supportHoursTable, st.supportHoursLabel);
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
          <button class="btn btn-primary btn-sm accept-call-btn" data-call-id="${c.id}">Annehmen</button>
        </li>`).join('')}</ul>`;
    }

    function renderBusy(busy) {
      if (!busy || !busy.length) {
        busyList.innerHTML = '<p class="muted">Gerade ist niemand im Gespräch.</p>';
        return;
      }
      busyList.innerHTML = `<ul class="busy-list">${busy.map((b) => `
        <li>
          ${esc(b.name)}${b.extension ? ` (${esc(b.extension)})` : ''}
          <span class="tag ${b.status === 'active' ? 'tag-claimed' : 'tag-ringing'}">${b.status === 'active' ? 'Im Gespräch' : 'Wird verbunden'}</span>
        </li>`).join('')}</ul>`;
    }

    async function acceptCall(callId) {
      const r = await post(`/api/support/call/${callId}/accept`);
      if (!r.ok && r.reason === 'busy') {
        alert('Du hast bereits einen Anruf. Beende oder leite ihn erst weiter.');
      }
      refreshStaff();
    }

    queueList.addEventListener('click', (e) => {
      const btn = e.target.closest('.accept-call-btn');
      if (btn) acceptCall(Number(btn.dataset.callId));
    });

    async function handleMyCall(callId) {
      if (currentCallId === callId && offerSentFor === callId && myCallStatus === 'active') return;
      if (currentCallId && currentCallId !== callId) {
        CallManager.cleanup();
        offerSentFor = null;
        answerAppliedFor = null;
      }
      currentCallId = callId;
      const s = await getJson(`/api/support/call/${callId}`);
      const c = s.call;
      if (!s.ok || !c) { currentCallId = null; renderMyCall(null); return; }

      if (c.status === 'ended' || c.status === 'timeout') {
        CallManager.cleanup();
        offerSentFor = null;
        answerAppliedFor = null;
        renderMyCall({ ended: true, text: c.endedReason || 'Anruf beendet.' });
        return;
      }
      if (c.status === 'ringing') {
        renderMyCall({ status: 'ringing', display: c.display, callerName: c.callerName });
        if (offerSentFor !== callId) {
          offerSentFor = callId;
          notifyInPage('📞 Neuer Support-Anruf', `${c.callerName} – nimm den Anruf an.`, '/support/staff', [
            { action: 'open', title: 'To Website' },
          ]);
          await createOffer(callId);
        }
        return;
      }
      if (c.status === 'active') {
        myCallStatus = 'active';
        renderMyCall({ status: 'active', display: c.display, callerName: c.callerName, staffExtension: c.staffExtension });
        // Die Antwort des Anrufers auf unser Angebot einmalig anwenden – erst
        // dadurch ist die WebRTC-Verbindung (Audio in beide Richtungen) hergestellt.
        if (c.answer && answerAppliedFor !== callId) {
          answerAppliedFor = callId;
          const pc = CallManager.pc;
          if (pc) {
            try {
              await pc.setRemoteDescription(JSON.parse(c.answer));
            } catch (e) {
              console.error('Antwort des Anrufers anwenden fehlgeschlagen:', e);
            }
          }
        }
        startRecording(callId);
        CallManager.unmute();
        return;
      }
      renderMyCall({ status: c.status, display: c.display, callerName: c.callerName });
    }

    let myCallStatus = null;
    let transferTargets = [];

    // Der Mitarbeiter erstellt das SDP-Angebot (er hat durch den Klick auf
    // "Annehmen" die Mikrofon-Freigabe).
    async function createOffer(callId) {
      try {
        const stream = await CallManager.getStream();
        const pc = CallManager.createPeer();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await CallManager.waitGathering(pc, 6000);
        await post('/api/support/call/signal', { callId, role: 'offer', sdp: JSON.stringify(pc.localDescription) });
        CallManager.unmute();
        myCallStatus = 'ringing';
      } catch (e) {
        console.error('Offer fehlgeschlagen:', e);
      }
    }

    // ---- Aufzeichnung (jedes Gespräch wird aufgezeichnet) ------------------
    let recorder = null;
    let recorderChunks = [];
    let recorderMix = null;
    let recordingActive = false;
    let recordingCallId = null;

    function pickRecorderMime() {
      if (!window.MediaRecorder) return '';
      const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
      for (const m of opts) if (MediaRecorder.isTypeSupported(m)) return m;
      return '';
    }

    function startRecording(callId) {
      if (recordingActive) {
        if (recordingCallId === callId) return;
        stopRecording();
      }
      try {
        const local = CallManager.localStream;
        const remote = CallManager.remoteStream;
        if (!local || !remote || !remote.getAudioTracks().length) return;
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const dest = ctx.createMediaStreamDestination();
        ctx.createMediaStreamSource(local).connect(dest);
        ctx.createMediaStreamSource(remote).connect(dest);
        const mime = pickRecorderMime();
        const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
        recorderChunks = [];
        rec.addEventListener('dataavailable', (e) => {
          if (e.data && e.data.size) recorderChunks.push(e.data);
        });
        rec.start(1000);
        recorder = rec;
        recorderMix = { ctx, dest };
        recordingActive = true;
        recordingCallId = callId;
      } catch (e) {
        console.error('Aufzeichnung fehlgeschlagen:', e);
      }
    }

    function stopRecording() {
      if (!recordingActive || !recorder) return;
      const rec = recorder;
      recorder = null;
      const mix = recorderMix;
      recorderMix = null;
      const callId = recordingCallId;
      recordingCallId = null;
      recordingActive = false;
      const chunks = recorderChunks;
      recorderChunks = [];
      rec.addEventListener('stop', () => {
        if (mix) { try { mix.ctx.close(); } catch (e) { /* ignore */ } }
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        uploadRecording(callId, blob);
      });
      try { rec.stop(); } catch (e) { /* ignore */ }
    }

    async function uploadRecording(callId, blob) {
      if (!callId || !blob || !blob.size) return;
      try {
        const fd = new FormData();
        fd.append('recording', blob, `call-${callId}.webm`);
        const r = await fetch(`/api/support/call/${callId}/recording`, { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (j.ok) console.log(`Aufzeichnung von Anruf #SUP-${String(callId).padStart(4, '0')} gespeichert.`);
        else console.warn('Aufzeichnung konnte nicht gespeichert werden:', j.reason || j.error);
      } catch (e) {
        console.error('Upload der Aufzeichnung fehlgeschlagen:', e);
      }
    }

    // ---- Bestätigungsdialoge ----------------------------------------------
    const consentModal = $('recordConsentModal');
    function openRecordConsent(cb) {
      if (!consentModal) return cb();
      show(consentModal);
      const ok = $('recordConsentOk');
      const cancel = $('recordConsentCancel');
      const done = (accept) => {
        hide(consentModal);
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        if (accept) cb();
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
    }

    const transferModal = $('transferModal');
    let transferCb = null;
    function openTransferConfirm(cb) {
      if (!transferModal) return cb(null);
      transferCb = cb;
      const sel = $('transferTargetSelect');
      if (sel) {
        sel.innerHTML =
          '<option value="">Nächster freier Mitarbeiter (Warteschlange)</option>' +
          transferTargets.map((t) =>
            `<option value="${t.id}" ${t.busy ? 'disabled' : ''}>${esc(t.name)}${t.extension ? ` (${esc(t.extension)})` : ''}${t.busy ? ' – im Gespräch' : ''}</option>`).join('') +
          (transferTargets.length ? '' : '<option disabled>Kein Mitarbeiter eingestempelt</option>');
      }
      show(transferModal);
      $('transferOk').addEventListener('click', onTransferOk);
      $('transferCancel').addEventListener('click', onTransferCancel);
    }
    function closeTransfer() {
      hide(transferModal);
      $('transferOk').removeEventListener('click', onTransferOk);
      $('transferCancel').removeEventListener('click', onTransferCancel);
    }
    function onTransferOk() {
      const cb = transferCb;
      transferCb = null;
      const sel = $('transferTargetSelect');
      const targetId = sel ? sel.value : '';
      closeTransfer();
      if (cb) cb(targetId || null);
    }
    function onTransferCancel() {
      transferCb = null;
      closeTransfer();
    }

    function renderMyCall(info) {
      if (!info) { myCallContent.innerHTML = '<p class="muted">Kein aktiver Anruf.</p>'; return; }
      if (info.ended) { myCallContent.innerHTML = `<p>${esc(info.text)}</p>`; return; }
      const isActive = info.status === 'active';
      myCallContent.innerHTML = `
        <div class="my-call">
          <span class="badge ${isActive ? 'badge-active' : 'badge-ringing'}">${isActive ? 'Im Gespräch' : 'Wird verbunden'}</span>
          <strong>${esc(info.display)}</strong>
          <span class="muted">Anrufer: ${esc(info.callerName || '–')}</span>
          <span class="muted">Durchwahl: ${esc(info.staffExtension || '–')}</span>
          <p class="muted small" id="recordingStatus">${recordingActive ? '🎙️ Aufzeichnung läuft' : ''}</p>
          <div class="my-call-actions">
            <button class="btn btn-sm" id="staffMuteBtn" title="Mikrofon ein- oder ausschalten">🎤 Mikrofon an</button>
            <button class="btn btn-sm" id="staffNoiseBtn" title="Rauschunterdrückung ein- oder ausschalten"></button>
            <button class="btn btn-sm" id="staffTransferBtn" title="Anruf an einen anderen Mitarbeiter weiterleiten" ${isActive ? '' : 'disabled'}>↪️ Weiterleiten</button>
            <button class="btn btn-danger btn-sm" id="staffHangupBtn" title="Anruf beenden">📵 Anruf beenden</button>
          </div>
        </div>`;
      let muted = false;
      const muteBtn = $('staffMuteBtn');
      if (muteBtn) muteBtn.addEventListener('click', () => {
        muted = !muted;
        CallManager.setMuted(muted);
        muteBtn.textContent = muted ? '🔇 Stummgeschaltet' : '🎤 Mikrofon an';
      });
      const staffNoiseBtn = $('staffNoiseBtn');
      if (staffNoiseBtn) {
        const applyStaffNoise = () => {
          staffNoiseBtn.textContent = CallManager.noiseSuppression
            ? '🎚️ Rauschunterdrückung: An'
            : '🎚️ Rauschunterdrückung: Aus';
        };
        applyStaffNoise();
        staffNoiseBtn.addEventListener('click', async () => {
          await CallManager.setNoiseSuppression(!CallManager.noiseSuppression);
          applyStaffNoise();
        });
      }
      const transfer = $('staffTransferBtn');
      if (transfer) transfer.addEventListener('click', () => {
        openTransferConfirm(async (targetStaffId) => {
          const r = await post(`/api/support/call/${currentCallId}/transfer`, targetStaffId ? { targetStaffId } : {});
          if (!r.ok) {
            if (r.reason === 'busy') {
              alert(`${r.targetName || 'Der gewählte Mitarbeiter'} ist gerade im Gespräch – der Anruf wurde nicht weitergeleitet.`);
            } else if (r.reason === 'unavailable') {
              alert(`${r.targetName || 'Der gewählte Mitarbeiter'} ist derzeit nicht erreichbar – der Anruf wurde nicht weitergeleitet.`);
            } else if (r.reason === 'invalid') {
              alert('Dieser Anruf kann gerade nicht weitergeleitet werden.');
            } else {
              alert('Weiterleitung fehlgeschlagen. Bitte erneut versuchen.');
            }
            return;
          }
          CallManager.cleanup();
          currentCallId = null;
          offerSentFor = null;
          answerAppliedFor = null;
          myCallStatus = null;
          stopRecording();
        });
      });
      const hangup = $('staffHangupBtn');
      if (hangup) hangup.addEventListener('click', async () => {
        await post('/api/support/call/end', { callId: currentCallId });
        CallManager.cleanup();
        currentCallId = null;
        offerSentFor = null;
        answerAppliedFor = null;
        myCallStatus = null;
        stopRecording();
      });
    }

    async function toggleShift() {
      if (!clockedIn && Notification.permission !== 'granted' && 'Notification' in window) {
        const p = await Notification.requestPermission();
        if (p === 'granted') ensurePush();
      }
      const r = clockedIn ? await post('/api/support/clockout') : await post('/api/support/clockin');
      if (r.ok) refreshStaff();
    }

    shiftBtn.addEventListener('click', () => {
      if (!clockedIn) openRecordConsent(toggleShift);
      else toggleShift();
    });

    async function refreshStaff() {
      const st = await getJson('/api/support/staff/state');
      if (!st.hotline) return;
      if (Array.isArray(st.transferTargets)) transferTargets = st.transferTargets;
      renderShift(st);
      renderQueue(st.queue || []);
      renderBusy(st.busyStaff || []);
      if (st.myCall) {
        handleMyCall(st.myCall.id);
        const rs = $('recordingStatus');
        if (rs) rs.textContent = recordingActive ? '🎙️ Aufzeichnung läuft' : '';
      } else if (currentCallId) {
        CallManager.cleanup();
        currentCallId = null;
        offerSentFor = null;
        answerAppliedFor = null;
        myCallStatus = null;
        stopRecording();
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
  const announcer = new Announcer();
  let callId = null;
  let answeredOffer = null;   // Fingerabdruck des beantworteten Angebots
  let streamReady = false;
  let timerInt = null;
  let joinedAtMs = null;
  let announcing = false;

  const startBtn = $('startCallBtn');
  const callAgainBtn = $('callAgainBtn');
  const hangupWaitingBtn = $('hangupWaitingBtn');
  const hangupConnectingBtn = $('hangupConnectingBtn');
  const hangupActiveBtn = $('hangupActiveBtn');
  const muteBtn = $('muteBtn');
  const announceMuteBtn = $('announceMuteBtn');
  let announceMuted = false;
  if (announceMuteBtn) {
    announceMuteBtn.addEventListener('click', () => {
      announceMuted = !announceMuted;
      announcer.setMuted(announceMuted);
      announceMuteBtn.textContent = announceMuted ? '🔇 Ansagen aus' : '🔊 Ansagen an';
    });
  }

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
    renderSupportHours($('supportHoursText'), st.supportHoursTable, st.supportHoursLabel || 'Jederzeit erreichbar');
    const closed = st.supportOpen === false;
    const closedBadge = $('closedBadge');
    if (closedBadge) closedBadge.classList.toggle('hidden', !closed);
    if (closed) {
      text('availabilityText', 'Derzeit geschlossen – unser Team ist außerhalb der Support-Zeiten nicht erreichbar.');
      startBtn.disabled = true;
      startBtn.textContent = '📞 Derzeit geschlossen';
    } else {
      text('availabilityText', st.available > 0
        ? `${st.available} Mitarbeiter derzeit verfügbar.`
        : 'Derzeit ist kein Mitarbeiter verfügbar – dein Anruf wird trotzdem in die Warteschleife gestellt.');
      startBtn.disabled = false;
      startBtn.textContent = '📞 Support anrufen';
    }
    if (st.call) {
      // Kein automatisches Verbinden beim Öffnen der Seite: Die Verbindung
      // startet erst, wenn der Anrufer "Support anrufen" klickt (bzw. ein
      // bestehender Anruf dann fortgesetzt wird).
      text('availabilityText', 'Du hast bereits einen laufenden Anruf – klicke auf „Support anrufen“, um ihn fortzusetzen.');
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
    if (!r.ok || !r.call) {
      if (r.reason === 'closed') {
        alert(r.closedLabel
          ? `${r.closedLabel} – der Support ist außerhalb der Zeiten nicht erreichbar.`
          : 'Der Support ist derzeit geschlossen.');
      } else {
        alert('Der Anruf konnte nicht gestartet werden. Bitte erneut versuchen.');
      }
      refreshIdle();
      return;
    }
    callId = r.call.id;
    joinedAtMs = Date.now();
    answeredOffer = null;
    showStage('waiting');
    startTimer();
    waitMusic.start();
    announcer.start({ queuePosition: 1, availableStaff: null });
    announcing = true;
    pollCall();
  }

  // Der Anrufer antwortet auf das Angebot des Mitarbeiters (answer).
  async function createAnswer(callId, offerSdp) {
    try {
      await CallManager.getStream();
      const pc = CallManager.createPeer();
      await pc.setRemoteDescription(JSON.parse(offerSdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await CallManager.waitGathering(pc, 6000);
      await post('/api/support/call/signal', { callId, role: 'answer', sdp: JSON.stringify(pc.localDescription) });
      CallManager.unmute();
    } catch (e) {
      console.error('Answer fehlgeschlagen:', e);
    }
  }

  function resetNegotiation() {
    CallManager.cleanup();
    answeredOffer = null;
    streamReady = false;
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
      // Zurueck in der Warteschlange (z. B. nach Weiterleitung) -> Verbindung zuruecksetzen.
      resetNegotiation();
      if (!announcing) { announcer.start(c); announcing = true; }
      else announcer.update(c);
      text('queuePositionText', `Ihre Position in der Warteschlange: ${c.queuePosition}.`);
      if (c.queueWaitMinutes) {
        const escNote = c.queueWaitEscalating
          ? ' Nur ein Mitarbeiter ist eingestempelt – die Wartezeit steigt um 1 Minute pro Warteminute.'
          : ' Steigt mit jeder wartenden Anfrage.';
        text('queueWaitText',
          `Geschätzte Wartezeit: ca. ${c.queueWaitMinutes} Minute${c.queueWaitMinutes === 1 ? '' : 'n'}.${escNote}`);
      } else {
        text('queueWaitText', '');
      }
      return;
    }
    if (c.status === 'ringing') {
      showStage('connecting');
      waitMusic.stop();
      stopTimer();
      announcer.stop();
      announcing = false;
      if (c.offer && answeredOffer !== c.offer) {
        answeredOffer = c.offer;
        await createAnswer(callId, c.offer);
      }
      return;
    }
    if (c.status === 'active') {
      showStage('active');
      waitMusic.stop();
      stopTimer();
      announcer.stop();
      announcing = false;
      if (c.staffName) {
        text('activeStaffName', `${c.staffName}${c.staffExtension ? ` (${c.staffExtension})` : ''}`);
      }
      CallManager.unmute();
      return;
    }
    if (c.status === 'timeout') {
      waitMusic.stop();
      stopTimer();
      announcer.stop();
      announcing = false;
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
      announcer.stop();
      announcing = false;
      text('endedTitle', 'Anruf beendet');
      text('endedText', c.endedReason || 'Vielen Dank für Ihren Anruf.');
      endCleanup();
      showStage('ended');
      return;
    }
  }

  function endCleanup() {
    callId = null;
    answeredOffer = null;
    streamReady = false;
    joinedAtMs = null;
    announcing = false;
    announcer.stop();
    CallManager.cleanup();
  }

  startBtn.addEventListener('click', startCall);
  callAgainBtn.addEventListener('click', () => { showStage('idle'); refreshIdle(); });
  hangupWaitingBtn.addEventListener('click', async () => {
    if (callId) await post('/api/support/call/end', { callId });
    waitMusic.stop();
    stopTimer();
    announcer.stop();
    announcing = false;
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
  muteBtn.title = 'Mikrofon ein- oder ausschalten';
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    CallManager.setMuted(muted);
    muteBtn.textContent = muted ? '🔇 Stummgeschaltet' : '🎤 Mikrofon an';
  });

  // Rauschunterdrückung (Anrufer-Seite): Standardmäßig an, lässt sich während
  // des Gesprächs umschalten (Tracks werden live ersetzt).
  const noiseBtn = $('noiseBtn');
  if (noiseBtn) {
    noiseBtn.title = 'Rauschunterdrückung ein- oder ausschalten';
    const applyNoiseLabel = () => {
      noiseBtn.textContent = CallManager.noiseSuppression
        ? '🎚️ Rauschunterdrückung: An'
        : '🎚️ Rauschunterdrückung: Aus';
    };
    applyNoiseLabel();
    noiseBtn.addEventListener('click', async () => {
      await CallManager.setNoiseSuppression(!CallManager.noiseSuppression);
      applyNoiseLabel();
    });
  }

  refreshIdle();
  setInterval(() => {
    if (callId) pollCall();
    else refreshIdle();
  }, POLL_MS);
})();
