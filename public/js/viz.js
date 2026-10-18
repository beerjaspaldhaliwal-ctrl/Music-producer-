// Canvas renderers: spectrogram + loudness curve + section map, and tonal balance.
import { tonalComparison } from './coach.js';
import { mmss } from './analyzer.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function parseColor(c) {
  if (c.startsWith('#')) return hexToRgb(c);
  const m = c.match(/\d+(\.\d+)?/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}

// Sequential single-hue ramp: surface (quiet) -> blue (loud), with a bright top step.
function buildRamp(dark) {
  const stops = dark
    ? ['#1a1a19', '#104281', '#2a78d6', '#86b6ef', '#e8f1fd']
    : ['#fcfcfb', '#cde2fb', '#6da7ec', '#1c5cab', '#0d366b'];
  const rgb = stops.map(hexToRgb);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (rgb.length - 1);
    const a = Math.floor(t), b = Math.min(rgb.length - 1, a + 1), f = t - a;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = rgb[a][c] + (rgb[b][c] - rgb[a][c]) * f;
  }
  return lut;
}

function isDark() {
  const bg = parseColor(css('--surface-1') || '#fcfcfb');
  return bg[0] + bg[1] + bg[2] < 300;
}

function fitCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: cssHeight };
}

/**
 * Draws the spectrogram. Pass { width, height, dark } to render off-screen (for the AI image).
 * Returns geometry used for hit-testing.
 */
export function drawSpectrogram(canvas, analysis, opts = {}) {
  const { spectrogram, spectrogramBands: B, frameSeconds, bandFreqs } = analysis.viz;
  const frames = spectrogram.length / B;
  const offscreen = Boolean(opts.width);
  let ctx, w, h;
  if (offscreen) {
    canvas.width = opts.width; canvas.height = opts.height;
    ctx = canvas.getContext('2d'); w = opts.width; h = opts.height;
  } else {
    ({ ctx, w, h } = fitCanvas(canvas, 260));
  }
  const dark = opts.dark ?? isDark();
  const lut = buildRamp(dark);
  const axisW = 40;
  const plotW = w - axisW;
  const plotH = h - 18;

  let max = -Infinity;
  for (let i = 0; i < spectrogram.length; i++) if (spectrogram[i] > max) max = spectrogram[i];
  const floor = max - 75;

  // Render at native resolution into an ImageData, then scale.
  const img = new ImageData(frames, B);
  for (let f = 0; f < frames; f++) {
    for (let b = 0; b < B; b++) {
      const v = Math.max(0, Math.min(1, (spectrogram[f * B + b] - floor) / (max - floor)));
      const idx = Math.round(Math.pow(v, 1.3) * 255);
      const p = ((B - 1 - b) * frames + f) * 4;
      img.data[p] = lut[idx * 3];
      img.data[p + 1] = lut[idx * 3 + 1];
      img.data[p + 2] = lut[idx * 3 + 2];
      img.data[p + 3] = 255;
    }
  }
  const tmp = document.createElement('canvas');
  tmp.width = frames; tmp.height = B;
  tmp.getContext('2d').putImageData(img, 0, 0);
  const bg = dark ? '#1a1a19' : '#fcfcfb';
  const ink = dark ? '#f0efec' : '#0b0b0b';
  const muted = dark ? '#8e8d86' : '#7a7974';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, axisW, 0, plotW, plotH);

  // Frequency axis labels.
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = muted;
  ctx.textAlign = 'right';
  const fLo = bandFreqs[0], fHi = bandFreqs[bandFreqs.length - 1];
  for (const f of [50, 100, 250, 500, 1000, 2500, 5000, 10000]) {
    if (f < fLo || f > fHi) continue;
    const y = plotH - (Math.log(f / fLo) / Math.log(fHi / fLo)) * plotH;
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), axisW - 6, y + 3);
  }

  const duration = analysis.meta.duration;
  const xOf = (sec) => axisW + (sec / duration) * plotW;

  // Section boundaries.
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const s of analysis.structure.sections.slice(1)) {
    const x = Math.round(xOf(s.start)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Loudness curve.
  const curve = analysis.loudness.shortTermCurve;
  const lMax = Math.max(...curve) + 1;
  const lMin = Math.max(-45, lMax - 25);
  const yOfL = (v) => plotH - ((Math.max(lMin, v) - lMin) / (lMax - lMin)) * (plotH * 0.85) - plotH * 0.05;
  ctx.strokeStyle = dark ? '#ffffff' : '#0b0b0b';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  curve.forEach((v, i) => {
    const x = xOf(i + 1.5); // short-term window is centered 1.5 s in
    if (i === 0) ctx.moveTo(x, yOfL(v)); else ctx.lineTo(x, yOfL(v));
  });
  ctx.stroke();

  // Time axis.
  ctx.fillStyle = muted;
  ctx.textAlign = 'center';
  const step = duration > 240 ? 30 : duration > 90 ? 15 : 5;
  for (let t = 0; t <= duration; t += step) ctx.fillText(mmss(t), Math.min(w - 14, Math.max(axisW + 12, xOf(t))), h - 4);

  return { axisW, plotW, plotH, duration, frameSeconds };
}

export function drawTonal(canvas, analysis, reference) {
  const { ctx, w, h } = fitCanvas(canvas, 220);
  const ink2 = css('--text-secondary');
  const muted = css('--text-muted');
  const grid = css('--border');
  const s1 = css('--series-1');
  const s2 = css('--series-2');
  const target = css('--target');
  const rows = tonalComparison(analysis, reference);

  const values = rows.flatMap((r) => (reference ? [r.mine, r.target] : [r.mine, r.target - r.tol, r.target + r.tol]));
  const vMax = Math.ceil(Math.max(12, ...values) / 6) * 6;
  const vMin = Math.floor(Math.min(-24, ...values) / 6) * 6;
  const left = 40, right = 8, top = 10, bottom = 26;
  const pw = w - left - right, ph = h - top - bottom;
  const y = (v) => top + ((vMax - v) / (vMax - vMin)) * ph;
  const slot = pw / rows.length;

  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (let v = vMin; v <= vMax; v += 6) {
    ctx.strokeStyle = grid;
    ctx.globalAlpha = v === 0 ? 1 : 0.5;
    ctx.beginPath(); ctx.moveTo(left, Math.round(y(v)) + 0.5); ctx.lineTo(w - right, Math.round(y(v)) + 0.5); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = muted;
    ctx.fillText(`${v > 0 ? '+' : ''}${v}`, left - 6, y(v) + 4);
  }

  const barW = Math.min(26, (slot - 8) / (reference ? 2 : 1));
  const roundedBar = (x, v, color) => {
    const y0 = y(0), y1 = y(v);
    const top_ = Math.min(y0, y1), height = Math.max(1, Math.abs(y1 - y0));
    const r = Math.min(4, height / 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    if (v >= 0) ctx.roundRect(x, top_, barW, height, [r, r, 0, 0]);
    else ctx.roundRect(x, top_, barW, height, [0, 0, r, r]);
    ctx.fill();
  };

  return rows.map((r, i) => {
    const cx = left + slot * i + slot / 2;
    if (!reference) {
      ctx.fillStyle = target;
      ctx.fillRect(cx - slot / 2 + 3, y(r.target + r.tol), slot - 6, y(r.target - r.tol) - y(r.target + r.tol));
      roundedBar(cx - barW / 2, r.mine, s1);
    } else {
      roundedBar(cx - barW - 1, r.mine, s1);
      roundedBar(cx + 1, r.target, s2);
    }
    ctx.fillStyle = ink2;
    ctx.textAlign = 'center';
    ctx.fillText(r.hz >= 1000 ? `${r.hz / 1000}k` : String(r.hz), cx, h - 8);
    return { ...r, x0: cx - slot / 2, x1: cx + slot / 2 };
  });
}
