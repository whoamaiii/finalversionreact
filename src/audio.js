import { AudioContext as StdAudioContext } from 'standardized-audio-context';
import { loadAubio, loadMeyda } from './lazy.js';

// Lazy-load web-audio-beat-detector at runtime with graceful fallbacks.
// Static importing from a CDN can 404 and break the entire app. This keeps the UI alive.
let _guessBpmFn = null;
async function getBeatDetectorGuess() {
  if (_guessBpmFn) return _guessBpmFn;
  const candidates = [
    'https://esm.sh/web-audio-beat-detector@6.3.2',
    'https://cdn.jsdelivr.net/npm/web-audio-beat-detector@6.3.2/+esm',
    'https://cdn.skypack.dev/web-audio-beat-detector@6.3.2',
  ];
  for (const url of candidates) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      // Support different export shapes across CDNs:
      // 1) named export: { guess }
      // 2) default export is the function itself
      // 3) default export object with .guess
      let fn = null;
      if (typeof mod?.guess === 'function') fn = mod.guess;
      else if (typeof mod?.default === 'function') fn = mod.default;
      else if (mod?.default && typeof mod.default.guess === 'function') fn = mod.default.guess;
      if (typeof fn === 'function') {
        _guessBpmFn = fn;
        return _guessBpmFn;
      }
    } catch (_) {
      // try next candidate
    }
  }
  // Final fallback: no-op estimator that resolves to null bpm
  _guessBpmFn = async () => ({ bpm: null });
  return _guessBpmFn;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null; // MediaStreamAudioSourceNode or AudioBufferSourceNode
    this.gainNode = null;
    this.analyser = null;
    this.fftSize = 2048;
    this.freqData = null;
    this.timeData = null;
    this.sampleRate = 48000;

    // Feature extraction state
    this.prevMag = null; // previous normalized magnitude spectrum (Float32)
    this.fluxHistory = [];
    this.fluxWindow = 43; // ~0.5s at 86 fps of analyser pulls (approx)
    this.sensitivity = 1.0; // beat threshold multiplier
    this.smoothing = 0.55; // EMA smoothing for RMS/bands (rave tuned)
    this.bandSplit = { sub: 90, low: 180, mid: 2500 }; // Hz (rave tuned)
    this.beatCooldownMs = 350;
    this._lastBeatMs = -99999;

    this.levels = { rms: 0, rmsEMA: 0, bands: { bass: 0, mid: 0, treble: 0 }, bandsEMA: { bass: 0, mid: 0, treble: 0 }, centroid: 0, centroidEMA: 0 };

    // Per-band adaptive envelopes for punchy yet stable visual mapping
    this.bandEnv = { sub: 0, bass: 0, mid: 0, treble: 0 };
    this.bandPeak = { sub: 0.2, bass: 0.2, mid: 0.2, treble: 0.2 }; // rolling maxima for AGC
    this.envAttack = 0.7;   // 0..1 per-frame attack (rise) speed
    this.envRelease = 0.12; // 0..1 per-frame release (fall) speed
    this.bandAGCDecay = 0.995; // decay factor for rolling maxima
    this.bandAGCEnabled = true;

    // Drop/build detection state
    this.dropEnabled = false;
    this.dropFluxThresh = 1.4; // z-flux threshold to consider build
    this.dropBassThresh = 0.55; // bass env threshold near drop
    this.dropCentroidSlopeThresh = 0.02; // negative slope magnitude
    this.dropMinBeats = 4;
    this.dropCooldownMs = 4000;
    this._buildBeats = 0;
    this._buildLevel = 0; // EMA of positive z-flux
    this._centroidPrev = 0;
    this._centroidSlopeEma = 0;
    this._centroidSlopeAlpha = 0.6; // EMA factor
    this._lastDropMs = -99999;

    this.timeDataFloat = null;

    this._meydaPromise = null;
    this.meyda = null;
    this._meydaLastExtract = 0;
    this._meydaIntervalMs = 1000 / 75; // ~75 Hz refresh
    this._meydaSmoothing = 0.65;
    this.meydaFeatures = {
      mfcc: new Array(13).fill(0.5),
      chroma: new Array(12).fill(0),
      flatness: 0,
      rolloff: 0,
    };

    this.workletNode = null;
    this.workletEnabled = false;
    this._workletInitPromise = null;
    this._workletFrame = null;
    this._workletFrameId = -1;
    this._lastFluxFrameId = -1;
    this._lastMeydaFrameId = -1;
    this._workletFeatures = { rms: 0, flux: 0, fluxMean: 0, fluxStd: 0 };
    this._graphConnected = false;
    this._workletInitAttempted = false;
    this._workletFrameTimestamp = 0;

    this._aubioPromise = null;
    this._aubioModule = null;
    this._aubio = { onset: null, tempo: null, pitch: null };
    this._aubioQueue = [];
    this._aubioLastFrameId = -1;
    this._aubioConfiguredSampleRate = null;
    this.aubioFeatures = {
      pitchHz: 0,
      pitchConf: 0,
      tempoBpm: 0,
      tempoConf: 0,
      lastOnsetMs: 0,
    };
    this._aubioFallbackCounter = 0;

    this._essentiaWorker = null;
    this._essentiaReady = false;
    this._essentiaReadyPromise = null;
    this._essentiaReadyResolver = null;
    this._essentiaCurrentJobId = 0;
    this._essentiaPendingJobId = 0;
    this.beatGrid = {
      bpm: 0,
      confidence: 0,
      beatTimes: [],
      downbeats: [],
      loudness: null,
      source: null,
      updatedAt: 0,
    };

    this.activeStream = null; // to stop tracks when switching
    this.isPlayingFile = false;

    // Tempo assist (optional, for file playback)
    this.bpmEstimate = null; // number | null
    this.tempoAssistEnabled = false;
    this.tempoIntervalMs = 0;
    this._lastTempoMs = 0;
    this._lastAudioBuffer = null; // only set for file playback

    // Tap-tempo & quantization
    this.tapTimestamps = [];
    this.tapBpm = null;
    this.tapTempoIntervalMs = 0;
    this.tapQuantizeEnabled = false;
    this._lastQuantizeMs = 0;
    this._tapMultiplier = 1;

    // Rolling live-audio buffer (for BPM recalc on live sources)
    this._liveBufferSec = 20; // keep ~20s of recent audio
    this._liveBuffer = null; // Float32Array ring buffer (mono)
    this._liveBufferWrite = 0;
    this._liveBufferFilled = 0;

    // Webcam feature removed
  }

  async ensureContext() {
    if (!this.ctx) {
      let Ctor = StdAudioContext;
      if (typeof Ctor !== 'function') {
        // Fallback to native contexts
        Ctor = window.AudioContext || window.webkitAudioContext;
      }
      this.ctx = new Ctor();
      this.sampleRate = this.ctx.sampleRate;
      // Expose for Safari/iOS unlock helper to resume
      try {
        window.__reactiveCtxs = window.__reactiveCtxs || [];
        if (!window.__reactiveCtxs.includes(this.ctx)) window.__reactiveCtxs.push(this.ctx);
      } catch(_) {}
    }
    // Try to resume context on user gestures; harmless if already running
    try {
      if (this.ctx && this.ctx.state !== 'running') {
        await this.ctx.resume();
      }
    } catch(_) {}
    if (!this.gainNode) {
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 1.0;
    }
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = 0.5;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.timeData = new Uint8Array(this.analyser.fftSize);
      this.timeDataFloat = new Float32Array(this.analyser.fftSize);
    }

    if (!this._graphConnected && this.gainNode && this.analyser) {
      this._ensureGraph();
      this._graphConnected = true;
    }

    await this._maybeInitWorklet();
    // Ensure live ring buffer exists once we know actual sampleRate
    this._ensureLiveBuffer();
  }

  async getInputDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput');
  }

  async startMic(deviceId) {
    await this.ensureContext();
    this.stop();
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      this._showToast('Mic requires a secure origin (https or http://localhost).');
      throw new Error('getUserMedia unavailable');
    }
    const constraints = { audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this._useStream(stream);
    return stream;
  }

  async startSystemAudio() {
    await this.ensureContext();
    this.stop();
    const isMac = (() => {
      try {
        const ua = navigator.userAgent || '';
        const plat = navigator.platform || '';
        return /Mac/i.test(ua) || /Mac/i.test(plat);
      } catch (_) { return false; }
    })();
    try {
      const md = (typeof navigator !== 'undefined') ? navigator.mediaDevices : null;
      const rawGetDisplay = (md && md.getDisplayMedia) || (typeof navigator !== 'undefined' ? navigator.getDisplayMedia : null);
      // Debug info to aid environment diagnosis without breaking UX
      try { console.info('DisplayMedia support:', { hasMediaDevices: !!md, hasGetDisplayMedia: !!(md && md.getDisplayMedia), hasLegacyGetDisplayMedia: !!(navigator && navigator.getDisplayMedia), protocol: location.protocol, host: location.hostname }); } catch(_) {}
      if (!rawGetDisplay) {
        const ua = (navigator.userAgent || '').toLowerCase();
        const isChromium = ua.includes('chrome') || ua.includes('edg') || ua.includes('brave');
        const hostOk = (location.protocol === 'https:') || (location.hostname === 'localhost') || (location.hostname === '127.0.0.1');
        const hint = !isChromium ? 'Open in Chrome and try "Tab (Chrome)".' : (!hostOk ? 'Use https or http://localhost.' : '');
        this._showToast(`System/Tab capture unavailable. ${hint}`.trim());
        throw new Error('getDisplayMedia unavailable');
      }
      // Chrome tab/window/screen capture. On macOS, this usually only provides tab audio.
      const stream = await (rawGetDisplay.call ? rawGetDisplay.call(md || navigator, { video: { frameRate: 1 }, audio: true }) : rawGetDisplay({ video: { frameRate: 1 }, audio: true }));
      const hasAudio = !!(stream && typeof stream.getAudioTracks === 'function' && stream.getAudioTracks().length);
      if (!hasAudio) {
        try { for (const t of stream.getTracks()) t.stop(); } catch (_) {}
        const msg = isMac
          ? 'No audio captured. In Chrome, pick a "Chrome Tab" and enable "Share tab audio". For full Mac audio, use BlackHole and select it as Mic.'
          : 'No audio captured. Choose a tab with audio and enable audio sharing.';
        this._showToast(msg);
        const err = new Error('No audio track captured from display media');
        try { err.__reactiveNotified = true; } catch(_) {}
        throw err;
      }
      this._useStream(stream);
      return stream;
    } catch (e) {
      // Provide targeted guidance
      try {
        const name = e?.name || e?.code || '';
        const msg = String(e?.message || '').toLowerCase();
        let notified = false;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          if (isMac) {
            this._showToast('Allow Screen Recording for Chrome: System Settings → Privacy & Security → Screen Recording.');
          } else {
            this._showToast('Capture permission denied. Allow screen + audio capture in your browser.');
          }
          notified = true;
        } else if (name === 'NotFoundError') {
          this._showToast('No capture sources available. Try selecting a specific tab with audio.');
          notified = true;
        } else if (name === 'OverconstrainedError') {
          this._showToast('System audio unsupported with current constraints. Use Chrome tab audio or BlackHole.');
          notified = true;
        } else if (!name && msg.includes('audio') && msg.includes('not')) {
          this._showToast('No audio track captured. Choose Chrome Tab and enable "Share tab audio".');
          notified = true;
        }
        if (notified) { try { e.__reactiveNotified = true; } catch (_) {} }
      } catch (_) {}
      throw e;
    }
  }

  async loadFile(file) {
    await this.ensureContext();
    this.stop();
    const arrayBuf = await file.arrayBuffer();
    const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
    const src = this.ctx.createBufferSource();
    src.buffer = audioBuf; src.loop = true; src.start(0);
    src.connect(this.gainNode);
    this._ensureGraph();
    this.source = src; this.isPlayingFile = true; this.activeStream = null; this._lastAudioBuffer = audioBuf;

    // Fire-and-forget BPM estimation for tempo assist
    this._estimateBpmFromBuffer(audioBuf).catch(() => {});

    this._runEssentiaAnalysis(audioBuf).catch((err) => {
      console.warn('Essentia analysis failed', err);
    });
  }

  stop() {
    try {
      if (this.source && this.source.stop) {
        this.source.stop();
      }
    } catch(_){}
    if (this.activeStream) {
      for (const t of this.activeStream.getTracks()) t.stop();
    }
    this.source = null; this.activeStream = null; this.isPlayingFile = false;
    if (this.workletNode) {
      try { this.workletNode.port.postMessage({ type: 'reset' }); } catch (_) {}
    }
    // Don't clear BPM immediately; allow UI to still show last known value
  }

  // Webcam feature removed: startWebcam/stopWebcam et al removed

  _useStream(stream) {
    if (this.activeStream) {
      for (const t of this.activeStream.getTracks()) t.stop();
    }
    this.activeStream = stream;
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.gainNode);
    this._ensureGraph();
    this.source = src; this.isPlayingFile = false;
  }

  setGain(v) { if (this.gainNode) this.gainNode.gain.value = v; }
  setFFTSize(size) {
    this.fftSize = size;
    if (this.analyser) {
      this.analyser.fftSize = size;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.timeData = new Uint8Array(this.analyser.fftSize);
      this.timeDataFloat = new Float32Array(this.analyser.fftSize);
    }
  }
  setSensitivity(v) { this.sensitivity = v; }
  setSmoothing(v) {
    this.smoothing = v;
    this._meydaSmoothing = this._clamp(v, 0.1, 0.9);
  }
  setBandSplit(lowHz, midHz) { this.bandSplit.low = lowHz; this.bandSplit.mid = midHz; }
  setSubHz(hz) { this.bandSplit.sub = Math.max(20, Math.min(200, hz)); }
  setBeatCooldown(ms) { this.beatCooldownMs = ms; }
  setEnvAttack(v) { this.envAttack = this._clamp(v, 0.0, 1.0); }
  setEnvRelease(v) { this.envRelease = this._clamp(v, 0.0, 1.0); }
  setBandAgcEnabled(v) { this.bandAGCEnabled = !!v; }
  setBandAgcDecay(v) { this.bandAGCDecay = this._clamp(v, 0.90, 0.9999); }
  setDropEnabled(v) { this.dropEnabled = !!v; }
  setDropFluxThresh(v) { this.dropFluxThresh = this._clamp(v, 0.2, 5); }
  setDropBassThresh(v) { this.dropBassThresh = this._clamp(v, 0.1, 1.0); }
  setDropCentroidSlopeThresh(v) { this.dropCentroidSlopeThresh = this._clamp(v, 0.005, 0.2); }
  setDropMinBeats(v) { this.dropMinBeats = Math.max(1, Math.floor(v)); }
  setDropCooldownMs(v) { this.dropCooldownMs = Math.max(500, Math.floor(v)); }

  // Tempo assist API
  setTempoAssistEnabled(v) {
    this.tempoAssistEnabled = !!v;
    const now = performance.now();
    if (this.tempoAssistEnabled) {
      if (this.bpmEstimate && this.bpmEstimate > 0) {
        this.tempoIntervalMs = 60000 / this.bpmEstimate;
        this._lastTempoMs = now;
        this._lastQuantizeMs = now; // align grid phase when enabling
      }
    }
  }
  getBpm() { return this.bpmEstimate || 0; }
  async recalcBpm() {
    if (this._lastAudioBuffer) {
      await this._estimateBpmFromBuffer(this._lastAudioBuffer);
      // Also compute/refresh beat grid via Essentia to backfill BPM if guess failed
      try { this._runEssentiaAnalysis(this._lastAudioBuffer); } catch(_) {}
      return;
    }
    const live = this._buildLiveAudioBuffer(12);
    if (live) {
      await this._estimateBpmFromBuffer(live);
      try { this._runEssentiaAnalysis(live); } catch(_) {}
    } else {
      try { this._showToast('Need a few seconds of live audio before recalculating BPM.'); } catch(_) {}
    }
  }

  // Tap tempo API
  tapBeat() {
    const now = performance.now();
    const taps = this.tapTimestamps;
    // debounce taps that are too close (<120ms)
    if (taps.length && now - taps[taps.length - 1] < 120) return;
    taps.push(now);
    // keep last 8 taps
    if (taps.length > 8) taps.shift();
    if (taps.length >= 2) {
      // compute intervals between consecutive taps
      const intervals = [];
      for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
      // remove outliers using median absolute deviation
      const median = intervals.slice().sort((a,b)=>a-b)[Math.floor(intervals.length/2)];
      const mads = intervals.map(v => Math.abs(v - median));
      const mad = mads.slice().sort((a,b)=>a-b)[Math.floor(mads.length/2)] || 0;
      const filtered = mad > 0 ? intervals.filter(v => Math.abs(v - median) <= 3 * mad) : intervals;
      const avg = filtered.reduce((a,b)=>a+b,0) / filtered.length;
      if (isFinite(avg) && avg > 200 && avg < 2000) {
        const bpm = 60000 / avg;
        const adjustedBpm = bpm * this._tapMultiplier;
        this.tapBpm = Math.round(adjustedBpm);
        this.tapTempoIntervalMs = 60000 / (this.tapBpm || 1);
        this._lastQuantizeMs = now; // reset phase to last tap
      }
    }
  }
  resetTapTempo() { this.tapTimestamps = []; this.tapBpm = null; this.tapTempoIntervalMs = 0; }
  getTapBpm() { return this.tapBpm || 0; }
  setTapQuantizeEnabled(v) { this.tapQuantizeEnabled = !!v; if (this.tapQuantizeEnabled) { this._lastQuantizeMs = performance.now(); } }

  nudgeTapMultiplier(mult) {
    if (!mult || !isFinite(mult)) return;
    this._tapMultiplier = this._clamp(this._tapMultiplier * mult, 0.25, 4);
    const base = this.tapTempoIntervalMs > 0 ? 60000 / this.tapTempoIntervalMs : this.getBpm();
    if (base) {
      const updated = base * this._tapMultiplier;
      this.tapBpm = Math.round(updated);
      this.tapTempoIntervalMs = this.tapBpm ? 60000 / this.tapBpm : 0;
    }
  }

  nudgeQuantizePhase(deltaMs) {
    if (!deltaMs) return;
    const gridActive = (this.tapQuantizeEnabled && this.tapTempoIntervalMs > 0)
      || (this.tempoAssistEnabled && this.tempoIntervalMs > 0);
    if (!gridActive) return;
    this._lastQuantizeMs += deltaMs;
  }

  alignQuantizePhase() {
    this._lastQuantizeMs = performance.now();
  }

  _ensureGraph() {
    if (!this.gainNode || !this.analyser) return;
    try { this.gainNode.disconnect(); } catch (_) {}
    if (this.workletNode) {
      try { this.workletNode.disconnect(); } catch (_) {}
      this.gainNode.connect(this.workletNode);
      this.workletNode.connect(this.analyser);
    } else {
      this.gainNode.connect(this.analyser);
    }
  }

  async _maybeInitWorklet() {
    if (!this.ctx || !this.ctx.audioWorklet || typeof this.ctx.audioWorklet.addModule !== 'function') {
      this.workletEnabled = false;
      return null;
    }
    if (this.workletNode) {
      return this.workletNode;
    }
    if (this._workletInitPromise) {
      return this._workletInitPromise;
    }
    if (this._workletInitAttempted && !this.workletEnabled) {
      return null;
    }
    this._workletInitAttempted = true;
    const workletUrl = new URL('../public/worklets/analysis-processor.js', import.meta.url);
    this._workletInitPromise = this.ctx.audioWorklet.addModule(workletUrl.href)
      .then(() => {
        const node = new AudioWorkletNode(this.ctx, 'analysis-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        node.port.onmessage = (event) => this._handleWorkletMessage(event);
        node.onprocessorerror = (err) => {
          console.error('Analysis processor error', err);
          this.workletEnabled = false;
        };
        this.workletNode = node;
        this.workletEnabled = true;
        this._ensureGraph();
        return node;
      })
      .catch((err) => {
        console.warn('AudioWorklet unavailable, using ScriptProcessor fallback.', err);
        this.workletNode = null;
        this.workletEnabled = false;
        return null;
      })
      .finally(() => {
        this._workletInitPromise = null;
      });
    return this._workletInitPromise;
  }

  _handleWorkletMessage(event) {
    const data = event?.data;
    if (!data || data.type !== 'frame') return;
    const frameId = typeof data.frameId === 'number' ? data.frameId : this._workletFrameId + 1;
    this._workletFrameId = frameId;
    this._workletFrameTimestamp = performance.now();

    let frameArray = null;
    if (data.samples) {
      frameArray = new Float32Array(data.samples);
      this._workletFrame = frameArray;
    }
    if (typeof data.rms === 'number') this._workletFeatures.rms = data.rms;
    if (typeof data.flux === 'number') this._workletFeatures.flux = data.flux;
    if (typeof data.fluxMean === 'number') this._workletFeatures.fluxMean = data.fluxMean;
    if (typeof data.fluxStd === 'number') this._workletFeatures.fluxStd = data.fluxStd;

    if (frameArray) {
      this._enqueueAubioFrame(frameArray, frameId);
      // Append to rolling live buffer for later BPM estimation
      this._appendToLiveBuffer(frameArray);
    }
  }

  _consumeWorkletFlux() {
    if (!this.workletEnabled || this._workletFrameId < 0) {
      return null;
    }
    const frameId = this._workletFrameId;
    const flux = this._workletFeatures.flux ?? 0;
    if (frameId !== this._lastFluxFrameId) {
      this._lastFluxFrameId = frameId;
      this.fluxHistory.push(flux);
      if (this.fluxHistory.length > this.fluxWindow) this.fluxHistory.shift();
      this.prevMag = null; // reset FFT state when using worklet
    }
    return flux;
  }

  async _estimateBpmFromBuffer(buffer) {
    try {
      const guess = await getBeatDetectorGuess();
      const result = await guess(buffer);
      // Support both number and { bpm } shapes from web-audio-beat-detector
      let bpmVal = null;
      if (typeof result === 'number' && isFinite(result)) {
        bpmVal = result;
      } else if (result && typeof result.bpm === 'number' && isFinite(result.bpm)) {
        bpmVal = result.bpm;
      }
      const bpm = bpmVal ? Math.round(bpmVal) : null;
      if (bpm && bpm > 30 && bpm < 300) {
        this.bpmEstimate = bpm;
        this.tempoIntervalMs = 60000 / bpm;
        this._lastTempoMs = performance.now();
        return bpm;
      }
    } catch (e) {
      // Estimation may fail for very short/quiet files; ignore
    }

    // Fallback: run lightweight native estimator on the provided buffer
    try {
      const nativeBpm = this._estimateBpmNativeFromBuffer(buffer);
      if (nativeBpm && nativeBpm > 30 && nativeBpm < 300) {
        const bpm = Math.round(nativeBpm);
        this.bpmEstimate = bpm;
        this.tempoIntervalMs = 60000 / bpm;
        this._lastTempoMs = performance.now();
        return bpm;
      }
    } catch (_) {}

    return null;
  }

  // Minimal, dependency-free BPM estimator using energy-onset autocorrelation.
  _estimateBpmNativeFromBuffer(buffer) {
    if (!buffer) return 0;
    const sr = buffer.sampleRate || this.sampleRate || 44100;
    const hop = 512; // ~11.6ms @ 44.1k
    const size = 1024;
    const mono = this._extractMonoBuffer(buffer);
    if (!mono || mono.length < size * 4) return 0;

    // Build positive-onset envelope from log-energy differences
    const frames = Math.floor((mono.length - size) / hop);
    const onset = new Float32Array(frames);
    let prev = 0;
    for (let i = 0; i < frames; i++) {
      const off = i * hop;
      let e = 0;
      for (let j = 0; j < size; j++) {
        const v = mono[off + j]; e += v * v;
      }
      const loge = Math.log(1e-9 + e);
      const d = loge - prev; prev = loge;
      onset[i] = d > 0 ? d : 0;
    }
    // Normalize and remove DC
    let mean = 0; for (let i = 0; i < onset.length; i++) mean += onset[i]; mean /= Math.max(1, onset.length);
    for (let i = 0; i < onset.length; i++) onset[i] = Math.max(0, onset[i] - mean);
    let maxv = 0; for (let i = 0; i < onset.length; i++) maxv = Math.max(maxv, onset[i]);
    if (maxv > 0) { for (let i = 0; i < onset.length; i++) onset[i] /= maxv; }

    const fps = sr / hop; // envelope frames per second
    const minBpm = 60, maxBpm = 200;
    const minLag = Math.max(1, Math.round(fps * 60 / maxBpm));
    const maxLag = Math.min(onset.length - 1, Math.round(fps * 60 / minBpm));
    if (maxLag <= minLag + 1) return 0;

    // Autocorrelation in BPM search window
    let bestLag = 0; let bestScore = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = lag; i < onset.length; i++) acc += onset[i] * onset[i - lag];
      // Penalize likely double/half tempos by checking harmonic lags
      const half = lag >> 1; const dbl = lag << 1;
      if (half >= minLag) acc *= 1.0 - 0.1 * (onset[half] || 0);
      if (dbl <= maxLag) acc *= 1.0 - 0.05 * (onset[dbl] || 0);
      if (acc > bestScore) { bestScore = acc; bestLag = lag; }
    }
    if (bestLag <= 0) return 0;
    let bpm = 60 * fps / bestLag;
    // Snap to musically plausible octave (prefer 80..180)
    while (bpm < 80) bpm *= 2;
    while (bpm > 180) bpm *= 0.5;
    return bpm;
  }

  _ensureLiveBuffer() {
    const sr = this.sampleRate || 44100;
    const desiredLength = Math.max(1, Math.floor(sr * this._liveBufferSec));
    if (!this._liveBuffer || this._liveBuffer.length !== desiredLength) {
      this._liveBuffer = new Float32Array(desiredLength);
      this._liveBufferWrite = 0;
      this._liveBufferFilled = 0;
    }
  }

  _appendToLiveBuffer(samples) {
    if (!samples || !samples.length) return;
    this._ensureLiveBuffer();
    const buf = this._liveBuffer;
    const N = buf.length;
    let w = this._liveBufferWrite;
    for (let i = 0; i < samples.length; i++) {
      buf[w++] = samples[i];
      if (w >= N) w = 0;
    }
    this._liveBufferWrite = w;
    this._liveBufferFilled = Math.min(N, this._liveBufferFilled + samples.length);
  }

  _buildLiveAudioBuffer(seconds = 12) {
    if (!this.ctx || !this._liveBuffer || !this._liveBufferFilled) return null;
    const sr = this.sampleRate || 44100;
    const want = Math.max(0, Math.floor(seconds * sr));
    const N = Math.min(want, this._liveBufferFilled);
    if (N < sr * 4) { // need at least ~4s to get a stable guess
      return null;
    }
    const out = new Float32Array(N);
    const ring = this._liveBuffer;
    const R = ring.length;
    let start = this._liveBufferWrite - N;
    while (start < 0) start += R;
    const firstLen = Math.min(N, R - start);
    out.set(ring.subarray(start, start + firstLen), 0);
    const remaining = N - firstLen;
    if (remaining > 0) {
      out.set(ring.subarray(0, remaining), firstLen);
    }
    const audioBuf = this.ctx.createBuffer(1, N, sr);
    try {
      audioBuf.copyToChannel(out, 0, 0);
    } catch (_) {
      const ch0 = audioBuf.getChannelData(0);
      ch0.set(out);
    }
    return audioBuf;
  }

  _ensureMeydaLoaded() {
    if (!this._meydaPromise) {
      this._meydaPromise = loadMeyda()
        .then((mod) => {
          this.meyda = mod;
          return mod;
        })
        .catch((err) => {
          console.warn('Meyda failed to load', err);
          this.meyda = null;
          this._meydaPromise = null;
          return null;
        });
    }
    return this._meydaPromise;
  }

  _ensureAubioLoaded() {
    if (this._aubioPromise) {
      return this._aubioPromise;
    }
    this._aubioPromise = loadAubio()
      .then(async (factory) => {
        if (typeof factory === 'function') {
          const module = await factory();
          this._aubioModule = module;
          this._setupAubioNodes();
          return module;
        }
        this._aubioModule = factory;
        this._setupAubioNodes();
        return factory;
      })
      .catch((err) => {
        console.warn('Aubio failed to load', err);
        this._aubioModule = null;
        this._aubioPromise = null;
        return null;
      });
    return this._aubioPromise;
  }

  _setupAubioNodes() {
    const module = this._aubioModule;
    if (!module) return;
    const sr = this.sampleRate || 44100;
    if (this._aubioConfiguredSampleRate === sr && this._aubio.onset && this._aubio.pitch && this._aubio.tempo) {
      return;
    }

    const bufferSize = 512;
    const hopSize = 512;

    try {
      this._aubio.onset = new module.Onset('default', bufferSize, hopSize, sr);
    } catch (err) {
      console.warn('Aubio onset unavailable', err);
      this._aubio.onset = null;
    }
    try {
      this._aubio.tempo = new module.Tempo('default', bufferSize, hopSize, sr);
    } catch (err) {
      console.warn('Aubio tempo unavailable', err);
      this._aubio.tempo = null;
    }
    try {
      this._aubio.pitch = new module.Pitch('yin', bufferSize, hopSize, sr);
      if (this._aubio.pitch.setTolerance) this._aubio.pitch.setTolerance(0.2);
    } catch (err) {
      console.warn('Aubio pitch unavailable', err);
      this._aubio.pitch = null;
    }

    this._aubioConfiguredSampleRate = sr;

    if (this._aubioQueue.length) {
      const queued = this._aubioQueue.slice();
      this._aubioQueue.length = 0;
      for (const item of queued) {
        this._processAubioFrame(item.buffer, item.frameId);
      }
    }
  }

  _enqueueAubioFrame(buffer, frameId = -1) {
    if (!buffer) return;
    if (this._aubioModule && this._aubio.onset && this._aubio.pitch) {
      if (frameId === this._aubioLastFrameId) return;
      this._processAubioFrame(buffer, frameId);
      return;
    }

    if (this._aubioQueue.length > 12) {
      this._aubioQueue.shift();
    }
    this._aubioQueue.push({ buffer: buffer.slice(0), frameId });
    this._ensureAubioLoaded();
  }

  _processAubioFrame(buffer, frameId = -1) {
    if (!buffer || !buffer.length) return;
    if (frameId === this._aubioLastFrameId) return;
    this._aubioLastFrameId = frameId;

    this._ensureAubioLoaded();
    if (!this._aubioModule) return;
    this._setupAubioNodes();

    try {
      if (this._aubio.onset) {
        const onset = this._aubio.onset.do(buffer);
        if (onset) {
          this.aubioFeatures.lastOnsetMs = performance.now();
        }
      }
    } catch (err) {
      // ignore individual frame errors
    }

    try {
      if (this._aubio.tempo) {
        this._aubio.tempo.do(buffer);
        const bpm = typeof this._aubio.tempo.getBpm === 'function' ? this._aubio.tempo.getBpm() : null;
        const conf = typeof this._aubio.tempo.getConfidence === 'function' ? this._aubio.tempo.getConfidence() : 0;
        if (typeof bpm === 'number' && isFinite(bpm) && bpm > 30 && bpm < 300) {
          this.aubioFeatures.tempoBpm = bpm;
          this.aubioFeatures.tempoConf = conf || 0;
        }
      }
    } catch (err) {
      // ignore
    }

    try {
      if (this._aubio.pitch) {
        const pitch = this._aubio.pitch.do(buffer);
        const conf = typeof this._aubio.pitch.getConfidence === 'function' ? this._aubio.pitch.getConfidence() : 0;
        if (typeof pitch === 'number' && isFinite(pitch) && pitch > 0) {
          this.aubioFeatures.pitchHz = pitch;
          this.aubioFeatures.pitchConf = conf || 0;
        } else {
          this.aubioFeatures.pitchConf = conf || this.aubioFeatures.pitchConf;
        }
      }
    } catch (err) {
      // ignore
    }
  }

  async _initEssentiaWorker() {
    if (this._essentiaWorker && this._essentiaReady) {
      return this._essentiaWorker;
    }
    if (this._essentiaWorker && this._essentiaReadyPromise) {
      await this._essentiaReadyPromise;
      return this._essentiaWorker;
    }

    const workerUrl = new URL('../public/workers/essentia-worker.js', import.meta.url);
    this._essentiaWorker = new Worker(workerUrl.href, { type: 'module' });
    this._essentiaReady = false;
    this._essentiaReadyPromise = new Promise((resolve) => {
      this._essentiaReadyResolver = resolve;
    });
    this._essentiaWorker.onmessage = (event) => this._handleEssentiaMessage(event);
    this._essentiaWorker.onerror = (err) => {
      console.error('Essentia worker error', err);
      this._essentiaReady = false;
    };
    try {
      this._essentiaWorker.postMessage({ type: 'init' });
    } catch (err) {
      console.warn('Failed to init Essentia worker', err);
      throw err;
    }
    await this._essentiaReadyPromise;
    return this._essentiaWorker;
  }

  _handleEssentiaMessage(event) {
    const data = event?.data;
    if (!data) return;
    if (data.type === 'ready') {
      this._essentiaReady = true;
      if (this._essentiaReadyResolver) {
        this._essentiaReadyResolver();
        this._essentiaReadyResolver = null;
      }
      this._essentiaReadyPromise = Promise.resolve(this._essentiaWorker);
      return;
    }
    if (data.type === 'error') {
      // Keep console details for developers, but show a concise toast to users
      console.warn('Essentia worker error', data.error);
      try {
        this._showToast('Beat grid unavailable (analysis module failed). Playback continues.');
      } catch(_) {}
      return;
    }
    if (data.type === 'result') {
      const { jobId, result } = data;
      if (jobId && jobId === this._essentiaCurrentJobId) {
        this._applyEssentiaResult(result);
      }
    }
  }

  _showToast(message) {
    try {
      let el = document.getElementById('toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.style.position = 'fixed';
        el.style.left = '50%';
        el.style.bottom = '80px';
        el.style.transform = 'translateX(-50%)';
        el.style.zIndex = '70';
        el.style.padding = '10px 14px';
        el.style.borderRadius = '12px';
        el.style.border = '1px solid rgba(255,255,255,0.25)';
        el.style.background = 'rgba(0,0,0,0.6)';
        el.style.color = '#fff';
        el.style.backdropFilter = 'blur(10px)';
        el.style.webkitBackdropFilter = 'blur(10px)';
        document.body.appendChild(el);
      }
      el.textContent = message;
      el.style.opacity = '1';
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { el.style.transition = 'opacity 0.4s ease'; el.style.opacity = '0'; }, 3000);
    } catch(_) {}
  }

  async _runEssentiaAnalysis(buffer) {
    try {
      await this._initEssentiaWorker();
    } catch (err) {
      return;
    }
    if (!this._essentiaWorker) return;

    const mono = this._extractMonoBuffer(buffer);
    if (!mono) return;

    const jobId = ++this._essentiaCurrentJobId;
    this._essentiaPendingJobId = jobId;
    try {
      this._essentiaWorker.postMessage({
        type: 'analyze',
        jobId,
        payload: {
          sampleRate: buffer.sampleRate,
          duration: buffer.duration,
          channelData: mono,
        },
      }, [mono.buffer]);
    } catch (err) {
      console.warn('Failed to post Essentia job', err);
    }
  }

  _extractMonoBuffer(buffer) {
    if (!buffer) return null;
    const length = buffer.length;
    const channels = buffer.numberOfChannels || 1;
    const mono = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const channelData = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        mono[i] += channelData[i] / channels;
      }
    }
    return mono;
  }

  _applyEssentiaResult(result) {
    if (!result) return;
    this.beatGrid = {
      bpm: result.bpm || 0,
      confidence: result.confidence || 0,
      beatTimes: Array.isArray(result.beatTimes) ? result.beatTimes.slice() : [],
      downbeats: Array.isArray(result.downbeats) ? result.downbeats.slice() : [],
      loudness: result.loudness || null,
      source: 'essentia',
      updatedAt: performance.now(),
      duration: result.duration || 0,
    };

    // Also propagate BPM estimate from analysis so UI updates even if guess() failed.
    const bpm = typeof result.bpm === 'number' && isFinite(result.bpm) ? Math.round(result.bpm) : 0;
    if (bpm > 30 && bpm < 300) {
      this.bpmEstimate = bpm;
      this.tempoIntervalMs = 60000 / bpm;
      this._lastTempoMs = performance.now();
    }
  }

  quantizeToGrid(timeSeconds, grid = this.beatGrid) {
    if (!grid || !Array.isArray(grid.beatTimes) || grid.beatTimes.length === 0) {
      return null;
    }
    const beats = grid.beatTimes;
    let lo = 0;
    let hi = beats.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] < timeSeconds) lo = mid + 1;
      else hi = mid - 1;
    }
    const idx = Math.min(beats.length - 1, Math.max(0, lo));
    const prevIdx = Math.max(0, idx - 1);
    const candidateA = beats[idx];
    const candidateB = beats[prevIdx];
    const target = (Math.abs(candidateA - timeSeconds) <= Math.abs(candidateB - timeSeconds)) ? { time: candidateA, index: idx } : { time: candidateB, index: prevIdx };
    const interval = grid.bpm ? 60 / grid.bpm : (target.index + 1 < beats.length ? beats[target.index + 1] - beats[target.index] : 0);
    const driftSec = timeSeconds - target.time;
    return {
      quantizedTime: target.time,
      beatIndex: target.index,
      driftSeconds: driftSec,
      driftMs: driftSec * 1000,
      intervalSeconds: interval,
      bpm: grid.bpm,
      confidence: grid.confidence,
    };
  }

  _maybeRunMeyda(now) {
    if (!this.analyser) return this.meydaFeatures;
    this._ensureMeydaLoaded();
    if (!this.meyda || typeof this.meyda.extract !== 'function') return this.meydaFeatures;

    if (now - this._meydaLastExtract < this._meydaIntervalMs) {
      return this.meydaFeatures;
    }

    let bufferForAnalysis = null;
    let bufferSize = 0;
    let frameIdForMeyda = -1;
    let aubioCandidate = null;

    if (this.workletEnabled && this._workletFrame && this._workletFrameId !== this._lastMeydaFrameId) {
      bufferForAnalysis = this._workletFrame;
      bufferSize = bufferForAnalysis.length;
      frameIdForMeyda = this._workletFrameId;
    } else {
      if (!this.timeDataFloat || this.timeDataFloat.length !== this.analyser.fftSize) {
        this.timeDataFloat = new Float32Array(this.analyser.fftSize);
      }
      try {
        this.analyser.getFloatTimeDomainData(this.timeDataFloat);
      } catch (err) {
        return this.meydaFeatures;
      }
      bufferForAnalysis = this.timeDataFloat;
      bufferSize = bufferForAnalysis.length;
      aubioCandidate = this._makeAubioBuffer(bufferForAnalysis);
    }

    this._meydaLastExtract = now;
    if (frameIdForMeyda >= 0) {
      this._lastMeydaFrameId = frameIdForMeyda;
      if (!aubioCandidate) {
        aubioCandidate = this._makeAubioBuffer(bufferForAnalysis);
      }
    }

    const params = {
      bufferSize,
      sampleRate: this.sampleRate || 44100,
      numberOfMFCCCoefficients: 13,
    };

    let result;
    try {
      result = this.meyda.extract(
        ['mfcc', 'chroma', 'spectralFlatness', 'spectralRolloff'],
        bufferForAnalysis,
        params,
      );
    } catch (err) {
      // Meyda may throw if fed denormal data; skip frame
      return this.meydaFeatures;
    }

    if (aubioCandidate) {
      const frameId = frameIdForMeyda >= 0 ? frameIdForMeyda : ++this._aubioFallbackCounter;
      this._enqueueAubioFrame(aubioCandidate, frameId);
    }

    // If worklet is unavailable, still accumulate a best-effort live buffer
    if (!this.workletEnabled && bufferForAnalysis) {
      this._appendToLiveBuffer(bufferForAnalysis);
    }

    if (!result) return this.meydaFeatures;

    const mfccRaw = Array.isArray(result.mfcc) ? result.mfcc.slice(0, 13) : [];
    while (mfccRaw.length < 13) mfccRaw.push(0);
    const chromaRaw = Array.isArray(result.chroma) ? result.chroma.slice(0, 12) : [];
    while (chromaRaw.length < 12) chromaRaw.push(0);

    const normalizedMfcc = mfccRaw.map((v) => 0.5 + 0.5 * Math.tanh((Number.isFinite(v) ? v : 0) / 20));
    const normalizedChroma = chromaRaw.map((v) => this._clamp(Number.isFinite(v) ? v : 0, 0, 1));
    const flatness = this._clamp(Number.isFinite(result.spectralFlatness) ? result.spectralFlatness : 0, 0, 1);
    const rolloffNorm = this._clamp(
      Number.isFinite(result.spectralRolloff) && this.sampleRate
        ? result.spectralRolloff / (this.sampleRate / 2)
        : 0,
      0,
      1,
    );

    const alpha = this._clamp(this._meydaSmoothing, 0, 0.95);
    const inv = 1 - alpha;
    for (let i = 0; i < this.meydaFeatures.mfcc.length; i++) {
      this.meydaFeatures.mfcc[i] = this.meydaFeatures.mfcc[i] * alpha + (normalizedMfcc[i] ?? 0.5) * inv;
    }
    for (let i = 0; i < this.meydaFeatures.chroma.length; i++) {
      this.meydaFeatures.chroma[i] = this.meydaFeatures.chroma[i] * alpha + (normalizedChroma[i] ?? 0) * inv;
    }
    this.meydaFeatures.flatness = this.meydaFeatures.flatness * alpha + flatness * inv;
    this.meydaFeatures.rolloff = this.meydaFeatures.rolloff * alpha + rolloffNorm * inv;

    return this.meydaFeatures;
  }

  _clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  _makeAubioBuffer(source) {
    if (!source || !source.length) return null;
    const targetSize = 512;
    if (source.length === targetSize) {
      return source.slice(0);
    }
    const target = new Float32Array(targetSize);
    const stride = source.length / targetSize;
    for (let i = 0; i < targetSize; i++) {
      const idx = Math.min(source.length - 1, Math.floor(i * stride));
      target[i] = source[idx];
    }
    return target;
  }

  _computeRMS(timeData) {
    // timeData 0..255, center ~128
    let sumSq = 0; const N = timeData.length;
    for (let i = 0; i < N; i++) { const v = (timeData[i] - 128) / 128; sumSq += v * v; }
    const rms = Math.sqrt(sumSq / N);
    return rms; // 0..~1
  }

  _computeBands(freqData) {
    // freqData 0..255, linear bins up to Nyquist
    const sr = this.sampleRate; const binHz = sr / 2 / freqData.length; // freq per bin
    let sub = 0, bass = 0, mid = 0, treble = 0; let sC = 0, bC = 0, mC = 0, tC = 0;
    const subHz = Math.max(20, Math.min(this.bandSplit.sub || 90, (this.bandSplit.low || 180) - 5));
    for (let i = 0; i < freqData.length; i++) {
      const f = i * binHz; const v = freqData[i] / 255;
      if (f < subHz) { sub += v; sC++; }
      else if (f < this.bandSplit.low) { bass += v; bC++; }
      else if (f < this.bandSplit.mid) { mid += v; mC++; }
      else { treble += v; tC++; }
    }
    sub = sC ? sub / sC : 0; bass = bC ? bass / bC : 0; mid = mC ? mid / mC : 0; treble = tC ? treble / tC : 0;

    // Adaptive gain control (rolling peak) for rave music dynamics
    if (this.bandAGCEnabled) {
      this.bandPeak.sub = Math.max(this.bandPeak.sub * this.bandAGCDecay, sub);
      this.bandPeak.bass = Math.max(this.bandPeak.bass * this.bandAGCDecay, bass);
      this.bandPeak.mid = Math.max(this.bandPeak.mid * this.bandAGCDecay, mid);
      this.bandPeak.treble = Math.max(this.bandPeak.treble * this.bandAGCDecay, treble);
    }

    // Normalize by current peaks to get 0..1 responsiveness across tracks
    const ns = this.bandAGCEnabled && this.bandPeak.sub > 1e-6 ? this._clamp(sub / this.bandPeak.sub, 0, 1) : this._clamp(sub, 0, 1);
    const nb = this.bandAGCEnabled && this.bandPeak.bass > 1e-6 ? this._clamp(bass / this.bandPeak.bass, 0, 1) : this._clamp(bass, 0, 1);
    const nm = this.bandAGCEnabled && this.bandPeak.mid > 1e-6 ? this._clamp(mid / this.bandPeak.mid, 0, 1) : this._clamp(mid, 0, 1);
    const nt = this.bandAGCEnabled && this.bandPeak.treble > 1e-6 ? this._clamp(treble / this.bandPeak.treble, 0, 1) : this._clamp(treble, 0, 1);

    // Attack/Release envelope for each band to keep motion musical
    const attack = this.envAttack; const release = this.envRelease;
    const stepEnv = (env, val) => (val > env) ? (env + (val - env) * attack) : (env + (val - env) * release);
    this.bandEnv.sub = stepEnv(this.bandEnv.sub, ns);
    this.bandEnv.bass = stepEnv(this.bandEnv.bass, nb);
    this.bandEnv.mid = stepEnv(this.bandEnv.mid, nm);
    this.bandEnv.treble = stepEnv(this.bandEnv.treble, nt);

    return { sub, bass, mid, treble, norm: { sub: ns, bass: nb, mid: nm, treble: nt }, env: { ...this.bandEnv } };
  }

  _computeCentroid(freqData) {
    const sr = this.sampleRate; const N = freqData.length; const binHz = sr / 2 / N;
    let num = 0, den = 0;
    for (let i = 0; i < N; i++) { const mag = freqData[i] / 255; const f = i * binHz; num += f * mag; den += mag; }
    const centroidHz = den > 0 ? num / den : 0; // 0..Nyquist
    // Normalize roughly to 0..1 over 0..8000 Hz for music brightness (cap)
    const norm = Math.min(1, centroidHz / 8000);
    return { hz: centroidHz, norm };
  }

  _computeFlux(freqData) {
    // Normalize spectrum to 0..1
    const N = freqData.length; const mag = new Float32Array(N);
    for (let i = 0; i < N; i++) mag[i] = freqData[i] / 255;
    let flux = 0;
    if (this.prevMag) {
      for (let i = 0; i < N; i++) {
        const d = mag[i] - this.prevMag[i]; if (d > 0) flux += d;
      }
    }
    this.prevMag = mag;
    this.fluxHistory.push(flux);
    if (this.fluxHistory.length > this.fluxWindow) this.fluxHistory.shift();
    return flux;
  }

  _detectBeat(flux) {
    if (this.fluxHistory.length < 5) return false;
    const now = performance.now(); if (now - this._lastBeatMs < this.beatCooldownMs) return false;
    // Adaptive threshold: mean + k*std
    const mean = this.fluxHistory.reduce((a,b)=>a+b,0) / this.fluxHistory.length;
    const variance = this.fluxHistory.reduce((a,b)=>a+(b-mean)*(b-mean),0) / this.fluxHistory.length;
    const std = Math.sqrt(variance);
    const threshold = mean + std * (0.8 + 0.8 * this.sensitivity); // sensitivity 0..2
    if (flux > threshold) { this._lastBeatMs = now; return true; }
    return false;
  }

  update() {
    if (!this.analyser) return null;
    this.analyser.getByteTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);

    const useWorkletRms = this.workletEnabled && this._workletFrameId >= 0;
    const rms = useWorkletRms ? this._workletFeatures.rms : this._computeRMS(this.timeData);
    const bands = this._computeBands(this.freqData);
    const centroid = this._computeCentroid(this.freqData);
    const fluxFromWorklet = this._consumeWorkletFlux();
    const flux = fluxFromWorklet ?? this._computeFlux(this.freqData);
    let beat = this._detectBeat(flux);

    // Live tempo assist: prefer file BPM; else use Aubio tempo for live sources
    const now = performance.now();
    if (this.tempoAssistEnabled) {
      if (this.isPlayingFile) {
        // keep bpmEstimate from file analysis if available
        if (this.bpmEstimate && this.bpmEstimate > 0) {
          this.tempoIntervalMs = 60000 / this.bpmEstimate;
        }
      } else {
        const liveBpm = this.aubioFeatures.tempoBpm;
        const liveConf = this.aubioFeatures.tempoConf;
        if (typeof liveBpm === 'number' && isFinite(liveBpm) && liveBpm > 30 && liveBpm < 300 && (liveConf ?? 0) >= 0.05) {
          const rounded = Math.round(liveBpm);
          if (!this.bpmEstimate || Math.abs(rounded - this.bpmEstimate) >= 1) {
            this.bpmEstimate = rounded;
            this.tempoIntervalMs = 60000 / this.bpmEstimate;
            this._lastTempoMs = now;
          }
        }
      }
    }

    // Tempo-assist beat pulse (file playback or live) and/or Tap-Quantized grid
    let quantBeat = false;
    const gridInterval = (this.tapQuantizeEnabled && this.tapTempoIntervalMs > 0)
      ? this.tapTempoIntervalMs
      : (this.tempoAssistEnabled && this.tempoIntervalMs > 0 ? this.tempoIntervalMs : 0);
    if (gridInterval > 0) {
      if (now - this._lastQuantizeMs >= gridInterval) {
        const steps = Math.floor((now - this._lastQuantizeMs) / gridInterval);
        this._lastQuantizeMs += steps * gridInterval;
        quantBeat = true;
      }
    }

    // Align detected onsets to grid by resetting phase on real beat
    if (beat && gridInterval > 0) {
      this._lastQuantizeMs = now;
    }
    const aubioOnsetPulse = this.aubioFeatures.lastOnsetMs > 0 && (now - this.aubioFeatures.lastOnsetMs) < 150;

    beat = beat || quantBeat || aubioOnsetPulse;

    // Smooth
    const a = this.smoothing; const inv = 1 - a;
    this.levels.rmsEMA = this.levels.rmsEMA * a + rms * inv;
    this.levels.bandsEMA.bass = this.levels.bandsEMA.bass * a + bands.bass * inv;
    this.levels.bandsEMA.mid = this.levels.bandsEMA.mid * a + bands.mid * inv;
    this.levels.bandsEMA.treble = this.levels.bandsEMA.treble * a + bands.treble * inv;
    this.levels.centroidEMA = this.levels.centroidEMA * a + centroid.norm * inv;

    const meyda = this._maybeRunMeyda(now);

    // Build/Drop detection (beat-aware)
    let drop = false;
    let isBuilding = false;
    let buildLevel = this._buildLevel;
    let centroidSlope = this._centroidSlopeEma;
    if (this.dropEnabled) {
      const z = this._workletFeatures && this._workletFeatures.fluxStd > 0
        ? (flux - this._workletFeatures.fluxMean) / Math.max(1e-3, this._workletFeatures.fluxStd)
        : 0;
      const posZ = Math.max(0, z);
      buildLevel = buildLevel * 0.8 + posZ * 0.2;
      const cDelta = centroid.norm - (this._centroidPrev || centroid.norm);
      this._centroidPrev = centroid.norm;
      centroidSlope = centroidSlope * (1 - this._centroidSlopeAlpha) + cDelta * this._centroidSlopeAlpha;

      if (beat || quantBeat) {
        if (posZ > this.dropFluxThresh) {
          this._buildBeats += 1; isBuilding = true;
        } else {
          this._buildBeats = Math.max(0, this._buildBeats - 1);
          isBuilding = this._buildBeats > 0;
        }

        const nowMs = performance.now();
        const canDrop = (nowMs - this._lastDropMs) > this.dropCooldownMs;
        if (canDrop && this._buildBeats >= this.dropMinBeats) {
          if (centroidSlope < -this.dropCentroidSlopeThresh && (bands.env?.bass ?? 0) > this.dropBassThresh) {
            drop = true; this._lastDropMs = nowMs; this._buildBeats = 0; isBuilding = false;
          }
        }
      }
      this._buildLevel = buildLevel; this._centroidSlopeEma = centroidSlope;
    }

    return {
      rms: rms,
      rmsNorm: Math.min(1, rms * 2.0),
      bands,
      bandsEMA: this.levels.bandsEMA,
      bandEnv: bands.env,
      bandNorm: bands.norm,
      centroidHz: centroid.hz,
      centroidNorm: centroid.norm,
      flux,
      fluxMean: this.workletEnabled ? this._workletFeatures.fluxMean : flux,
      fluxStd: this.workletEnabled ? this._workletFeatures.fluxStd : 0,
      beat,
      drop,
      isBuilding,
      buildLevel,
      lastDropMs: this._lastDropMs,
      bpm: this.bpmEstimate || 0,
      tapBpm: this.tapBpm || 0,
      mfcc: meyda.mfcc,
      chroma: meyda.chroma,
      flatness: meyda.flatness,
      rolloff: meyda.rolloff,
      pitchHz: this.aubioFeatures.pitchHz,
      pitchConf: this.aubioFeatures.pitchConf,
      aubioTempoBpm: this.aubioFeatures.tempoBpm,
      aubioTempoConf: this.aubioFeatures.tempoConf,
      aubioOnset: aubioOnsetPulse,
      beatGrid: this.beatGrid,
    };
  }
}
