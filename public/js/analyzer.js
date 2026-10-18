// Full-mix analysis: loudness (BS.1770), true peak, spectral balance, stereo
// image, tempo, key, and section/arrangement structure.
// Input: { channels: Float32Array[], sampleRate }. Pure, no DOM access.

import {
  powerSpectrum, biquad, kWeightingFilters, db, dbAmp, percentile, mean, std,
} from './dsp.js';

export const PRODUCER_BANDS = [
  { id: 'sub', label: 'Sub', lo: 20, hi: 60 },
  { id: 'low', label: 'Low / kick & bass body', lo: 60, hi: 150 },
  { id: 'lowmid', label: 'Low-mids / mud zone', lo: 150, hi: 400 },
  { id: 'mid', label: 'Mids / vocal & instrument body', lo: 400, hi: 2000 },
  { id: 'presence', label: 'Presence / bite', lo: 2000, hi: 5000 },
  { id: 'brilliance', label: 'Brilliance / sibilance', lo: 5000, hi: 10000 },
  { id: 'air', label: 'Air', lo: 10000, hi: 20000 },
];

export const OCTAVE_CENTERS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Krumhansl–Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const SPEC_N = 8192;
const SPEC_HOP = 4096;
const ONSET_N = 2048;
const ONSET_HOP = 512;
const SPECTROGRAM_BANDS = 120;

export function analyzeTrack({ channels, sampleRate }, onProgress = () => {}) {
  const fs = sampleRate;
  const L = channels[0];
  const R = channels.length > 1 ? channels[1] : channels[0];
  const n = L.length;
  const duration = n / fs;
  if (duration < 5) throw new Error('Track is too short to analyze (need at least 5 seconds).');

  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mid[i] = 0.5 * (L[i] + R[i]);
    side[i] = 0.5 * (L[i] - R[i]);
  }

  onProgress(0.05, 'Measuring loudness (LUFS)…');
  const loudness = measureLoudness([L, R], fs);

  onProgress(0.2, 'Checking peaks & clipping…');
  const peaks = measurePeaks([L, R]);

  onProgress(0.3, 'Mapping the frequency spectrum…');
  const spectral = measureSpectrum(mid, side, fs, loudness);

  onProgress(0.55, 'Detecting tempo & groove…');
  const rhythm = measureRhythm(mid, fs);

  onProgress(0.75, 'Detecting key…');
  const key = detectKey(spectral.chroma);

  onProgress(0.85, 'Mapping song structure…');
  const structure = measureStructure(spectral, loudness, duration);

  const stereo = measureStereo(L, R, spectral);
  const edges = measureEdges(mid, fs);

  onProgress(1, 'Done');

  return {
    meta: { duration, sampleRate: fs, channels: channels.length },
    loudness: {
      integratedLufs: loudness.integrated,
      shortTermMaxLufs: loudness.shortTermMax,
      momentaryMaxLufs: loudness.momentaryMax,
      loudnessRangeLu: loudness.lra,
      shortTermCurve: loudness.shortTerm, // one value per second, LUFS
    },
    peaks: {
      samplePeakDbfs: peaks.samplePeak,
      truePeakDbtp: peaks.truePeak,
      clipEvents: peaks.clipEvents,
      dcOffset: peaks.dcOffset,
      plrDb: peaks.truePeak - loudness.integrated,
      punchCrestDb: spectral.punchCrestDb,
    },
    spectrum: {
      octaveBandsRelTo1k: spectral.octaveRel,
      producerBands: spectral.producerBands,
      centroidHz: spectral.centroid,
      tiltDbPerOctave: spectral.tilt,
      sibilanceSpikeDb: rhythm.sibilanceSpikeDb,
    },
    stereo,
    rhythm: {
      bpm: rhythm.bpm,
      bpmConfidence: rhythm.confidence,
      bpmCandidates: rhythm.candidates,
      onsetDensityPerSec: rhythm.onsetDensity,
    },
    key,
    structure,
    edges,
    // Raw data for visualization (not sent to the AI as numbers).
    viz: {
      spectrogram: spectral.spectrogram,
      spectrogramBands: SPECTROGRAM_BANDS,
      frameSeconds: SPEC_HOP / fs,
      bandFreqs: spectral.bandFreqs,
      avgSpectrum: spectral.avgSpectrumDb,
      avgSpectrumFreqs: spectral.avgSpectrumFreqs,
    },
  };
}

// ---------------- Loudness (ITU-R BS.1770-4 / EBU R128) ----------------

function measureLoudness(chs, fs) {
  const filters = kWeightingFilters(fs);
  const seg = Math.round(0.1 * fs);
  const nSeg = Math.floor(chs[0].length / seg);
  const segPower = new Float64Array(nSeg);
  for (const ch of chs) {
    const kw = biquad(biquad(ch, filters[0]), filters[1]);
    for (let s = 0; s < nSeg; s++) {
      let sum = 0;
      const off = s * seg;
      for (let i = 0; i < seg; i++) sum += kw[off + i] * kw[off + i];
      segPower[s] += sum / seg;
    }
  }
  const windowPowers = (len) => {
    const out = [];
    for (let s = 0; s + len <= nSeg; s++) {
      let sum = 0;
      for (let k = 0; k < len; k++) sum += segPower[s + k];
      out.push(sum / len);
    }
    return out;
  };
  const toLufs = (p) => -0.691 + db(p);

  const blocks = windowPowers(4); // 400 ms, 75% overlap
  const absGated = blocks.filter((p) => toLufs(p) > -70);
  let integrated = -70;
  if (absGated.length) {
    const relThresh = toLufs(mean(absGated)) - 10;
    const relGated = absGated.filter((p) => toLufs(p) > relThresh);
    integrated = toLufs(mean(relGated.length ? relGated : absGated));
  }
  const momentaryMax = blocks.length ? Math.max(...blocks.map(toLufs)) : -70;

  // Short-term (3 s) sampled every second for the timeline.
  const stAll = windowPowers(30);
  const shortTerm = [];
  for (let s = 0; s < stAll.length; s += 10) shortTerm.push(Math.max(-70, toLufs(stAll[s])));
  // Pad the tail so the curve covers the whole song.
  const totalSecs = Math.ceil(nSeg / 10);
  while (shortTerm.length < totalSecs) shortTerm.push(shortTerm.length ? shortTerm[shortTerm.length - 1] : -70);
  const shortTermMax = stAll.length ? Math.max(...stAll.map(toLufs)) : integrated;

  // Loudness range (EBU Tech 3342).
  const stAbs = stAll.filter((p) => toLufs(p) > -70);
  let lra = 0;
  if (stAbs.length > 2) {
    const rel = toLufs(mean(stAbs)) - 20;
    const vals = stAbs.map(toLufs).filter((v) => v > rel);
    lra = percentile(vals, 95) - percentile(vals, 10);
  }

  return { integrated, momentaryMax, shortTermMax, shortTerm, lra };
}

// ---------------- Peaks, true peak, clipping ----------------

const TP_PHASES = 4;
const TP_TAPS = 12; // per phase
const tpKernel = (() => {
  const total = TP_PHASES * TP_TAPS;
  const h = new Float64Array(total);
  const c = (total - 1) / 2;
  for (let i = 0; i < total; i++) {
    const x = (i - c) / TP_PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (total - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (total - 1));
    h[i] = sinc * w;
  }
  // Normalize each polyphase branch to unity DC gain.
  const phases = [];
  for (let p = 0; p < TP_PHASES; p++) {
    const branch = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) { branch[k] = h[k * TP_PHASES + p]; sum += branch[k]; }
    for (let k = 0; k < TP_TAPS; k++) branch[k] /= sum;
    phases.push(branch);
  }
  return phases;
})();

function measurePeaks(chs) {
  let samplePeak = 0;
  let truePeak = 0;
  let clipEvents = 0;
  let dcSum = 0;
  let count = 0;
  for (const ch of chs) {
    let run = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      dcSum += ch[i];
      count++;
      if (a > samplePeak) samplePeak = a;
      if (a >= 0.9995) { run++; if (run === 3) clipEvents++; } else run = 0;
      // Only oversample around hot samples: inter-sample peaks need a hot neighbourhood.
      if (a > 0.5 && i >= TP_TAPS && i < ch.length - TP_TAPS) {
        for (let p = 0; p < TP_PHASES; p++) {
          const branch = tpKernel[p];
          let y = 0;
          for (let k = 0; k < TP_TAPS; k++) y += ch[i - k + TP_TAPS / 2] * branch[k];
          const ay = Math.abs(y);
          if (ay > truePeak) truePeak = ay;
        }
      }
    }
  }
  truePeak = Math.max(truePeak, samplePeak);
  return {
    samplePeak: dbAmp(samplePeak),
    truePeak: dbAmp(truePeak),
    clipEvents,
    dcOffset: dcSum / count,
  };
}

// ---------------- Spectrum, chroma, spectrogram ----------------

function measureSpectrum(mid, side, fs, loudness) {
  const nFrames = Math.max(1, Math.floor((mid.length - SPEC_N) / SPEC_HOP) + 1);
  const nBins = SPEC_N / 2 + 1;
  const binHz = fs / SPEC_N;
  const re = new Float64Array(SPEC_N), im = new Float64Array(SPEC_N);
  const pMid = new Float64Array(nBins), pSide = new Float64Array(nBins);

  const sumMid = new Float64Array(nBins);
  const sumSide = new Float64Array(nBins);
  const chroma = new Float64Array(12);

  // Log-spaced spectrogram bands 30 Hz – 16 kHz.
  const fLo = 30, fHi = Math.min(16000, fs / 2 - 1);
  const bandFreqs = [];
  const bandBinEdges = [];
  for (let b = 0; b <= SPECTROGRAM_BANDS; b++) {
    const f = fLo * Math.pow(fHi / fLo, b / SPECTROGRAM_BANDS);
    bandBinEdges.push(Math.max(1, Math.round(f / binHz)));
    if (b < SPECTROGRAM_BANDS) bandFreqs.push(fLo * Math.pow(fHi / fLo, (b + 0.5) / SPECTROGRAM_BANDS));
  }
  const spectrogram = new Float32Array(nFrames * SPECTROGRAM_BANDS);

  const bandBins = PRODUCER_BANDS.map((b) => [Math.max(1, Math.ceil(b.lo / binHz)), Math.min(nBins - 1, Math.ceil(b.hi / binHz) - 1)]);
  const frameBandsMid = []; // per frame, producer band power (mid)
  const frameSideRatio = []; // per frame side/mid power ratio above 150 Hz
  const frameCentroid = [];
  const frameLevel = [];

  // Chroma bins: map FFT bins 80 Hz–4 kHz to pitch classes.
  const chromaMap = [];
  for (let k = Math.ceil(80 / binHz); k <= Math.floor(4000 / binHz); k++) {
    const f = k * binHz;
    const midi = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    const detune = Math.abs(midi - Math.round(midi)); // 0..0.5
    chromaMap.push([k, pc, Math.cos(Math.PI * detune) ** 2]);
  }

  for (let fr = 0; fr < nFrames; fr++) {
    const off = fr * SPEC_HOP;
    powerSpectrum(mid, off, SPEC_N, pMid, re, im);
    powerSpectrum(side, off, SPEC_N, pSide, re, im);

    let total = 0, weighted = 0, sideHi = 0, midHi = 0;
    for (let k = 1; k < nBins; k++) {
      total += pMid[k];
      weighted += pMid[k] * k * binHz;
      if (k * binHz > 150) { sideHi += pSide[k]; midHi += pMid[k]; }
    }
    frameLevel.push(db(total));
    frameCentroid.push(total > 0 ? weighted / total : 0);
    frameSideRatio.push(midHi > 0 ? sideHi / midHi : 0);
    frameBandsMid.push(bandBins.map(([a, b]) => { let s = 0; for (let k = a; k <= b; k++) s += pMid[k]; return s; }));

    for (let b = 0; b < SPECTROGRAM_BANDS; b++) {
      const a = bandBinEdges[b];
      const z = Math.max(a + 1, bandBinEdges[b + 1]);
      let s = 0;
      for (let k = a; k < z && k < nBins; k++) s += pMid[k] + pSide[k];
      spectrogram[fr * SPECTROGRAM_BANDS + b] = db(s / (z - a));
    }
  }

  // Long-term averages use only "active" frames (within 15 dB of the loudest),
  // so intros/outros/silence don't skew the balance.
  const levelGate = percentile(frameLevel, 98) - 15;
  let active = 0;
  for (let fr = 0; fr < nFrames; fr++) {
    if (frameLevel[fr] < levelGate) continue;
    active++;
    const off = fr * SPEC_HOP;
    powerSpectrum(mid, off, SPEC_N, pMid, re, im);
    powerSpectrum(side, off, SPEC_N, pSide, re, im);
    let frameChromaTotal = 0;
    const fc = new Float64Array(12);
    for (let k = 0; k < nBins; k++) { sumMid[k] += pMid[k]; sumSide[k] += pSide[k]; }
    for (const [k, pc, w] of chromaMap) { const v = Math.sqrt(pMid[k]) * w; fc[pc] += v; frameChromaTotal += v; }
    if (frameChromaTotal > 0) for (let c = 0; c < 12; c++) chroma[c] += fc[c] / frameChromaTotal;
  }
  if (active) for (let k = 0; k < nBins; k++) { sumMid[k] /= active; sumSide[k] /= active; }

  // Half-open [lo, hi) so adjacent bands never double-count a bin.
  const bandPower = (arr, lo, hi) => {
    let s = 0;
    for (let k = Math.max(1, Math.ceil(lo / binHz)); k < nBins && k * binHz < hi; k++) s += arr[k];
    return s;
  };

  const octave = OCTAVE_CENTERS.map((fc) => ({ hz: fc, power: bandPower(sumMid, fc / Math.SQRT2, fc * Math.SQRT2) + bandPower(sumSide, fc / Math.SQRT2, fc * Math.SQRT2) }));
  const ref1k = octave.find((o) => o.hz === 1000).power;
  const octaveRel = octave.map((o) => ({ hz: o.hz, db: round1(db(o.power) - db(ref1k)) }));

  const totalPower = bandPower(sumMid, 20, 20000) + bandPower(sumSide, 20, 20000);
  const producerBands = PRODUCER_BANDS.map((b) => {
    const m = bandPower(sumMid, b.lo, b.hi);
    const s = bandPower(sumSide, b.lo, b.hi);
    return {
      id: b.id,
      label: b.label,
      range: `${b.lo}–${b.hi} Hz`,
      sharePct: round1((100 * (m + s)) / totalPower),
      levelDb: round1(db(m + s) - db(totalPower)),
      sideToMidDb: round1(db(s) - db(m)),
    };
  });

  // Spectral tilt: least-squares slope of octave levels 125 Hz – 8 kHz.
  const tiltPts = octaveRel.filter((o) => o.hz >= 125 && o.hz <= 8000);
  const xs = tiltPts.map((o) => Math.log2(o.hz));
  const ys = tiltPts.map((o) => o.db);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const tilt = round1(num / den);

  let cTot = 0, cW = 0;
  for (let k = 1; k < nBins; k++) { cTot += sumMid[k]; cW += sumMid[k] * k * binHz; }

  // Averaged spectrum (1/6-octave smoothed) for plotting.
  const avgSpectrumFreqs = [];
  const avgSpectrumDb = [];
  for (let f = 25; f < Math.min(20000, fs / 2); f *= Math.pow(2, 1 / 6)) {
    const p = bandPower(sumMid, f / Math.pow(2, 1 / 12), f * Math.pow(2, 1 / 12)) + bandPower(sumSide, f / Math.pow(2, 1 / 12), f * Math.pow(2, 1 / 12));
    avgSpectrumFreqs.push(Math.round(f));
    avgSpectrumDb.push(round1(db(p) - db(ref1k)));
  }

  // Punch: median peak-to-RMS crest factor of 400 ms windows in the loudest sections.
  const punchCrestDb = measurePunch(mid, fs, loudness);

  return {
    octaveRel, producerBands, tilt,
    centroid: Math.round(cTot > 0 ? cW / cTot : 0),
    chroma: Array.from(chroma),
    spectrogram, bandFreqs, avgSpectrumDb, avgSpectrumFreqs,
    frameBandsMid, frameSideRatio, frameCentroid, frameLevel,
    frameSeconds: SPEC_HOP / fs,
    punchCrestDb,
  };
}

function measurePunch(mid, fs, loudness) {
  const win = Math.round(0.4 * fs);
  const crests = [];
  const loudSec = loudness.shortTerm;
  const gate = percentile(loudSec, 70);
  for (let off = 0; off + win < mid.length; off += win) {
    const sec = Math.floor(off / fs);
    if (loudSec[sec] === undefined || loudSec[sec] < gate) continue;
    let peak = 0, sum = 0;
    for (let i = off; i < off + win; i++) {
      const a = Math.abs(mid[i]);
      if (a > peak) peak = a;
      sum += mid[i] * mid[i];
    }
    const rms = Math.sqrt(sum / win);
    if (rms > 1e-5) crests.push(dbAmp(peak / rms));
  }
  return round1(crests.length ? percentile(crests, 50) : 0);
}

// ---------------- Rhythm: tempo, onset density, sibilance ----------------

function measureRhythm(mid, fs) {
  const nFrames = Math.max(1, Math.floor((mid.length - ONSET_N) / ONSET_HOP) + 1);
  const nBins = ONSET_N / 2 + 1;
  const binHz = fs / ONSET_N;
  const re = new Float64Array(ONSET_N), im = new Float64Array(ONSET_N);
  const p = new Float64Array(nBins);
  let prev = new Float64Array(nBins);
  let cur = new Float64Array(nBins);
  const flux = new Float64Array(nFrames);
  const sib = [];
  const sibLo = Math.floor(5000 / binHz), sibHi = Math.min(nBins - 1, Math.ceil(9000 / binHz));
  const frameEnergy = new Float64Array(nFrames);

  for (let fr = 0; fr < nFrames; fr++) {
    powerSpectrum(mid, fr * ONSET_HOP, ONSET_N, p, re, im);
    let f = 0, e = 0, s = 0;
    for (let k = 1; k < nBins; k++) {
      cur[k] = Math.log1p(1000 * Math.sqrt(p[k]));
      const d = cur[k] - prev[k];
      if (d > 0) f += d;
      e += p[k];
      if (k >= sibLo && k <= sibHi) s += p[k];
    }
    flux[fr] = f;
    frameEnergy[fr] = e;
    sib.push(s);
    const t = prev; prev = cur; cur = t;
  }

  // Normalize: subtract local mean (≈0.5 s), half-wave rectify.
  const rate = fs / ONSET_HOP;
  const w = Math.round(rate * 0.25);
  const onset = new Float64Array(nFrames);
  let acc = 0;
  for (let i = 0; i < nFrames; i++) {
    acc += flux[i];
    if (i - 2 * w - 1 >= 0) acc -= flux[i - 2 * w - 1];
    const center = i - w;
    if (center >= 0) {
      const count = Math.min(i + 1, 2 * w + 1);
      onset[center] = Math.max(0, flux[center] - acc / count);
    }
  }

  // Onset density: peaks above an adaptive threshold.
  const thr = mean(onset) + std(onset);
  let peaks = 0;
  for (let i = 1; i < nFrames - 1; i++) if (onset[i] > thr && onset[i] >= onset[i - 1] && onset[i] > onset[i + 1]) peaks++;

  // Autocorrelation tempo with harmonic comb and a pop-friendly prior around ~118 BPM.
  const minBpm = 60, maxBpm = 200;
  const maxLag = Math.ceil((rate * 60) / minBpm) * 4;
  const ac = new Float64Array(maxLag + 1);
  const limit = Math.min(nFrames, Math.round(rate * 240)); // first 4 minutes is plenty
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < limit; i++) s += onset[i] * onset[i + lag];
    ac[lag] = s / (limit - lag);
  }
  const acAt = (lag) => {
    const l0 = Math.floor(lag), frac = lag - l0;
    if (l0 + 1 > maxLag) return 0;
    return ac[l0] * (1 - frac) + ac[l0 + 1] * frac;
  };
  const scores = [];
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
    const lag = (rate * 60) / bpm;
    let comb = 0;
    for (let h = 1; h <= 4; h++) comb += acAt(lag * h) / h;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 118) / 0.9) ** 2);
    scores.push({ bpm, score: comb * prior });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const meanScore = mean(scores.map((s) => s.score));
  const candidates = [];
  for (const s of scores) {
    if (candidates.every((c) => Math.abs(c.bpm - s.bpm) > 3)) candidates.push({ bpm: Math.round(s.bpm), strength: round2(s.score / best.score) });
    if (candidates.length === 3) break;
  }

  // Sibilance: how far the loudest 5–9 kHz bursts poke above typical level, on active frames.
  // Measured relative to each frame's total energy so loud passages don't read as sibilance.
  const eGate = percentile(Array.from(frameEnergy), 50);
  const sibRatios = sib.map((v, i) => v / (frameEnergy[i] || 1)).filter((_, i) => frameEnergy[i] > eGate);
  const sibMedian = percentile(sibRatios, 50);
  const sibilanceSpikeDb = sibRatios.length && sibMedian > 1e-5
    ? round1(db(percentile(sibRatios, 99.5)) - db(sibMedian))
    : 0;

  return {
    bpm: Math.round(best.bpm),
    confidence: round2(Math.min(1, (best.score / (meanScore || 1) - 1) / 3)),
    candidates,
    onsetDensity: round2(peaks / (nFrames / rate)),
    sibilanceSpikeDb,
  };
}

// ---------------- Key ----------------

function correlate(a, b) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    dbb += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * dbb || 1);
}

export function detectKey(chroma) {
  const results = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
      const rotated = profile.map((_, i) => profile[(i - tonic + 12) % 12]);
      results.push({ tonic, mode, r: correlate(chroma, rotated) });
    }
  }
  results.sort((a, b) => b.r - a.r);
  const best = results[0];
  const name = `${NOTE_NAMES[best.tonic]} ${best.mode}`;
  const relTonic = best.mode === 'major' ? (best.tonic + 9) % 12 : (best.tonic + 3) % 12;
  const relative = `${NOTE_NAMES[relTonic]} ${best.mode === 'major' ? 'minor' : 'major'}`;
  const camelot = camelotCode(best.tonic, best.mode);
  return {
    name,
    tonic: NOTE_NAMES[best.tonic],
    mode: best.mode,
    relative,
    camelot,
    confidence: round2(Math.max(0, Math.min(1, (best.r - results[1].r) * 5 + best.r * 0.3))),
    alternatives: results.slice(1, 3).map((r) => `${NOTE_NAMES[r.tonic]} ${r.mode}`),
    chroma: chroma.map((v) => round2(v / Math.max(...chroma))),
  };
}

function camelotCode(tonic, mode) {
  // Camelot wheel: 8B = C major, 5A = C minor.
  const majorOrder = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
  const minorOrder = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
  return mode === 'major' ? `${majorOrder[tonic]}B` : `${minorOrder[tonic]}A`;
}

// ---------------- Structure / arrangement ----------------

function measureStructure(spectral, loudness, duration) {
  const secs = Math.floor(duration);
  const fps = 1 / spectral.frameSeconds;
  // Per-second features: producer band levels, width, brightness, loudness.
  const feats = [];
  const perSec = [];
  for (let s = 0; s < secs; s++) {
    const a = Math.floor(s * fps), b = Math.max(a + 1, Math.floor((s + 1) * fps));
    const bands = PRODUCER_BANDS.map(() => 0);
    let side = 0, cent = 0, cnt = 0;
    for (let f = a; f < b && f < spectral.frameBandsMid.length; f++) {
      spectral.frameBandsMid[f].forEach((v, i) => { bands[i] += v; });
      side += spectral.frameSideRatio[f];
      cent += spectral.frameCentroid[f];
      cnt++;
    }
    if (!cnt) break;
    const lufs = loudness.shortTerm[s] ?? -70;
    const width = Math.max(-40, db(side / cnt));
    const bright = cent / cnt;
    perSec.push({ lufs, width, bright });
    feats.push([...bands.map((v) => db(v / cnt)), width, lufs * 2]);
  }
  const N = feats.length;
  const dims = feats[0]?.length ?? 0;

  // z-normalize features.
  for (let d = 0; d < dims; d++) {
    const col = feats.map((f) => f[d]);
    const m = mean(col), sd = std(col) || 1;
    feats.forEach((f) => { f[d] = (f[d] - m) / sd; });
  }

  // Foote checkerboard novelty on the cosine self-similarity matrix.
  const norm = feats.map((f) => Math.sqrt(f.reduce((s, v) => s + v * v, 0)) || 1);
  const sim = (i, j) => { let s = 0; for (let d = 0; d < dims; d++) s += feats[i][d] * feats[j][d]; return s / (norm[i] * norm[j]); };
  const K = 6;
  const novelty = new Float64Array(N);
  for (let c = K; c < N - K; c++) {
    let s = 0;
    for (let i = -K; i < K; i++) {
      for (let j = -K; j < K; j++) {
        const sign = (i < 0) === (j < 0) ? 1 : -1;
        const g = Math.exp(-((i + 0.5) ** 2 + (j + 0.5) ** 2) / (2 * (K / 2) ** 2));
        s += sign * g * sim(c + i, c + j);
      }
    }
    novelty[c] = Math.max(0, s);
  }
  const nArr = Array.from(novelty);
  const nThr = mean(nArr) + 0.4 * std(nArr);
  const boundaries = [0];
  const MIN_SECTION = 7;
  const peakIdx = [];
  for (let i = 1; i < N - 1; i++) if (novelty[i] > nThr && novelty[i] >= novelty[i - 1] && novelty[i] >= novelty[i + 1]) peakIdx.push(i);
  peakIdx.sort((a, b) => novelty[b] - novelty[a]);
  for (const p of peakIdx) if (boundaries.every((b) => Math.abs(b - p) >= MIN_SECTION) && N - p >= MIN_SECTION / 2) boundaries.push(p);
  boundaries.sort((a, b) => a - b);
  boundaries.push(N);

  const loudMax = percentile(perSec.map((p) => p.lufs), 97);
  const sections = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i], b = boundaries[i + 1];
    const slice = perSec.slice(a, b);
    const vec = new Array(dims).fill(0);
    for (let s = a; s < b; s++) for (let d = 0; d < dims; d++) vec[d] += feats[s][d] / (b - a);
    const lufs = mean(slice.map((p) => p.lufs));
    const energy = lufs >= loudMax - 2.5 ? 'high' : lufs < loudMax - 8 ? 'low' : 'mid';
    sections.push({
      start: a, end: b,
      startLabel: mmss(a), endLabel: mmss(b),
      avgLufs: round1(lufs),
      energy,
      widthDb: round1(mean(slice.map((p) => p.width))),
      brightnessHz: Math.round(mean(slice.map((p) => p.bright))),
      vec,
    });
  }

  // Label repeated material: sections whose mean feature vectors are close share a letter.
  const letters = 'ABCDEFGHIJKLMNOP';
  const groups = [];
  for (const s of sections) {
    let assigned = null;
    for (const g of groups) {
      const d = Math.sqrt(s.vec.reduce((acc, v, i) => acc + (v - g.vec[i]) ** 2, 0) / dims);
      if (d < 0.45) { assigned = g; break; }
    }
    if (!assigned) { assigned = { letter: letters[groups.length % letters.length], vec: s.vec }; groups.push(assigned); }
    s.pattern = assigned.letter;
    delete s.vec;
  }
  // Guess pop roles from energy and position.
  sections.forEach((s, i) => {
    if (i === 0 && s.energy !== 'high') s.guess = 'Intro';
    else if (i === sections.length - 1 && s.energy !== 'high') s.guess = 'Outro';
    else if (s.energy === 'high') s.guess = 'Chorus / drop';
    else if (s.energy === 'mid' && sections[i + 1]?.energy === 'high') s.guess = 'Pre-chorus / build';
    else if (s.energy === 'low' && i > 0 && i < sections.length - 1) s.guess = 'Breakdown / bridge';
    else s.guess = 'Verse';
  });

  const high = sections.filter((s) => s.energy === 'high');
  const body = sections.filter((s) => s.energy !== 'high' && s.guess !== 'Intro' && s.guess !== 'Outro');
  const notHigh = body.length ? body : sections.filter((s) => s.energy !== 'high');
  const firstHigh = high[0];
  const firstHookSec = firstHigh ? firstHigh.start : null;
  const lift = high.length && notHigh.length ? round1(mean(high.map((s) => s.avgLufs)) - mean(notHigh.map((s) => s.avgLufs))) : null;
  const widthLift = high.length && notHigh.length ? round1(mean(high.map((s) => s.widthDb)) - mean(notHigh.map((s) => s.widthDb))) : null;
  const brightLift = high.length && notHigh.length ? Math.round(mean(high.map((s) => s.brightnessHz)) - mean(notHigh.map((s) => s.brightnessHz))) : null;

  const curve = perSec.map((p) => p.lufs).filter((v) => v > -60);
  const introSec = (() => {
    const thr = loudMax - 6;
    const idx = perSec.findIndex((p) => p.lufs >= thr);
    return idx < 0 ? 0 : idx;
  })();

  return {
    sections,
    sectionCount: sections.length,
    firstHookSec,
    firstHookLabel: firstHookSec === null ? 'none detected' : mmss(firstHookSec),
    introSec,
    chorusLiftLu: lift,
    chorusWidthLiftDb: widthLift,
    chorusBrightnessLiftHz: brightLift,
    energyVariationLu: round1(std(curve)),
    distinctPatterns: groups.length,
  };
}

// ---------------- Stereo ----------------

function measureStereo(L, R, spectral) {
  let lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < L.length; i += 2) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; }
  const correlation = round2(lr / Math.sqrt(ll * rr || 1));
  const balanceDb = round1(db(ll) - db(rr));
  const sub = spectral.producerBands.find((b) => b.id === 'sub');
  const low = spectral.producerBands.find((b) => b.id === 'low');
  const highBands = spectral.producerBands.filter((b) => ['presence', 'brilliance', 'air', 'mid'].includes(b.id));
  return {
    correlation,
    balanceLrDb: balanceDb,
    isMono: correlation > 0.995,
    lowEndSideToMidDb: round1(Math.max(sub.sideToMidDb, low.sideToMidDb)),
    highSideToMidDb: round1(mean(highBands.map((b) => b.sideToMidDb))),
  };
}

// ---------------- Edges (silence at start/end) ----------------

function measureEdges(mid, fs) {
  const thr = Math.pow(10, -60 / 20);
  let head = 0;
  while (head < mid.length && Math.abs(mid[head]) < thr) head++;
  let tail = mid.length - 1;
  while (tail > 0 && Math.abs(mid[tail]) < thr) tail--;
  return {
    leadingSilenceSec: round2(head / fs),
    trailingSilenceSec: round2((mid.length - 1 - tail) / fs),
  };
}

// ---------------- utils ----------------

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }
export function mmss(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Compact, AI-friendly summary (drops raw visualization arrays).
export function summarizeForAI(a) {
  const { viz, ...rest } = a;
  const curve = a.loudness.shortTermCurve;
  // Downsample the loudness curve to one value every 4 s to keep the prompt tight.
  const curve4 = [];
  for (let i = 0; i < curve.length; i += 4) curve4.push(`${mmss(i)} ${round1(curve[i])}`);
  return {
    ...rest,
    loudness: { ...rest.loudness, shortTermCurve: undefined, shortTermCurveEvery4s: curve4 },
    key: { ...rest.key, chroma: undefined },
  };
}
