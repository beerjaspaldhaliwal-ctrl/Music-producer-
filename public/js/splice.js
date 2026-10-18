// Builds Splice search links that open pre-filtered to your song's key and tempo.
// URL format (verified against splice.com):
//   https://splice.com/sounds/search/samples?q=<text>&bpm=<n>&key=<c|c%23|…>&chord_type=<major|minor>&sample_type=<loop|oneshot>

const SPLICE_SAMPLES = 'https://splice.com/sounds/search/samples';
const SPLICE_PACKS = 'https://splice.com/sounds/search/packs';

const FLAT_TO_SHARP = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

function spliceKey(tonic) {
  const sharp = FLAT_TO_SHARP[tonic] || tonic;
  return sharp.toLowerCase();
}

// Encode with %20 for spaces and %23 for sharps, like Splice's own links.
function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/**
 * @param {object} s  { query, type?: 'loop'|'oneshot', matchKey?: boolean, matchBpm?: boolean }
 * @param {object} song  { bpm, key: { tonic, mode } }
 */
export function spliceSearchUrl(s, song) {
  const params = { q: s.query };
  // Tempo only matters for loops; one-shots have no meaningful BPM.
  if (s.matchBpm && s.type !== 'oneshot' && song?.bpm) params.bpm = Math.round(song.bpm);
  if (s.matchKey && song?.key?.tonic) {
    params.key = spliceKey(song.key.tonic);
    params.chord_type = song.key.mode === 'minor' ? 'minor' : 'major';
  }
  if (s.type === 'loop' || s.type === 'oneshot') params.sample_type = s.type;
  params.sort = 'popularity';
  return `${SPLICE_SAMPLES}?${qs(params)}`;
}

// Same notes, other mode (e.g. A minor <-> C major) — doubles the usable pool.
export function relativeKey(key) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const i = names.indexOf(FLAT_TO_SHARP[key.tonic] || key.tonic);
  if (i < 0) return null;
  return key.mode === 'minor'
    ? { tonic: names[(i + 3) % 12], mode: 'major' }
    : { tonic: names[(i + 9) % 12], mode: 'minor' };
}

export function splicePackUrl(query) {
  return `${SPLICE_PACKS}?${qs({ q: query, sort: 'popularity' })}`;
}

export function enrichSampleSuggestion(s, song) {
  const rel = song?.key ? relativeKey(song.key) : null;
  return {
    ...s,
    url: spliceSearchUrl(s, song),
    relativeUrl: s.matchKey && rel ? spliceSearchUrl(s, { ...song, key: rel }) : null,
    relativeLabel: rel ? `${rel.tonic} ${rel.mode}` : null,
    packUrl: splicePackUrl(s.packQuery || s.query),
  };
}
