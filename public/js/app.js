import { GENRES, STAGES, coach } from './coach.js';
import { summarizeForAI, mmss } from './analyzer.js';
import { enrichSampleSuggestion } from './splice.js';
import { drawSpectrogram, drawTonal } from './viz.js';
import { renderMarkdown, extractSpliceBlocks } from './markdown.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const state = {
  trackFile: null,
  refFile: null,
  analysis: null,
  reference: null, // { name, analysis }
  report: null,
  history: [],
  aiSamples: [],
  busy: false,
};

// ---------- setup ----------

for (const [id, g] of Object.entries(GENRES)) {
  const o = document.createElement('option');
  o.value = id; o.textContent = g.label;
  $('genre').append(o);
}

fetch('api/status')
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((s) => {
    $('ai-badge').textContent = s.aiConfigured ? 'AI co-producer: ready' : 'AI co-producer: add API key';
    $('ai-badge').className = `badge ${s.aiConfigured ? 'on' : 'muted'}`;
  })
  .catch(() => {
    $('ai-badge').textContent = 'AI co-producer: server offline';
    state.serverOffline = true;
  });

function wireDrop(labelId, inputId, nameId, key) {
  const label = $(labelId);
  const input = $(inputId);
  const set = (file) => {
    if (!file) return;
    state[key] = file;
    $(nameId).textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`;
    label.classList.add('has-file');
    $('analyze-btn').disabled = !state.trackFile;
    if (state.trackFile) $('analyze-hint').textContent = 'Ready. Analysis runs locally — your audio never leaves your computer.';
  };
  input.addEventListener('change', () => set(input.files[0]));
  label.addEventListener('dragover', (e) => { e.preventDefault(); label.classList.add('over'); });
  label.addEventListener('dragleave', () => label.classList.remove('over'));
  label.addEventListener('drop', (e) => { e.preventDefault(); label.classList.remove('over'); set(e.dataTransfer.files[0]); });
}
wireDrop('drop-track', 'track-file', 'track-name', 'trackFile');
wireDrop('drop-ref', 'ref-file', 'ref-name', 'refFile');

// ---------- analysis ----------

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let jobId = 0;

function analyzeInWorker(channels, sampleRate, onProgress) {
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    const handler = (e) => {
      if (e.data.id !== id) return;
      if (e.data.type === 'progress') onProgress(e.data.progress, e.data.label);
      else {
        worker.removeEventListener('message', handler);
        if (e.data.type === 'result') resolve(e.data.result);
        else reject(new Error(e.data.message));
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ id, channels, sampleRate }, channels.map((c) => c.buffer));
  });
}

async function decode(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const channels = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).slice());
    return { channels, sampleRate: buf.sampleRate };
  } finally {
    ctx.close();
  }
}

function setProgress(p, label) {
  $('progress').hidden = false;
  $('progress-fill').style.width = `${Math.round(p * 100)}%`;
  $('progress-label').textContent = label;
}

$('analyze-btn').addEventListener('click', async () => {
  if (!state.trackFile || state.busy) return;
  state.busy = true;
  $('analyze-btn').disabled = true;
  try {
    const hasRef = Boolean(state.refFile);
    const span = hasRef ? 0.5 : 1;
    setProgress(0.02, 'Decoding your track…');
    const track = await decode(state.trackFile);
    state.analysis = await analyzeInWorker(track.channels, track.sampleRate, (p, l) => setProgress(p * span, `Your track: ${l}`));
    state.reference = null;
    if (hasRef) {
      setProgress(0.5, 'Decoding reference…');
      const ref = await decode(state.refFile);
      const refAnalysis = await analyzeInWorker(ref.channels, ref.sampleRate, (p, l) => setProgress(0.5 + p * 0.5, `Reference: ${l}`));
      state.reference = { name: state.refFile.name, analysis: refAnalysis };
    }
    setProgress(1, 'Done — scroll down for your session notes.');
    state.history = [];
    state.aiSamples = [];
    $('chat').innerHTML = '';
    $('followup').hidden = true;
    $('ai-btn').hidden = false;
    renderResults();
    $('results').hidden = false;
    $('results').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    setProgress(0, `Could not analyze: ${err.message}. Try a WAV or MP3 export.`);
  } finally {
    state.busy = false;
    $('analyze-btn').disabled = false;
  }
});

// ---------- results ----------

function songContext() {
  return { bpm: state.analysis.rhythm.bpm, key: state.analysis.key };
}

function renderResults() {
  const a = state.analysis;
  state.report = coach(a, {
    stage: $('stage').value,
    genre: $('genre').value,
    reference: state.reference?.analysis || null,
  });
  const r = state.report;

  const url = URL.createObjectURL(state.trackFile);
  $('player').src = url;

  const stat = (k, v, s, cls = '') => `<div class="stat ${cls}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;
  const keyConf = a.key.confidence > 0.6 ? 'confident' : a.key.confidence > 0.3 ? 'likely' : 'uncertain';
  $('stats').innerHTML = [
    stat('Producer score', `${r.score}`, `${r.genre} · ${r.stage}`, 'score'),
    stat('Key', a.key.name, `${a.key.camelot} · ${keyConf} · rel. ${a.key.relative}`),
    stat('Tempo', `${a.rhythm.bpm} BPM`, a.rhythm.bpmCandidates.slice(1).map((c) => c.bpm).join(' / ') ? `alt: ${a.rhythm.bpmCandidates.slice(1).map((c) => c.bpm).join(' / ')}` : ''),
    stat('Loudness', `${a.loudness.integratedLufs.toFixed(1)} LUFS`, `LRA ${a.loudness.loudnessRangeLu.toFixed(1)} LU`),
    stat('True peak', `${a.peaks.truePeakDbtp.toFixed(1)} dBTP`, `PLR ${a.peaks.plrDb.toFixed(1)} dB`),
    stat('Stereo', `${a.stereo.correlation.toFixed(2)}`, 'correlation (1 = mono)'),
    stat('First big moment', a.structure.firstHookLabel, `chorus lift ${a.structure.chorusLiftLu === null ? 'n/a' : `${a.structure.chorusLiftLu > 0 ? '+' : ''}${a.structure.chorusLiftLu} LU`}`),
    stat('Length', mmss(a.meta.duration), `${a.structure.sectionCount} sections detected`),
  ].join('');

  drawAll();
  renderSections();
  renderFindings();
  renderSamples();
}

let spectroGeom = null;
let tonalBars = [];
function drawAll() {
  if (!state.analysis) return;
  spectroGeom = drawSpectrogram($('spectrogram'), state.analysis);
  tonalBars = drawTonal($('tonal'), state.analysis, state.reference?.analysis);
  const ref = state.reference;
  $('tonal-hint').textContent = ref
    ? `Octave-band shape (dB, level-aligned): your mix vs ${ref.name}`
    : 'Octave-band shape (dB, level-aligned) vs. the modern-pop target range (shaded)';
  $('tonal-legend').innerHTML = ref
    ? `<span><i style="background:var(--series-1)"></i>Your mix</span><span><i style="background:var(--series-2)"></i>Reference</span>`
    : `<span><i style="background:var(--series-1)"></i>Your mix</span><span><i style="background:var(--target)"></i>Pop target range</span>`;
  const rows = tonalBars.map((b) => `<tr><td>${b.hz >= 1000 ? `${b.hz / 1000} kHz` : `${b.hz} Hz`}</td><td>${b.mine.toFixed(1)}</td><td>${ref ? b.target.toFixed(1) : `${b.target - b.tol} to ${b.target + b.tol}`}</td><td>${b.diff > 0 ? '+' : ''}${b.diff.toFixed(1)}</td></tr>`).join('');
  $('tonal-table').innerHTML = `<table><tr><th>Band</th><th>Your mix (dB)</th><th>${ref ? 'Reference (dB)' : 'Pop target (dB)'}</th><th>Difference</th></tr>${rows}</table>`;
}
window.addEventListener('resize', () => { clearTimeout(drawAll.t); drawAll.t = setTimeout(drawAll, 150); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawAll);

function renderSections() {
  const a = state.analysis;
  $('sections').innerHTML = a.structure.sections.map((s) => `
    <div class="sec ${s.energy}" style="flex:${s.end - s.start}" data-start="${s.start}"
      title="${esc(`${s.startLabel}–${s.endLabel} · ${s.guess} · ${s.energy} energy · ${s.avgLufs} LUFS · pattern ${s.pattern}`)}">
      ${esc(s.guess)} <span class="muted">${esc(s.pattern)}</span>
    </div>`).join('');
  $('sections').querySelectorAll('.sec').forEach((el) => el.addEventListener('click', () => seek(Number(el.dataset.start))));
}

function renderFindings() {
  const r = state.report;
  const counts = r.findings.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
  $('findings-sub').textContent = `${counts.critical || 0} critical · ${counts.important || 0} important · ${counts.polish || 0} polish`;
  const icon = { critical: '⛔', important: '⚠️', polish: '✨', good: '✅' };
  $('findings').innerHTML = r.findings.map((f) => `
    <div class="finding ${f.severity}">
      <div class="finding-head">
        <span class="sev">${icon[f.severity]} ${esc(f.severity)}</span>
        <strong>${esc(f.title)}</strong>
        <span class="area">${esc(f.area)}</span>
      </div>
      <p>${esc(f.detail)}</p>
      ${f.fix.length ? `<ol>${f.fix.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
    </div>`).join('') || '<p class="hint">No issues found — this is in great shape.</p>';
}

function sampleCard(s, ai = false) {
  const song = songContext();
  const e = enrichSampleSuggestion(s, song);
  const chips = [
    ai ? '<span class="chip ai">AI pick</span>' : '',
    e.type ? `<span class="chip">${e.type === 'oneshot' ? 'one-shot' : 'loop'}</span>` : '',
    e.matchKey ? `<span class="chip">${esc(song.key.name)}</span>` : '',
    e.matchBpm && e.type !== 'oneshot' ? `<span class="chip">${song.bpm} BPM</span>` : '',
    e.where ? `<span class="chip">@ ${esc(e.where)}</span>` : '',
  ].join('');
  return `
    <div class="sample">
      <div class="role">${esc(e.role || e.query)}</div>
      <div class="chips">${chips}</div>
      <div class="why">${esc(e.why || (e.because ? `For: ${e.because}` : ''))}</div>
      <div class="query">Splice search: “${esc(e.query)}”</div>
      <div class="links">
        <a class="go" href="${esc(e.url)}" target="_blank" rel="noopener">Open in Splice ↗</a>
        ${e.relativeUrl ? `<a href="${esc(e.relativeUrl)}" target="_blank" rel="noopener">Relative key (${esc(e.relativeLabel)})</a>` : ''}
        <a href="${esc(e.packUrl)}" target="_blank" rel="noopener">Packs</a>
      </div>
    </div>`;
}

function renderSamples() {
  const r = state.report;
  const all = [...state.aiSamples.map((s) => sampleCard(s, true)), ...r.samples.map((s) => sampleCard(s))];
  $('samples').innerHTML = all.join('');
  $('samples-sub').textContent = `matched to ${state.analysis.key.name} · ${state.analysis.rhythm.bpm} BPM`;
}

// ---------- player & spectrogram interaction ----------

function seek(sec) {
  const p = $('player');
  p.currentTime = sec;
  p.play().catch(() => {});
}

$('spectrogram').addEventListener('click', (e) => {
  if (!spectroGeom) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left - spectroGeom.axisW;
  if (x < 0) return;
  seek((x / spectroGeom.plotW) * spectroGeom.duration);
});

$('spectrogram').addEventListener('mousemove', (e) => {
  if (!spectroGeom) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left - spectroGeom.axisW;
  const tip = $('spectro-tip');
  if (x < 0) { tip.hidden = true; return; }
  const sec = Math.max(0, Math.min(spectroGeom.duration, (x / spectroGeom.plotW) * spectroGeom.duration));
  const a = state.analysis;
  const lufs = a.loudness.shortTermCurve[Math.max(0, Math.floor(sec - 1.5))];
  const sec_ = a.structure.sections.find((s) => sec >= s.start && sec < s.end);
  tip.innerHTML = `<strong>${mmss(sec)}</strong> · ${lufs?.toFixed(1)} LUFS${sec_ ? `<br>${esc(sec_.guess)} (${esc(sec_.energy)} energy)` : ''}`;
  tip.hidden = false;
  const left = e.clientX - rect.left + 12;
  tip.style.left = `${Math.min(left, rect.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${e.clientY - rect.top + 12}px`;
});
$('spectrogram').addEventListener('mouseleave', () => { $('spectro-tip').hidden = true; });

$('tonal').addEventListener('mousemove', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const b = tonalBars.find((t) => x >= t.x0 && x < t.x1);
  const tip = $('tonal-tip');
  if (!b) { tip.hidden = true; return; }
  const band = b.hz >= 1000 ? `${b.hz / 1000} kHz` : `${b.hz} Hz`;
  const cmp = state.reference ? `Reference: ${b.target.toFixed(1)} dB` : `Pop target: ${b.target - b.tol} to ${b.target + b.tol} dB`;
  tip.innerHTML = `<strong>${band}</strong><br>Your mix: ${b.mine.toFixed(1)} dB<br>${cmp}<br>Difference: ${b.diff > 0 ? '+' : ''}${b.diff.toFixed(1)} dB`;
  tip.hidden = false;
  tip.style.left = `${Math.min(x + 12, rect.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${e.clientY - rect.top + 12}px`;
});
$('tonal').addEventListener('mouseleave', () => { $('tonal-tip').hidden = true; });

function tickPlayhead() {
  const p = $('player');
  if (spectroGeom && p.duration) {
    const ph = $('playhead');
    ph.style.display = 'block';
    ph.style.left = `${spectroGeom.axisW + (p.currentTime / spectroGeom.duration) * spectroGeom.plotW}px`;
    ph.style.height = `${spectroGeom.plotH}px`;
  }
  if (!p.paused) requestAnimationFrame(tickPlayhead);
}
$('player').addEventListener('play', tickPlayhead);
$('player').addEventListener('seeked', tickPlayhead);

// ---------- AI co-producer ----------

function spectrogramPng() {
  const c = document.createElement('canvas');
  drawSpectrogram(c, state.analysis, { width: 1400, height: 520, dark: true });
  return c.toDataURL('image/png');
}

function brief() {
  return {
    title: $('title').value.trim(),
    genreLabel: GENRES[$('genre').value].label,
    stageLabel: STAGES[$('stage').value].label,
    references: $('references').value.trim(),
    goal: $('goal').value.trim(),
    lyrics: $('lyrics').value.trim(),
  };
}

function addUserBubble(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  $('chat').append(div);
}

async function runTurn(body) {
  const box = document.createElement('div');
  box.className = 'msg assistant';
  box.innerHTML = `<details class="thinking" open><summary>Co-producer is listening through the data…</summary><pre></pre></details><div class="md typing"></div>`;
  $('chat').append(box);
  const thinkPre = box.querySelector('.thinking pre');
  const thinkBox = box.querySelector('.thinking');
  const md = box.querySelector('.md');
  let text = '';
  let thinking = '';
  let gotText = false;

  const render = (final = false) => {
    const { text: clean, samples, pending } = extractSpliceBlocks(text);
    md.innerHTML = renderMarkdown(clean) + (pending ? '<p class="hint">Picking Splice samples for you…</p>' : '');
    if (final) {
      md.classList.remove('typing');
      if (samples.length) {
        state.aiSamples = [...samples, ...state.aiSamples];
        const grid = document.createElement('div');
        grid.className = 'samples';
        grid.innerHTML = samples.map((s) => sampleCard(s, true)).join('');
        md.append(grid);
        renderSamples();
      }
    }
  };

  try {
    const res = await fetch('api/coproduce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: state.history, ...body }),
    });
    if (!res.ok || !res.body) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = raw.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(raw.match(/^data: (.*)$/m)?.[1] || '{}');
        if (ev === 'thinking') {
          thinking += data.text;
          thinkPre.textContent = thinking;
          thinkPre.scrollTop = thinkPre.scrollHeight;
        } else if (ev === 'text') {
          if (!gotText) { gotText = true; thinkBox.open = false; thinkBox.querySelector('summary').textContent = 'Producer’s thought process'; }
          text += data.text;
          render();
        } else if (ev === 'done') {
          state.history.push(data.userMessage, { role: 'assistant', content: data.assistantContent });
          if (data.stopReason === 'max_tokens') text += '\n\n*(Response hit the length limit — ask me to continue.)*';
          render(true);
          done = true;
        } else if (ev === 'error') {
          throw new Error(data.message);
        }
      }
    }
    if (!thinking) thinkBox.remove();
  } catch (err) {
    md.classList.remove('typing');
    thinkBox.remove();
    const hint = state.serverOffline ? ' Start the app with "npm start" to use the AI co-producer.' : '';
    md.innerHTML = renderMarkdown(text) + `<p class="error">${esc(err.message)}${esc(hint)}</p>`;
    return false;
  }
  return true;
}

$('ai-btn').addEventListener('click', async () => {
  if (!state.analysis || state.busy) return;
  state.busy = true;
  $('ai-btn').disabled = true;
  const start = {
    brief: brief(),
    analysis: summarizeForAI(state.analysis),
    findings: state.report.findings.map(({ severity, area, title }) => ({ severity, area, title })),
    reference: state.reference ? { name: state.reference.name, analysis: summarizeForAI(state.reference.analysis) } : null,
    spectrogramPng: spectrogramPng(),
  };
  const ok = await runTurn({ start });
  state.busy = false;
  $('ai-btn').disabled = false;
  if (ok) { $('ai-btn').hidden = true; $('followup').hidden = false; }
});

$('followup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('followup-input');
  const msg = input.value.trim();
  if (!msg || state.busy) return;
  state.busy = true;
  input.value = '';
  addUserBubble(msg);
  await runTurn({ message: msg });
  state.busy = false;
});
