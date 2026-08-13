'use strict';

// ---------------------------------------------------------------------------
// Generator fuer die Warteschleifen-Musik des Voice-Supports.
// Erzeugt eine ruhige, angenehme 24-Sekunden-Schleife (C-Dur-Akkordfolge mit
// sanftem Pad + Arpeggio + Bass) als Mono-WAV unter public/audio/.
//
// Aufruf: node tools/hold-music-gen.js
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const SR = 22050;            // Abtastrate (Hz)
const DURATION = 24;         // Schleifenlaenge (Sekunden)
const BPM = 84;              // Tempo (durchgaengiges, ruhiges Gefuehl)
const BEAT = 60 / BPM;       // Schlaglaenge (s)
const CHORD_SEC = 4;         // Akkord-Dauer (s)
const FADE = 0.5;            // Ein-/Ausblendezeit fuer nahtlose Schleife

// A4 = 440 Hz
const f = (semis) => 440 * Math.pow(2, semis / 12);
const C4 = f(0), D4 = f(2), E4 = f(4), F4 = f(5), G4 = f(7), A4 = f(9), B4 = f(11), C5 = f(12), E5 = f(16);
const A3 = f(-12), B3 = f(-10), C3 = f(-24), D3 = f(-22), E3 = f(-20), F3 = f(-19), G3 = f(-17);
const A2 = f(-24), F2 = f(-31), G2 = f(-29);

// Akkordfolge: [Pad-Töne (Akkord), Arpeggio-Töne (aufsteigend/absteigend), Bass]
const CHORDS = [
  { pad: [C4, E4, G4], arp: [C4, E4, G4, C5, G4, E4], bass: C3 },
  { pad: [A3, C4, E4], arp: [A3, C4, E4, A4, E4, C4], bass: A2 },
  { pad: [F3, A3, C4], arp: [F3, A3, C4, F4, C4, A3], bass: F2 },
  { pad: [G3, B3, D4], arp: [G3, B3, D4, G4, D4, B3], bass: G2 },
  { pad: [C4, E4, G4], arp: [E4, G4, C5, E5, C5, G4], bass: C3 },
  { pad: [A3, C4, E4], arp: [C4, E4, A4, C5, A4, E4], bass: A2 },
];

const total = SR * DURATION;
const buf = new Float32Array(total);

// Sinus mit soften Obertönen (klangvoll, nicht "beep-artig")
function tone(freq, t, dur, gain) {
  if (freq <= 0 || gain <= 0 || t >= DURATION) return 0;
  const atk = Math.min(0.04, dur * 0.3);
  const rel = Math.min(0.12, dur * 0.5);
  let env = 1;
  if (t < atk) env = t / atk;
  else if (t > dur - rel) env = Math.max(0, (dur - t) / rel);
  // Grundton + leichte zweite Oberwelle -> weicher, warmer Klang
  let v = Math.sin(2 * Math.PI * freq * t) + 0.18 * Math.sin(2 * Math.PI * freq * 2 * t);
  return v * env * gain;
}

for (let ci = 0; ci < CHORDS.length; ci++) {
  const ch = CHORDS[ci];
  const start = ci * CHORD_SEC;
  const end = start + CHORD_SEC;

  // Pad (sustained, sehr leise)
  for (let i = Math.floor(start * SR); i < Math.min(end * SR, total); i++) {
    const t = i / SR;
    const local = t - start;
    const padGain = 0.075 * Math.min(1, Math.max(0, (local - 0.3) / 0.8)) * Math.min(1, Math.max(0, (CHORD_SEC - local) / 0.8));
    let v = 0;
    for (const fr of ch.pad) v += tone(fr, t, CHORD_SEC, 1);
    buf[i] += v * padGain;
    v = tone(ch.bass / 2, t, CHORD_SEC, 1); // sub-harmonischer Bass
    buf[i] += v * 0.05 * padGain;
  }

  // Arpeggio (8tel-artige Tonfolge, weich)
  const step = BEAT / 2;
  for (let k = 0; k < ch.arp.length; k++) {
    const tStart = start + k * step;
    const dur = step * 1.6;
    const gain = 0.16 * (k % 2 === 0 ? 1 : 0.75); // Akzente auf den ersten Takt
    for (let i = Math.floor(tStart * SR); i < Math.min((tStart + dur) * SR, total); i++) {
      const t = i / SR;
      buf[i] += tone(ch.arp[k], t, dur, gain);
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
const norm = peak > 0.001 ? 0.5 / peak : 1;
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
console.log(`Warteschleifen-Musik geschrieben: ${out} (${(pcm.length / 1048576).toFixed(2)} MB, ${DURATION} s, ${SR} Hz)`);
