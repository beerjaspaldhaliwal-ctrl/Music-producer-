// The rule-based "producer brain". Turns raw measurements into prioritized,
// pop-specific feedback with concrete fixes and Splice sample picks.
// Works fully offline; the AI co-producer builds on top of this.

import { mmss } from './analyzer.js';

export const STAGES = {
  demo: { label: 'Demo / writing stage' },
  mix: { label: 'Mix (pre-master)' },
  master: { label: 'Final master' },
};

// Sub-genre profiles. LUFS ranges are for finished masters of commercial releases.
export const GENRES = {
  modern: {
    label: 'Modern mainstream pop',
    bpm: [95, 128], lufs: [-9.5, -6.5], lra: [3, 7],
    palette: [
      { role: 'Signature vocal chop hook', query: 'pop vocal chop', type: 'loop', matchKey: true, matchBpm: true },
      { role: 'Tight pop snap / clap', query: 'pop snap clap', type: 'oneshot' },
      { role: 'Modern pop drum loop', query: 'pop drum loop', type: 'loop', matchBpm: true },
    ],
  },
  dance: {
    label: 'Dance-pop / EDM-pop',
    bpm: [118, 128], lufs: [-8, -5.5], lra: [3, 6],
    palette: [
      { role: 'Supersaw chord stab', query: 'supersaw chord', type: 'loop', matchKey: true, matchBpm: true },
      { role: 'Four-on-the-floor kick', query: 'dance pop kick', type: 'oneshot' },
      { role: 'Pluck drop melody', query: 'pluck melody', type: 'loop', matchKey: true, matchBpm: true },
    ],
  },
  rnb: {
    label: 'Pop R&B',
    bpm: [65, 105], lufs: [-10, -7], lra: [4, 8],
    palette: [
      { role: 'Warm Rhodes / keys loop', query: 'rnb rhodes keys', type: 'loop', matchKey: true, matchBpm: true },
      { role: 'Silky vocal ad-lib / run', query: 'rnb vocal adlib', type: 'loop', matchKey: true, matchBpm: true },
      { role: 'Crispy R&B hi-hat roll', query: 'rnb hi hat loop', type: 'loop', matchBpm: true },
    ],
  },
  indie: {
    label: 'Indie / bedroom pop',
    bpm: [80, 120], lufs: [-11, -8], lra: [4, 9],
    palette: [
      { role: 'Lo-fi guitar loop', query: 'indie pop guitar', type: 'loop', matchKey: true, matchBpm: true },
      { role: 'Dusty drum break', query: 'lofi drum break', type: 'loop', matchBpm: true },
      { role: 'Tape-warped synth texture', query: 'tape texture synth', type: 'loop', matchKey: true },
    ],
  },
  synth: {
    label: 'Synth-pop / 80s revival',
    bpm: [100, 124], lufs: [-9.5, -7], lra: [3, 7],
    palette: [
      { role: 'Gated reverb snare', query: 'gated reverb snare 80s', type: 'oneshot' },
      { role: 'Juno-style arp', query: '80s synth arp', type: 'loop', matchKey: true, matchBpm: true },
      { role: 'Analog synth bass line', query: 'synthpop bass', type: 'loop', matchKey: true, matchBpm: true },
    ],
  },
  ballad: {
    label: 'Pop ballad',
    bpm: [60, 85], lufs: [-12, -8], lra: [5, 10],
    palette: [
      { role: 'Felt / grand piano chords', query: 'emotional piano chords', type: 'loop', matchKey: true, matchBpm: true },
      { role: 'Cinematic string swell', query: 'string swell', type: 'loop', matchKey: true },
      { role: 'Soft cinematic impact', query: 'cinematic impact soft', type: 'oneshot' },
    ],
  },
  afro: {
    label: 'Afro-pop / Afrobeats-pop',
    bpm: [95, 115], lufs: [-9, -6.5], lra: [3, 7],
    palette: [
      { role: 'Afrobeats percussion loop', query: 'afrobeats percussion', type: 'loop', matchBpm: true },
      { role: 'Log drum', query: 'log drum', type: 'oneshot', matchKey: true },
      { role: 'Highlife guitar loop', query: 'afrobeat guitar', type: 'loop', matchKey: true, matchBpm: true },
    ],
  },
  kpop: {
    label: 'K-pop',
    bpm: [100, 135], lufs: [-8, -5.5], lra: [3, 7],
    palette: [
      { role: 'Hard-hitting trap-pop drums', query: 'kpop drums', type: 'loop', matchBpm: true },
      { role: 'Brass stab hit', query: 'brass stab', type: 'oneshot', matchKey: true },
      { role: 'Vocal chant / gang vocal', query: 'gang vocal chant', type: 'oneshot' },
    ],
  },
  latin: {
    label: 'Latin pop / reggaeton-pop',
    bpm: [88, 102], lufs: [-8.5, -6], lra: [3, 6],
    palette: [
      { role: 'Dembow drum loop', query: 'reggaeton dembow drums', type: 'loop', matchBpm: true },
      { role: 'Latin guitar loop', query: 'latin pop guitar', type: 'loop', matchKey: true, matchBpm: true },
      { role: 'Perc fills (timbales / congas)', query: 'latin percussion loop', type: 'loop', matchBpm: true },
    ],
  },
  hyper: {
    label: 'Hyperpop / alt-pop',
    bpm: [130, 170], lufs: [-7, -4.5], lra: [2, 6],
    palette: [
      { role: 'Pitched vocal chop glitch', query: 'hyperpop vocal chop', type: 'loop', matchKey: true, matchBpm: true },
      { role: 'Distorted 808', query: 'distorted 808', type: 'oneshot', matchKey: true },
      { role: 'Glitch FX', query: 'glitch fx', type: 'oneshot' },
    ],
  },
};

// Approximate long-term octave balance of modern pop masters (dB, relative
// shape only), with tolerances. A reference track (if given) replaces this.
export const POP_CURVE = [
  { hz: 31.5, target: 3, tol: 5 },
  { hz: 63, target: 9, tol: 4 },
  { hz: 125, target: 8, tol: 4 },
  { hz: 250, target: 5, tol: 3.5 },
  { hz: 500, target: 2.5, tol: 3 },
  { hz: 1000, target: 0, tol: 3 },
  { hz: 2000, target: -3, tol: 3 },
  { hz: 4000, target: -6, tol: 3.5 },
  { hz: 8000, target: -9.5, tol: 4 },
  { hz: 16000, target: -17, tol: 6 },
];

/**
 * Octave-band comparison against the pop curve or a reference track. Your mix is
 * shifted by the median difference (63 Hz–8 kHz) so only the *shape* is judged —
 * one odd band can't skew every other band.
 */
export function tonalComparison(analysis, reference = null) {
  const mine = analysis.spectrum.octaveBandsRelTo1k;
  const theirs = reference ? Object.fromEntries(reference.spectrum.octaveBandsRelTo1k.map((o) => [o.hz, o.db])) : null;
  const rows = mine.map((o) => {
    if (theirs) return { hz: o.hz, raw: o.db, target: theirs[o.hz], tol: o.hz <= 63 || o.hz >= 16000 ? 4 : 3 };
    const c = POP_CURVE.find((p) => p.hz === o.hz);
    return { hz: o.hz, raw: o.db, target: c.target, tol: c.tol };
  });
  const diffs = rows.filter((r) => r.hz >= 63 && r.hz <= 8000).map((r) => r.raw - r.target).sort((a, b) => a - b);
  const offset = diffs[Math.floor(diffs.length / 2)];
  return rows.map((r) => ({ ...r, mine: Math.round((r.raw - offset) * 10) / 10, diff: Math.round((r.raw - offset - r.target) * 10) / 10 }));
}

const SEVERITY_WEIGHT = { critical: 12, important: 6, polish: 2, good: 0 };

const fmt = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d);

export function coach(analysis, { stage = 'mix', genre = 'modern', reference = null } = {}) {
  const g = GENRES[genre] || GENRES.modern;
  const findings = [];
  const add = (f) => findings.push({ samples: [], fix: [], ...f });
  const L = analysis.loudness;
  const P = analysis.peaks;
  const S = analysis.structure;
  const st = analysis.stereo;

  // ------------ Clipping & technical problems ------------
  if (P.clipEvents > 0) {
    add({
      id: 'clipping', severity: 'critical', area: 'Master',
      title: `Digital clipping detected (${P.clipEvents} events)`,
      detail: 'Consecutive full-scale samples mean the waveform is being chopped flat. Streaming encoders turn this into audible crackle and harshness — instant "amateur" flag for A&Rs.',
      fix: [
        'Pull the master fader / limiter output ceiling down to -1.0 dBTP (true-peak mode ON).',
        'Find the culprit: solo the drum bus and vocal bus — clipping usually starts on an over-driven 808 or a clipper with no ceiling.',
        'If you want the "loud clipped" sound, use a soft clipper (e.g. StandardCLIP, KClip, FabFilter Saturn) BEFORE the limiter, not at the output.',
      ],
    });
  }
  if (Math.abs(P.dcOffset) > 0.003) {
    add({
      id: 'dc', severity: 'important', area: 'Mix',
      title: 'DC offset in the mix',
      detail: `Average signal is offset by ${(P.dcOffset * 100).toFixed(2)}% — wastes headroom and makes your limiter work asymmetrically.`,
      fix: ['Put a high-pass at 20–25 Hz (linear phase or 12 dB/oct) on the master bus, and check any saturated/bit-crushed channels.'],
    });
  }
  if (analysis.edges.leadingSilenceSec > 0.5) {
    add({
      id: 'lead-silence', severity: 'polish', area: 'Master',
      title: `${analysis.edges.leadingSilenceSec.toFixed(1)} s of silence before the song starts`,
      detail: 'On streaming, dead air before the first sound costs you listeners in the critical first seconds.',
      fix: ['Trim the start so the first transient lands within ~50 ms. Keep a 5 ms fade-in to avoid a click.'],
    });
  }
  if (analysis.edges.trailingSilenceSec > 3) {
    add({
      id: 'tail-silence', severity: 'polish', area: 'Master',
      title: `${analysis.edges.trailingSilenceSec.toFixed(1)} s of silence at the end`,
      detail: 'Long dead tails hurt playlist flow (and autoplay).',
      fix: ['Trim to ~1–2 s after the last reverb tail decays, with a short fade-out.'],
    });
  }

  // ------------ Loudness & dynamics ------------
  const lufs = L.integratedLufs;
  if (stage === 'master') {
    if (lufs < g.lufs[0] - 1.5) {
      add({
        id: 'quiet-master', severity: 'important', area: 'Master',
        title: `Master is quiet for ${g.label} (${lufs.toFixed(1)} LUFS)`,
        detail: `Commercial ${g.label.toLowerCase()} masters sit around ${g.lufs[0]} to ${g.lufs[1]} LUFS integrated. Streaming normalization helps, but next to other songs in a playlist (and on platforms/devices with normalization off) your track will feel smaller and less dense.`,
        fix: [
          'Add density before the limiter, not just more limiting: a bus compressor on the mix (2:1, 30 ms attack, auto/100 ms release, 1–2 dB GR) glues and lifts the average level.',
          'Soft-clip the drum bus 1–3 dB so transients do not eat all the limiter headroom.',
          `Then limit in two stages (1–2 dB each) to reach ~${((g.lufs[0] + g.lufs[1]) / 2).toFixed(0)} LUFS with ceiling -1 dBTP.`,
        ],
      });
    } else if (lufs > g.lufs[1] + 1) {
      add({
        id: 'loud-master', severity: 'important', area: 'Master',
        title: `Master is pushed very hard (${lufs.toFixed(1)} LUFS)`,
        detail: `Louder than typical ${g.label.toLowerCase()} masters. Spotify/Apple/YouTube will turn it DOWN, so you keep the distortion and lose the punch.`,
        fix: [`Back the limiter off until you are around ${g.lufs[1]} LUFS and A/B at matched loudness — it will usually sound bigger.`],
      });
    } else {
      add({ id: 'loudness-ok', severity: 'good', area: 'Master', title: `Competitive loudness (${lufs.toFixed(1)} LUFS)`, detail: `Right in the ${g.label} window.` });
    }
    if (P.truePeakDbtp > -0.8) {
      add({
        id: 'true-peak', severity: 'important', area: 'Master',
        title: `True peak too hot (${P.truePeakDbtp.toFixed(1)} dBTP)`,
        detail: 'Inter-sample peaks above about -1 dBTP distort when Spotify/Apple encode to AAC/Ogg.',
        fix: ['Set your limiter to true-peak mode with a -1.0 dBTP ceiling (use -2 dBTP if the master is louder than -8 LUFS).'],
      });
    }
    if (P.plrDb < 6.5) {
      add({
        id: 'over-limited', severity: 'important', area: 'Master',
        title: `Over-limited — peak-to-loudness ratio only ${P.plrDb.toFixed(1)} dB`,
        detail: 'Transients are flattened: kick and snare lose their crack, the chorus cannot feel bigger than the verse.',
        fix: [
          'Reduce limiter gain reduction by 2–3 dB.',
          'Use a transient shaper on the drum bus (+2–4 dB attack) before the master chain.',
          'Use parallel compression for density instead of brick-wall limiting.',
        ],
      });
    }
  } else {
    if (P.truePeakDbtp > -1 && stage === 'mix') {
      add({
        id: 'mix-headroom', severity: 'important', area: 'Mix',
        title: `No headroom for mastering (peaks at ${P.truePeakDbtp.toFixed(1)} dBTP)`,
        detail: 'A mix that is already hitting 0 dB leaves the mastering engineer nothing to work with.',
        fix: ['Pull the mix down so peaks hit around -6 to -3 dBFS, and remove any limiter on the master bus before sending the mix off (or send both versions).'],
      });
    }
  }

  if (L.loudnessRangeLu < g.lra[0] - 0.5 && analysis.meta.duration > 60) {
    add({
      id: 'flat-dynamics', severity: 'important', area: 'Arrangement',
      title: `Very flat macro-dynamics (LRA ${L.loudnessRangeLu.toFixed(1)} LU)`,
      detail: 'The whole song lives at one level. In pop, contrast IS the hook: the drop/chorus only hits if the verse and pre-chorus pull back.',
      fix: [
        'Strip the second half of verse 1 down: remove the kick or the bass for 4–8 bars, or filter the music bed (low-pass ~2 kHz).',
        'Mute EVERYTHING except the vocal for the last beat (or last bar) before the chorus — the classic pop "drop-out".',
        'Automate the music bus: verses 1.5–3 dB lower than choruses.',
      ],
      samples: [
        { role: 'Riser into the chorus', query: 'riser', type: 'loop', matchBpm: true, why: 'Builds tension in the last 2–4 bars of the pre-chorus.' },
        { role: 'Reverse cymbal / reverse vocal', query: 'reverse cymbal', type: 'oneshot', why: 'Sucks the listener into the downbeat of the chorus.' },
      ],
    });
  } else if (L.loudnessRangeLu > g.lra[1] + 2) {
    add({
      id: 'too-dynamic', severity: 'polish', area: 'Mix',
      title: `Large loudness swings (LRA ${L.loudnessRangeLu.toFixed(1)} LU)`,
      detail: `Bigger dynamic range than typical ${g.label.toLowerCase()} — quiet parts may get lost in cars, phones and noisy rooms.`,
      fix: ['Ride the quiet sections up with volume automation (not compression) and/or use gentle bus compression to tighten the extremes.'],
    });
  }

  if (P.punchCrestDb && P.punchCrestDb < 6 && stage !== 'demo') {
    add({
      id: 'no-punch', severity: 'important', area: 'Mix',
      title: `Transients sound squashed (crest ${P.punchCrestDb.toFixed(1)} dB in loud parts)`,
      detail: 'The loud sections have very little difference between peaks and body — drums lose impact and the track feels "smeared".',
      fix: [
        'Check drum-bus compression: slow the attack to 20–30 ms so the transient passes through.',
        'Add a transient designer on kick and snare (+3 dB attack, slight sustain cut).',
        'Sidechain the bass/808 and big pads to the kick (2–4 dB ducking, fast release) to carve space for the hit.',
      ],
      samples: [{ role: 'Punchier layered kick', query: 'pop kick punchy', type: 'oneshot', why: 'Layer a short click/transient kick over your current kick to cut through.' }],
    });
  }

  // ------------ Tonal balance ------------
  if (reference) {
    compareToReference(analysis, reference, add);
  } else {
    for (const r of tonalComparison(analysis)) {
      if (Math.abs(r.diff) > r.tol) add(tonalFinding(r.hz, r.diff, stage));
    }
  }

  const tilt = analysis.spectrum.tiltDbPerOctave;
  if (!reference && tilt < -4.8) {
    add({
      id: 'dark', severity: 'important', area: 'Mix',
      title: 'Overall mix is dark / dull for pop',
      detail: `Spectral tilt is ${tilt} dB/octave (pop masters sit around -3). Modern pop is bright, glossy and forward — a dull top end makes the record feel old and unfinished.`,
      fix: [
        'Lead vocal: high shelf +2–4 dB at 10–12 kHz (Pultec-style or Pro-Q 3 "air" shelf), then de-ess after.',
        'Master: gentle tilt EQ or high shelf +1–1.5 dB at 8 kHz.',
        'Add top-end percussion (shakers, hats, tambourine) instead of only EQing — it adds sparkle AND groove.',
      ],
      samples: [
        { role: 'Shaker loop for sparkle', query: 'pop shaker loop', type: 'loop', matchBpm: true, why: 'Adds movement and top-end energy.' },
        { role: 'Bright tambourine', query: 'tambourine loop', type: 'loop', matchBpm: true, why: 'Lifts choruses — a classic pop trick on 2 & 4 or 16ths.' },
      ],
    });
  } else if (!reference && tilt > -1.3) {
    add({
      id: 'bright', severity: 'important', area: 'Mix',
      title: 'Mix is thin / overly bright',
      detail: `Spectral tilt is ${tilt} dB/octave — top-heavy compared to pop references (~-3). Fatiguing on earbuds and lacks warmth/weight.`,
      fix: [
        'Use a dynamic EQ or Soothe2 on the 2–6 kHz region of the mix bus to tame harshness only when it flares.',
        'Add weight: saturate the bass/808 (2nd harmonic) and lift the low-mids of the music bus slightly (+1 dB at 200 Hz).',
      ],
    });
  }

  if (analysis.spectrum.sibilanceSpikeDb > 24) {
    add({
      id: 'sibilance', severity: 'polish', area: 'Vocals',
      title: 'Possible harsh "S" sounds / spitty top end',
      detail: `Bursts in the 5–9 kHz range poke ${analysis.spectrum.sibilanceSpikeDb} dB above their usual level. Usually sibilance, harsh hats or a cymbal crash.`,
      fix: [
        'De-ess the lead vocal in two stages: one de-esser at 6–8 kHz (3–4 dB), then a second lighter one after the air EQ.',
        'Clip-gain the worst "S/T/SH" consonants down 3–6 dB manually — the cleanest pop-vocal trick.',
      ],
    });
  }

  // ------------ Stereo image ------------
  if (st.correlation < 0.15) {
    add({
      id: 'phase', severity: 'critical', area: 'Mix',
      title: `Phase / mono-compatibility risk (correlation ${st.correlation})`,
      detail: 'Your mix is extremely wide or out of phase. On phones, club systems, and Bluetooth speakers (mono), parts of it will disappear.',
      fix: [
        'Check in mono: find which element vanishes (often stereo-widened synths, Haas-delayed guitars, or a wide reverb).',
        'Reduce stereo wideners to 120–130% max; never widen anything below 150 Hz.',
      ],
    });
  } else if (st.correlation > 0.93 && !st.isMono) {
    add({
      id: 'narrow', severity: 'important', area: 'Mix',
      title: 'Mix is narrow — it does not feel "big" on headphones',
      detail: `Stereo correlation is ${st.correlation}. Pop records keep kick/bass/lead vocal centered but put width around them (doubles, pads, guitars, reverbs).`,
      fix: [
        'Double-track (or quad-track) backing vocals and pan them hard L/R.',
        'Make the chorus wider than the verse: add a stereo pad or wide synth layer only in choruses.',
        'Use a short stereo room/plate on the music bus (send, 10–15%).',
      ],
      samples: [
        { role: 'Wide stereo pad', query: 'wide pop pad', type: 'loop', matchKey: true, matchBpm: true, why: 'Instant width behind the vocal in choruses.' },
        { role: 'Backing vocal stack / harmonies', query: 'pop vocal harmony', type: 'loop', matchKey: true, matchBpm: true, why: 'Stacked harmonies panned wide = the modern pop chorus sound.' },
      ],
    });
  } else if (st.isMono) {
    add({
      id: 'mono', severity: 'critical', area: 'Mix',
      title: 'The track is in mono',
      detail: 'Left and right channels are identical. Pop mixes need stereo width (doubles, pads, reverbs).',
      fix: ['Check your export settings (stereo interleaved), then pan elements and add stereo backing vocals / pads.'],
    });
  }
  if (st.lowEndSideToMidDb > -12) {
    add({
      id: 'wide-lows', severity: 'important', area: 'Low end',
      title: 'Low end is too wide',
      detail: `Side energy below 150 Hz is only ${Math.abs(st.lowEndSideToMidDb)} dB under the center. Wide bass sounds weak in mono and causes problems on vinyl/club systems.`,
      fix: [
        'Use a mono-maker below 120 Hz on the master or bass bus (e.g. Ozone Imager, bx_digital "Mono Maker").',
        'Check stereo synth bass patches — collapse their low layer to mono, keep only the upper harmonics wide.',
      ],
    });
  }
  if (Math.abs(st.balanceLrDb) > 1.2) {
    add({
      id: 'balance', severity: 'polish', area: 'Mix',
      title: `Mix leans to the ${st.balanceLrDb > 0 ? 'left' : 'right'} (${Math.abs(st.balanceLrDb).toFixed(1)} dB)`,
      detail: 'One side is noticeably louder overall. Usually an unbalanced percussion or guitar panning.',
      fix: ['Balance your panned pairs (L/R doubles, hats vs shaker) so the overall image centers.'],
    });
  }

  // ------------ Arrangement / song structure ------------
  const dur = analysis.meta.duration;
  if (S.firstHookSec !== null && S.firstHookSec > 50) {
    add({
      id: 'late-hook', severity: 'critical', area: 'Arrangement',
      title: `The first big moment arrives late (${S.firstHookLabel})`,
      detail: 'Streaming listeners decide in the first ~30 seconds. Most current pop hits land the chorus (or a teaser of it) before 0:45–0:50, often within the first 15 seconds.',
      fix: [
        'Open with a 4-bar teaser of the chorus hook (filtered or vocal-only) before verse 1.',
        'Shorten verse 1 to 8 bars and/or cut the intro to 2–4 bars.',
        'Consider starting cold with the chorus (very common in modern pop).',
      ],
      samples: [{ role: 'Hook teaser vocal chop', query: 'pop vocal chop', type: 'loop', matchKey: true, matchBpm: true, why: 'Tease the hook in the intro so the listener is caught before the verse.' }],
    });
  } else if (S.firstHookSec === null) {
    add({
      id: 'no-hook', severity: 'critical', area: 'Arrangement',
      title: 'No clear high-energy chorus/drop detected',
      detail: 'Energy stays level throughout — there is no section that clearly "arrives". Pop is built on the chorus payoff.',
      fix: [
        'Give the chorus at least 3 things the verse does not have: e.g. full drums + bass, vocal doubles/harmonies, a new top-line synth or vocal chop.',
        'Raise the chorus melody by a 3rd–5th over the verse and stack it.',
      ],
    });
  }
  if (S.introSec > 15) {
    add({
      id: 'long-intro', severity: 'important', area: 'Arrangement',
      title: `Long, quiet intro (${mmss(S.introSec)} before the track gets going)`,
      detail: 'Long intros get skipped on streaming and hurt playlist retention.',
      fix: ['Cut the intro to 2–4 bars, or put a recognizable motif (vocal chop / melody hook) in it so it earns its time.'],
    });
  }
  if (S.chorusLiftLu !== null && S.chorusLiftLu < 1.5) {
    add({
      id: 'weak-lift', severity: 'critical', area: 'Arrangement',
      title: `Chorus doesn't lift (only ${fmt(S.chorusLiftLu)} LU louder than the verses)`,
      detail: 'Top pop choruses hit about 2–5 LU louder, plus wider and brighter than the verse. Right now the payoff is too small to feel.',
      fix: [
        'Subtract from the verse rather than adding to the chorus: thinner drums, no bass in the first half, filtered chords.',
        'Pre-chorus: build with a riser, snare roll or rising filter, then a half-bar drop-out right before the downbeat.',
        'Chorus: add an impact on beat 1, double/triple the lead vocal, add octave-up harmonies and a wide pad.',
      ],
      samples: [
        { role: 'Impact / boom on the chorus downbeat', query: 'cinematic impact', type: 'oneshot', why: 'Makes the downbeat of the chorus physically hit.' },
        { role: 'Snare roll build', query: 'snare roll build', type: 'loop', matchBpm: true, why: 'Classic pre-chorus tension builder.' },
        { role: 'White-noise sweep', query: 'noise sweep riser', type: 'loop', matchBpm: true, why: 'Glues the transition into the chorus.' },
      ],
    });
  } else if (S.chorusLiftLu !== null && S.chorusLiftLu >= 2) {
    add({ id: 'lift-ok', severity: 'good', area: 'Arrangement', title: `Strong chorus lift (${fmt(S.chorusLiftLu)} LU)`, detail: 'The high-energy sections clearly arrive. Keep that contrast.' });
  }
  if (S.chorusWidthLiftDb !== null && S.chorusWidthLiftDb < 0.5 && S.chorusLiftLu !== null) {
    add({
      id: 'chorus-not-wider', severity: 'polish', area: 'Arrangement',
      title: 'Chorus is not wider than the verse',
      detail: 'The classic pop move is narrow verse → wide chorus. Your width stays the same.',
      fix: ['Keep verse instruments mostly centered/mono, then bring in hard-panned doubles, wide synths and a stereo reverb in the chorus.'],
    });
  }
  if (dur > 150 && S.distinctPatterns <= 2) {
    add({
      id: 'repetitive', severity: 'important', area: 'Arrangement',
      title: 'Arrangement may be too repetitive',
      detail: `Only ${S.distinctPatterns} distinct section textures detected across ${mmss(dur)}. Without a bridge/middle-8 or a post-chorus switch-up the second half feels like a repeat.`,
      fix: [
        'Add a bridge at ~2/3 of the song: new chords (try the IV or the relative minor), half-time drums or a stripped vocal+piano moment.',
        'Make chorus 2 or the final chorus different: key change up a whole step, added ad-libs, extra drum layer, or a post-chorus vocal-chop hook.',
      ],
      samples: [{ role: 'Post-chorus vocal-chop hook', query: 'vocal chop hook', type: 'loop', matchKey: true, matchBpm: true, why: 'A post-chorus hook gives the song a second earworm.' }],
    });
  }
  if (S.energyVariationLu < 1.5 && dur > 60) {
    add({
      id: 'static', severity: 'important', area: 'Arrangement',
      title: 'Energy curve is static',
      detail: 'Loudness barely moves through the song. Every 8 bars something should enter, leave, or change.',
      fix: ['Follow the "every 8 bars" rule: add or remove one element (perc layer, counter-melody, ad-lib, filter move, drum fill) at each 8-bar boundary.'],
      samples: [
        { role: 'Ear-candy FX (vinyl stop, tape stop, swoosh)', query: 'transition fx', type: 'oneshot', why: 'Small ear candy at section boundaries keeps attention.' },
        { role: 'Drum fills', query: 'pop drum fill', type: 'oneshot', why: 'Marks transitions between sections.' },
      ],
    });
  }
  if (dur > 240) {
    add({
      id: 'long-song', severity: 'polish', area: 'Arrangement',
      title: `Long for a pop single (${mmss(dur)})`,
      detail: 'Most current pop hits are 2:30–3:30. Shorter songs get more replays (and stream counts).',
      fix: ['Cut the second verse to 8 bars, shorten the intro/outro, or drop the repeat of the pre-chorus before the last chorus.'],
    });
  } else if (dur < 110) {
    add({
      id: 'short-song', severity: 'polish', area: 'Arrangement',
      title: `Very short (${mmss(dur)})`,
      detail: 'Short is in fashion, but under ~2:00 a song may feel like a sketch unless it is intentional.',
      fix: ['Make sure you have at least verse → pre → chorus → verse → chorus → (bridge) → chorus.'],
    });
  }

  // ------------ Tempo vs genre ------------
  const bpm = analysis.rhythm.bpm;
  const inRange = (b) => b >= g.bpm[0] && b <= g.bpm[1];
  if (!inRange(bpm) && !inRange(bpm / 2) && !inRange(bpm * 2)) {
    add({
      id: 'tempo', severity: 'polish', area: 'Arrangement',
      title: `Tempo ${bpm} BPM is unusual for ${g.label}`,
      detail: `Typical range is ${g.bpm[0]}–${g.bpm[1]} BPM. Not wrong — but if the groove feels sluggish or rushed, that's why.`,
      fix: [`Try the song at ${Math.min(Math.max(bpm, g.bpm[0]), g.bpm[1])} BPM (time-stretch the vocal) and compare the energy.`],
    });
  }

  // ------------ Score & samples ------------
  const penalty = findings.reduce((s, f) => s + SEVERITY_WEIGHT[f.severity], 0);
  const score = Math.max(20, Math.min(100, 100 - penalty));
  const order = { critical: 0, important: 1, polish: 2, good: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const samples = collectSamples(findings, g);

  return { score, genre: g.label, stage: STAGES[stage]?.label || stage, findings, samples };
}

function tonalFinding(hz, diff, stage) {
  const over = diff > 0;
  const amount = `${Math.abs(diff).toFixed(1)} dB`;
  const label = hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
  const base = { id: `tone-${hz}-${over ? 'hi' : 'lo'}`, area: hz <= 125 ? 'Low end' : 'Mix' };
  const sev = Math.abs(diff) > 6 ? 'important' : 'polish';
  switch (hz) {
    case 31.5:
      return over
        ? { ...base, severity: sev, title: `Too much deep sub (~${label}, ${amount} over)`, detail: 'Sub energy that most speakers cannot reproduce eats your headroom and makes the master quieter.', fix: ['High-pass everything that is not kick/808/bass at 30–40 Hz.', 'High-pass the 808/bass at ~25–30 Hz and saturate it so it reads on phones.'] }
        : { ...base, severity: 'polish', title: `Not much deep sub (~${label})`, detail: 'Fine on phones, but the track may lack weight on big systems and in cars.', fix: ['Layer a clean sine sub under the bass/808 in the drop/chorus only.'], samples: [{ role: 'Clean sub / 808', query: '808', type: 'oneshot', matchKey: true, why: 'Tuned to your key so the low end is in tune with the chords.' }] };
    case 63:
    case 125:
      return over
        ? { ...base, severity: sev, title: `Boomy low end (~${label}, ${amount} over)`, detail: 'Kick and bass are fighting or too loud — the mix feels muddy and the limiter pumps.', fix: ['Pick ONE of kick or bass to own 50–70 Hz and cut the other there 2–4 dB.', 'Sidechain the bass to the kick (fast attack, 50–80 ms release, 3–5 dB).', 'Check the bass level with a spectrum analyzer against a reference track.'] }
        : { ...base, severity: sev, title: `Weak low end (~${label}, ${amount} under)`, detail: 'Pop records have a solid, controlled bottom. Yours lacks weight — it will sound small next to radio hits.', fix: ['Boost the kick at 55–65 Hz and the bass/808 fundamental with a narrow bell.', 'Saturate the bass (Decapitator, Saturn, or the DAW saturator) to add harmonics that translate to small speakers.', 'Layer a punchier kick / 808 tuned to the key.'], samples: [{ role: 'Tuned 808 / sub bass', query: '808', type: 'oneshot', matchKey: true, why: 'Key-matched so it supports your chords.' }, { role: 'Punchy pop kick', query: 'pop kick', type: 'oneshot', why: 'A kick with a strong 50–60 Hz body.' }] };
    case 250:
    case 500:
      return over
        ? { ...base, severity: sev, title: `Muddy low-mids (~${label}, ${amount} over)`, detail: 'Too much 200–500 Hz makes a pop mix boxy and cloudy; vocals lose clarity.', fix: ['On pads, guitars, keys and backing vocals cut 2–4 dB around 250–400 Hz (wide bell).', 'High-pass non-bass instruments at 100–200 Hz.', 'Try a dynamic EQ on the lead vocal at ~300 Hz.'] }
        : { ...base, severity: 'polish', title: `Thin low-mids (~${label})`, detail: 'Missing body/warmth — vocals and chords can sound hollow.', fix: ['Add +1–2 dB at 200–300 Hz on the vocal or music bus, or saturate the chords lightly.'] };
    case 2000:
    case 4000:
      return over
        ? { ...base, severity: sev, title: `Harsh upper-mids (~${label}, ${amount} over)`, detail: 'Fatiguing on earbuds; the listener turns it down.', fix: ['Use Soothe2 / a dynamic EQ on the vocal and the mix bus around 2.5–5 kHz.', 'Pull back distorted guitars/synths at 3 kHz instead of the vocal.'] }
        : { ...base, severity: sev, title: `Vocal lacks presence (~${label}, ${amount} under)`, detail: 'Modern pop vocals are right in your face. Without 2–5 kHz energy the vocal sits behind the music.', fix: ['Lead vocal: +2–3 dB bell around 3–4 kHz, plus parallel compression (fast attack, 10:1, blended 20–30%).', 'Carve 2–4 kHz out of the music bus with a sidechained dynamic EQ keyed from the vocal.'] };
    case 8000:
    case 16000:
      return over
        ? { ...base, severity: sev, title: `Too much top end (~${label}, ${amount} over)`, detail: 'Hats, cymbals or vocal air are too hot — brittle and sibilant.', fix: ['Lower hats/cymbals 2–3 dB, and de-ess the lead vocal.'] }
        : { ...base, severity: stage === 'demo' ? 'polish' : sev, title: `Missing air & sparkle (~${label}, ${amount} under)`, detail: 'Pop masters are glossy. Missing air makes the record sound dull and unfinished.', fix: ['High shelf +2–3 dB at 10–12 kHz on the lead vocal and the mix bus (then de-ess).', 'Add bright percussion (shaker, hi-hat 16ths, tambourine) and an exciter on the backing vocals.'], samples: [{ role: 'Shaker / hat loop for air', query: 'shaker loop', type: 'loop', matchBpm: true, why: 'Adds top-end movement in the choruses.' }, { role: 'Airy vocal breath / texture', query: 'airy vocal texture', type: 'loop', matchKey: true, why: 'Ear candy that fills the very top.' }] };
    default:
      return { ...base, severity: 'polish', title: `Tonal imbalance at ${label}`, detail: `${over ? 'Excess' : 'Lack'} of ${amount}.`, fix: [] };
  }
}

function compareToReference(a, ref, add) {
  for (const { hz, diff, tol } of tonalComparison(a, ref)) {
    if (Math.abs(diff) > tol) {
      const f = tonalFinding(hz, diff, 'mix');
      f.title = `${f.title.replace(/\(.*\)/, '').trim()} vs. your reference (${diff > 0 ? '+' : ''}${diff.toFixed(1)} dB at ${hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`})`;
      add(f);
    }
  }
  const dl = a.loudness.integratedLufs - ref.loudness.integratedLufs;
  if (Math.abs(dl) > 2) {
    add({
      id: 'ref-loudness', severity: 'polish', area: 'Master',
      title: `${Math.abs(dl).toFixed(1)} LU ${dl > 0 ? 'louder' : 'quieter'} than your reference`,
      detail: 'Always level-match before comparing — louder always sounds "better" to the ear.',
      fix: [`Turn the louder one down by ${Math.abs(dl).toFixed(1)} dB when A/B-ing. If this is your final master, ${dl < 0 ? 'add density/limiting' : 'back off the limiter'} to land within ~1 LU.`],
    });
  }
  const dw = a.stereo.correlation - ref.stereo.correlation;
  if (dw > 0.12) {
    add({ id: 'ref-width', severity: 'important', area: 'Mix', title: 'Narrower than your reference', detail: `Correlation ${a.stereo.correlation} vs ${ref.stereo.correlation} — the reference has more stereo spread.`, fix: ['Hard-pan doubled backing vocals/guitars, add stereo pads in choruses, and a stereo plate/room send.'] });
  } else if (dw < -0.15) {
    add({ id: 'ref-wide', severity: 'polish', area: 'Mix', title: 'Wider than your reference', detail: `Correlation ${a.stereo.correlation} vs ${ref.stereo.correlation}. Check your mono compatibility.`, fix: ['Pull back stereo wideners and check the mix in mono.'] });
  }
  const rl = ref.structure.chorusLiftLu, ml = a.structure.chorusLiftLu;
  if (rl !== null && ml !== null && rl - ml > 1.5) {
    add({ id: 'ref-lift', severity: 'important', area: 'Arrangement', title: 'Your chorus lifts less than the reference', detail: `Reference chorus jumps ${fmt(rl)} LU; yours ${fmt(ml)} LU.`, fix: ['Thin out the verse and pre-chorus more, and add layers/impacts on the chorus downbeat.'] });
  }
  const dp = a.peaks.plrDb - ref.peaks.plrDb;
  if (dp < -2.5) {
    add({ id: 'ref-plr', severity: 'important', area: 'Master', title: 'More squashed than your reference', detail: `PLR ${a.peaks.plrDb.toFixed(1)} dB vs ${ref.peaks.plrDb.toFixed(1)} dB — the reference keeps more punch.`, fix: ['Reduce limiting/clipping by 2 dB and use parallel compression for density.'] });
  }
}

function collectSamples(findings, g) {
  const seen = new Set();
  const out = [];
  const push = (s, because) => {
    const k = s.query.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ...s, because });
  };
  for (const f of findings) for (const s of f.samples || []) push(s, f.title);
  for (const s of g.palette) push(s, `${g.label} signature sound`);
  // Always-useful pop production staples.
  push({ role: 'Vocal ad-libs & ear candy', query: 'pop vocal adlib', type: 'oneshot', why: 'Fill gaps between vocal lines and make the chorus feel alive.' }, 'Pop production staple');
  push({ role: 'Transition FX (uplifters, downlifters)', query: 'uplifter downlifter', type: 'oneshot', why: 'Smooth, pro-sounding section changes.' }, 'Pop production staple');
  return out.slice(0, 14);
}
