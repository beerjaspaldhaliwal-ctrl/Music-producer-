// Runs the heavy analysis off the main thread so the UI stays responsive.
import { analyzeTrack } from './analyzer.js';

self.onmessage = (e) => {
  const { id, channels, sampleRate } = e.data;
  try {
    const result = analyzeTrack({ channels, sampleRate }, (progress, label) => {
      self.postMessage({ id, type: 'progress', progress, label });
    });
    self.postMessage({ id, type: 'result', result }, [result.viz.spectrogram.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err.message || String(err) });
  }
};
