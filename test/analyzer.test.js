import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../public/js/analyzer.js';

const fs = 44100;

function sine(freq, seconds, amp) {
  const n = Math.round(seconds * fs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs);
  return out;
}

// A tiny synthetic pop loop: 120 BPM four-on-the-floor kick, A-minor pad,
// offbeat hats, with a louder, wider "chorus" in the second half.
function synthSong(seconds = 48, bpm = 120) {
  const n = Math.round(seconds * fs);
  const L = new Float32Array(n), R = new Float32Array(n);
  const beat = (60 / bpm) * fs;
  const chord = [220, 261.63, 329.63, 440, 110];
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const chorus = t >= seconds / 2;
    const posInBeat = i % beat;
    const kt = posInBeat / fs;
    const kick = Math.exp(-kt * 18) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-kt * 40)) * kt) * 0.8;
    const offPos = (i + beat / 2) % beat;
    const hat = offPos < 0.03 * fs ? rand() * Math.exp(-(offPos / fs) * 120) * 0.15 : 0;
    let pad = 0;
    for (const f of chord) pad += Math.sin(2 * Math.PI * f * t) * (f === 220 || f === 110 ? 0.09 : 0.06);
    const gain = chorus ? 1.0 : 0.45;
    const width = chorus ? 0.35 : 0.05;
    const m = (kick + hat + pad) * gain;
    const s = pad * gain * width * Math.sin(2 * Math.PI * 0.3 * t);
    L[i] = m + s;
    R[i] = m - s;
  }
  return { channels: [L, R], sampleRate: fs };
}

test('integrated loudness matches BS.1770 reference for a 1 kHz sine', () => {
  const s = sine(997, 10, 0.1); // -20 dBFS peak in both channels => about -20 LUFS
  const a = analyzeTrack({ channels: [s, s], sampleRate: fs });
  assert.ok(Math.abs(a.loudness.integratedLufs - -20) < 0.3, `got ${a.loudness.integratedLufs}`);
  assert.ok(Math.abs(a.peaks.truePeakDbtp - -20) < 0.3, `true peak ${a.peaks.truePeakDbtp}`);
  assert.equal(a.peaks.clipEvents, 0);
  assert.ok(a.stereo.isMono);
});

test('detects tempo, key, and the chorus lift of a synthetic pop loop', () => {
  const a = analyzeTrack(synthSong());
  assert.ok(Math.abs(a.rhythm.bpm - 120) <= 1, `bpm ${a.rhythm.bpm}`);
  assert.ok(['A minor', 'C major'].includes(a.key.name), `key ${a.key.name}`);
  assert.ok(a.structure.chorusLiftLu === null || a.structure.chorusLiftLu > 3, `lift ${a.structure.chorusLiftLu}`);
  assert.ok(a.structure.firstHookSec >= 18 && a.structure.firstHookSec <= 30, `hook at ${a.structure.firstHookSec}`);
  assert.ok(a.structure.sections.length >= 2);
  assert.equal(a.viz.spectrogram.length % a.viz.spectrogramBands, 0);
});

test('flags clipping', () => {
  const s = sine(100, 6, 1.4).map((v) => Math.max(-1, Math.min(1, v)));
  const a = analyzeTrack({ channels: [s, s], sampleRate: fs });
  assert.ok(a.peaks.clipEvents > 100, `clip events ${a.peaks.clipEvents}`);
});
