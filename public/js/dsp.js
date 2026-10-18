// Low-level DSP building blocks. Pure functions over Float32Arrays so they run
// identically in the browser and in Node (for tests).

// ---------- FFT (radix-2, in-place, real input via complex buffers) ----------

const fftCache = new Map();

function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const levels = Math.log2(n);
  if (!Number.isInteger(levels)) throw new Error(`FFT size must be a power of 2, got ${n}`);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  fftCache.set(n, t);
  return t;
}

export function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >>> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step];
        const s = sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * c + im[b] * s;
        const ti = im[b] * c - re[b] * s;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

const windowCache = new Map();

export function hann(n) {
  let w = windowCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    windowCache.set(n, w);
  }
  return w;
}

// Power spectrum (|X|^2, bins 0..n/2) of signal[offset .. offset+n), Hann windowed.
export function powerSpectrum(signal, offset, n, out, re, im) {
  const w = hann(n);
  for (let i = 0; i < n; i++) {
    const idx = offset + i;
    re[i] = idx < signal.length ? signal[idx] * w[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
  for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

// ---------- Biquad ----------

export function biquad(input, { b0, b1, b2, a1, a2 }) {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
  }
  return out;
}

// ITU-R BS.1770 K-weighting (stage 1 high shelf + stage 2 RLB high-pass),
// coefficients derived for any sample rate.
export function kWeightingFilters(fs) {
  const shelf = (() => {
    const G = 4.0, Q = 1 / Math.SQRT2, fc = 1500;
    const A = Math.pow(10, G / 40);
    const w0 = (2 * Math.PI * fc) / fs;
    const alpha = Math.sin(w0) / (2 * Q);
    const c = Math.cos(w0), sA = Math.sqrt(A);
    const a0 = (A + 1) - (A - 1) * c + 2 * sA * alpha;
    return {
      b0: (A * ((A + 1) + (A - 1) * c + 2 * sA * alpha)) / a0,
      b1: (-2 * A * ((A - 1) + (A + 1) * c)) / a0,
      b2: (A * ((A + 1) + (A - 1) * c - 2 * sA * alpha)) / a0,
      a1: (2 * ((A - 1) - (A + 1) * c)) / a0,
      a2: ((A + 1) - (A - 1) * c - 2 * sA * alpha) / a0,
    };
  })();
  const highpass = (() => {
    const fc = 38, Q = 0.5;
    const w0 = (2 * Math.PI * fc) / fs;
    const alpha = Math.sin(w0) / (2 * Q);
    const c = Math.cos(w0);
    const a0 = 1 + alpha;
    return {
      b0: (1 + c) / 2 / a0,
      b1: -(1 + c) / a0,
      b2: (1 + c) / 2 / a0,
      a1: (-2 * c) / a0,
      a2: (1 - alpha) / a0,
    };
  })();
  return [shelf, highpass];
}

// ---------- Small stats helpers ----------

export const db = (power) => 10 * Math.log10(Math.max(power, 1e-20));
export const dbAmp = (amp) => 20 * Math.log10(Math.max(amp, 1e-10));

export function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = Float64Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, (p / 100) * (sorted.length - 1)));
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function mean(values) {
  let s = 0;
  for (const v of values) s += v;
  return values.length ? s / values.length : NaN;
}

export function std(values) {
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return values.length ? Math.sqrt(s / values.length) : NaN;
}
