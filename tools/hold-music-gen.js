'use strict';

// ---------------------------------------------------------------------------
// Generator fuer die Warteschleifen-Musik des Voice-Supports.
// Erzeugt eine fruehlich-aufmunternde Pop-Schleife (C - Am - F - G, "bleib
// dran"-Feel) mit sanftem Rhythmus (Kick + Hat), Basslinie, Arpeggio und
// einer kurzen Melodie, die das "Weiterhalten" unterstreicht. Nahtlose
// 40-Sekunden-Schleife als Mono-WAV unter public/audio/.
//
// Aufruf: node tools/hold-music-gen.js
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const SR = 22050;            // Abtastrate (Hz)
const BPM = 100;             // Tempo (aufmunternd, aber ruhig genug fuer Warteschleife)
const BEAT = 60 / BPM;       // Schlaglaenge (s)
const CHORD_BEATS = 8;       // Akkord-Dauer (in Schlaegen)
const FADE = 0.4;            // Ein-/Ausblendezeit fuer nahtlose Schleife

// A4 = 440 Hz
const f = (semis) => 440 * Math.pow(2, semis / 12);
const shiftFreq = (hz, semis) => hz * Math.pow(2, semis / 12);
const C3 = f(-12), D3 = f(-10), E3 = f(-8), F3 = f(-5), G3 = f(-3), A3 = f(-1), B3 = f(1);
const C4 = f(0), D4 = f(2), E4 = f(4), F4 = f(5), G4 = f(7), A4 = f(9), B4 = f(11);
const C5 = f(12), D5 = f(14), E5 = f(16), G5 = f(19), A5 = f(21);

// Pop-Progression: C - Am - F - G, zweimal fuer eine abwechslungsreiche Schleife.
const CHORDS = [
  { pad: [C4, E4, G4], arp: [C4, E4, G4, C5, E5, C5, G4, E4], bass: C3, mel: [E5, G5] },
  { pad: [A3, C4, E4], arp: [A3, C4, E4, A4, C5, A4, E4, C4], bass: A3, mel: [C5, E5] },
  { pad: [F3, A3, C4], arp: [F3, A3, C4, F4, A4, F4, C4, A3], bass: F3, mel: [A4, C5] },
  { pad: [G3, B3, D4], arp: [G3, B3, D4, G4, B4, G4, D4, B3], bass: G3, mel: [B4, D5] },
];

const DURATION = CHORD_BEATS * BEAT * CHORDS.length * 2; // 2x durch die Progression
const total = SR * DURATION;
const buf = new Float32Array(total);

// Sanfter Sinus mit zweiter Oberwelle (weicher, warmer Klang)
function tone(freq, t, dur, gain) {
  if (freq <= 0 || gain <= 0) return 0;
  const atk = Math.min(0.03, dur * 0.25);
  const rel = Math.min(0.08, dur * 0.4);
  let env = 1;
  if (t < atk) env = t / atk;
  else if (t > dur - rel) env = Math.max(0, (dur - t) / rel);
  return (Math.sin(2 * Math.PI * freq * t) + 0.15 * Math.sin(2 * Math.PI * freq * 2 * t)) * env * gain;
}

// Weicher Kick (abfallender Sinus), sehr leise
function kick(t, gain) {
  if (t < 0 || t > 0.18) return 0;
  const env = Math.exp(-t * 30);
  const freq = 90 + 70 * Math.exp(-t * 40);
  return Math.sin(2 * Math.PI * freq * t) * env * gain;
}

// Sanfte Hat (rauschen, schnell abklingend), sehr leise
function hat(t, gain) {
  if (t < 0 || t > 0.05) return 0;
  const env = Math.exp(-t * 120);
  // Deterministisches Pseudo-Rauschen, damit das WAV reproduzierbar ist
  const n = Math.sin(t * 9000) * 0.5 + Math.sin(t * 13500 + 1.7) * 0.3 + Math.sin(t * 17777 + 4.2) * 0.2;
  return n * env * gain;
}

// Einen Zeitpunkt (Sekunden) in die Buffer-Indexe umrechnen
function atSec(s) { return Math.floor(Math.max(0, s) * SR); }

function addTone(freq, tStart, dur, gain) {
  const start = atSec(tStart);
  const end = Math.min(atSec(tStart + dur), total);
  for (let i = start; i < end; i++) {
    buf[i] += tone(freq, i / SR - tStart, dur, gain);
  }
}

function addKick(tStart) { const i = atSec(tStart); if (i < total) buf[i] += kick(0.0005, 0.5); }
function addHat(tStart) { const i = atSec(tStart); if (i < total) buf[i] += hat(0.0005, 0.045); }

for (let round = 0; round < 2; round++) {
  for (let ci = 0; ci < CHORDS.length; ci++) {
    const ch = CHORDS[ci];
    const start = (round * CHORDS.length + ci) * CHORD_BEATS * BEAT;
    const chordDur = CHORD_BEATS * BEAT;

    // Pad (sustained, sehr leise, sanft ein-/ausgeblendet)
    for (let i = atSec(start + 0.02); i < atSec(start + chordDur - 0.02); i++) {
      const t = i / SR;
      const local = t - start;
      const padGain = 0.06 * Math.min(1, Math.max(0, (local - 0.25) / 0.7)) * Math.min(1, Math.max(0, (chordDur - local) / 0.7));
      let v = 0;
      for (const fr of ch.pad) v += tone(fr, local, chordDur, 1);
      buf[i] += v * padGain;
    }

    // Bass (Viertel + Achtel-Aufschlag am Ende, leicht treibend)
    for (let b = 0; b < CHORD_BEATS; b++) {
      const tStart = start + b * BEAT;
      // Leichter Basslauf: vor dem naechsten Akkord ein Achtel-Pickup
      const pickup = b === CHORD_BEATS - 1;
      if (pickup) addTone(ch.bass * 1.5, tStart - BEAT / 2, BEAT * 0.45, 0.075);
      addTone(ch.bass, tStart, BEAT * 0.85, 0.11);
    }

    // Arpeggio (Achtel, heller), im zweiten Durchgang eine Oktave hoeher
    const arpShift = round === 1 ? 12 : 0;
    for (let k = 0; k < ch.arp.length; k++) {
      const tStart = start + k * (BEAT / 2);
      const gain = k % 2 === 0 ? 0.10 : 0.07;
      addTone(shiftFreq(ch.arp[k], arpShift), tStart, BEAT * 0.42, gain);
    }

    // Melodie: kleines "Keep-Playing"-Motiv zu Beginn des Akkords
    for (let m = 0; m < ch.mel.length; m++) {
      const tStart = start + (round === 1 ? BEAT : 0) + m * BEAT;
      addTone(shiftFreq(ch.mel[m], round * 12), tStart, BEAT * 0.9, 0.09);
    }

    // Rhythmus: Kick auf 1+3, Hat auf den Offbeats (sehr dezent)
    for (let b = 0; b < CHORD_BEATS; b++) {
      if (b % 2 === 0) addKick(start + b * BEAT);
      addHat(start + b * BEAT + BEAT / 2);
    }
  }
}

// Nahtlose Schleife: Anfang und Ende gegeneinander ein-/ausblenden
const fadeN = Math.floor(FADE * SR);
for (let i = 0; i < fadeN; i++) {
  const g = i / fadeN;
  buf[i] *= g;
  buf[total - 1 - i] *= (1 - g);
}

// Normalisieren + leichter Sanft-Clipper (Kurzspitzen)
let peak = 0;
for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(buf[i]));
const norm = peak > 0.001 ? 0.55 / peak : 1;
for (let i = 0; i < total; i++) {
  buf[i] = Math.max(-1, Math.min(1, buf[i] * norm));
}

// WAV schreiben (16-bit PCM mono)
const pcm = Buffer.alloc(total * 2);
for (let i = 0; i < total; i++) {
  pcm.writeInt16LE(Math.round(buf[i] * 32767), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);            // fmt-chunk size
header.writeUInt16LE(1, 20);             // PCM
header.writeUInt16LE(1, 22);             // mono
header.writeUInt32LE(SR, 24);            // sample rate
header.writeUInt32LE(SR * 2, 28);        // byte rate
header.writeUInt16LE(2, 32);             // block align
header.writeUInt16LE(16, 34);            // bits per sample
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

const out = path.join(__dirname, '..', 'public', 'audio', 'hold-music.wav');
fs.writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`Warteschleifen-Popmusik geschrieben: ${out} (${(pcm.length / 1048576).toFixed(2)} MB, ${DURATION.toFixed(0)} s, ${SR} Hz)`);
