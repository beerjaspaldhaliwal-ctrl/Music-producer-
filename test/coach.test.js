import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../public/js/analyzer.js';
import { coach, tonalComparison, GENRES } from '../public/js/coach.js';
import { spliceSearchUrl, relativeKey, enrichSampleSuggestion } from '../public/js/splice.js';
import { extractSpliceBlocks, renderMarkdown } from '../public/js/markdown.js';

const fs = 44100;
function clippedSine(seconds) {
  const n = seconds * fs;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.max(-1, Math.min(1, 1.5 * Math.sin((2 * Math.PI * 110 * i) / fs)));
  return s;
}

test('coach flags clipping as critical, ranks it first and returns Splice picks', () => {
  const s = clippedSine(20);
  const a = analyzeTrack({ channels: [s, s], sampleRate: fs });
  const r = coach(a, { stage: 'master', genre: 'modern' });
  assert.equal(r.findings[0].severity, 'critical');
  assert.ok(r.findings.some((f) => f.id === 'clipping'));
  assert.ok(r.findings.some((f) => f.id === 'mono'));
  assert.ok(r.score < 80);
  assert.ok(r.samples.length >= 5);
  for (const sample of r.samples) assert.ok(sample.query && sample.role);
});

test('every genre profile has a palette and sane ranges', () => {
  for (const [id, g] of Object.entries(GENRES)) {
    assert.ok(g.palette.length >= 3, id);
    assert.ok(g.lufs[0] < g.lufs[1] && g.bpm[0] < g.bpm[1], id);
  }
});

test('tonal comparison judges shape, not absolute level', () => {
  const fake = (offset) => ({ spectrum: { octaveBandsRelTo1k: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((hz, i) => ({ hz, db: 10 - i * 3 + offset })) } });
  const rows = tonalComparison(fake(0), fake(7));
  for (const r of rows) assert.equal(r.diff, 0);
});

test('Splice links carry key, mode, BPM and sample type', () => {
  const song = { bpm: 104.4, key: { tonic: 'F#', mode: 'minor' } };
  const loop = spliceSearchUrl({ query: 'pop vocal chop', type: 'loop', matchKey: true, matchBpm: true }, song);
  assert.equal(loop, 'https://splice.com/sounds/search/samples?q=pop%20vocal%20chop&bpm=104&key=f%23&chord_type=minor&sample_type=loop&sort=popularity');
  const shot = spliceSearchUrl({ query: 'snare', type: 'oneshot', matchBpm: true }, song);
  assert.ok(!shot.includes('bpm='), 'one-shots never get a BPM filter');
  assert.deepEqual(relativeKey({ tonic: 'A', mode: 'minor' }), { tonic: 'C', mode: 'major' });
  assert.deepEqual(relativeKey({ tonic: 'Eb', mode: 'major' }), { tonic: 'C', mode: 'minor' });
  const e = enrichSampleSuggestion({ query: '808', type: 'oneshot', matchKey: true }, song);
  assert.ok(e.relativeUrl.includes('key=a&chord_type=major'));
});

test('splice blocks are pulled out of AI text, including while streaming', () => {
  const done = extractSpliceBlocks('Intro\n```splice\n[{"role":"Chop","query":"vocal chop","type":"loop"}]\n```\nOutro');
  assert.equal(done.samples.length, 1);
  assert.ok(!done.text.includes('splice'));
  const partial = extractSpliceBlocks('Intro\n```splice\n[{"role":"Ch');
  assert.equal(partial.pending, true);
  assert.equal(partial.text.trim(), 'Intro');
});

test('markdown renderer escapes HTML', () => {
  const html = renderMarkdown('## Hi\n<script>alert(1)</script> **bold**');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<strong>bold</strong>'));
});
