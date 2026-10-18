# 🎛️ Pop Co-Producer

Your AI co-producer for pop music. Upload a song and it tells you **what's missing**
the way a top-tier hit producer would. It also links you to **Splice samples already
filtered to your song's key and BPM**, so you can download the exact sounds you need.

## What it does

1. **Measures your track like a mastering studio** (locally, in your browser, so your audio never gets uploaded):
   - Loudness: integrated LUFS (ITU-R BS.1770 / EBU R128), loudness range, short-term energy curve
   - True peak (4× oversampled), clipping detection, DC offset, peak-to-loudness ratio, transient punch
   - Tonal balance by octave band, compared with a modern-pop target curve **or your own reference track**
   - Stereo width, mono compatibility, low-end width
   - Tempo (BPM), key and Camelot code, plus the relative key
   - **Song map**: automatic section detection (intro / verse / pre / chorus / bridge guesses), where the first
     big moment lands, how much the chorus lifts (louder, wider, brighter), and whether the arrangement repeats itself
2. **Producer's read**: a rule-based "producer brain" tuned per pop style (mainstream, dance-pop, pop R&B,
   indie, synth-pop, ballad, Afro-pop, K-pop, Latin pop, hyperpop) and per stage (demo / mix / master). It ranks
   what's missing (critical → important → polish) and gives exact fixes: frequencies, dB, ratios, attack/release,
   arrangement moves.
3. **Splice sample picks**: every suggestion opens `splice.com` pre-filtered by key, mode, BPM and loop/one-shot.
   Each pick also has a **relative-key** link (same notes, other mode) and a pack search.
4. **AI co-producer session** (Claude): reads every measurement, the spectrogram image, the findings and your brief
   (references, goals, lyrics) and writes full session notes:
   - Verdict and hit-readiness score
   - Prioritized list of what's missing
   - Timestamped arrangement map
   - Mix and master chains
   - Hand-picked Splice searches
   - A next-session checklist
   
   You can keep chatting with it afterwards ("give me 3 chorus vocal-stack ideas").

## Run it

Requires [Node.js](https://nodejs.org) 20.12 or newer.

```bash
npm install
cp .env.example .env      # then paste your Anthropic API key into .env
npm start
```

Open **http://localhost:3000**. Then:

1. Drop in your track (WAV, MP3, M4A, FLAC…).
2. Optionally add a reference song you want to sound like.
3. Pick the style and stage.
4. Hit **Analyze**.

The analysis and Splice picks work **without** an API key. Only the AI co-producer session needs one
(get it at https://console.anthropic.com/).

### Tips for the best feedback
- Export a **full stereo bounce** at the same sample rate as your session (WAV is best).
- For mix feedback, export **without** a limiter on the master. Pick "Final master" only for the mastered file.
- Add a **reference track** in the same style. Every comparison then uses that reference, not the generic pop curve.
- Fill in "Sounds like" and "What do you want from this session". The AI tailors its notes to them.

## Project layout

```
server.js            Express server + streaming Claude endpoint (/api/coproduce)
server/prompt.js     The co-producer system prompt and session builder
public/index.html    UI
public/js/dsp.js     FFT, K-weighting filters, helpers
public/js/analyzer.js  Loudness, peaks, spectrum, stereo, tempo, key, song structure
public/js/coach.js   Rule-based pop producer brain (findings, fixes, sample picks)
public/js/splice.js  Splice search-link builder (key / BPM / type filters)
public/js/viz.js     Spectrogram + tonal-balance charts
public/js/app.js     UI logic, worker orchestration, AI chat streaming
test/                node --test suites (npm test)
```

## Notes
- The AI can't literally hear your song. It works from precise measurements and the spectrogram, and it asks you
  about anything it can't measure (vocal tone, lyrics, melody).
- Splice links need a Splice account to download. Searching and previewing works in the browser.
