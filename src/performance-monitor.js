/**
 * PerformanceMonitor
 * -------------------
 *
 * High-precision performance instrumentation purposely built for the VJ control
 * application. The monitor is designed to collect actionable telemetry while
 * keeping runtime overhead negligible (< 0.5ms per frame). It consolidates frame
 * cadence, CPU/GPU timings, memory pressure, and Three.js renderer statistics so
 * higher-level systems can adapt quality settings before problems become visible.
 *
 * Key features implemented in Phase 1 (Metrics Collection Infrastructure):
 *   - Frame timing (instant + rolling averages)
 *   - CPU time on the main thread (per-frame + rolling)
 *   - Optional audio worklet timing (ingest via recordAudioWorkletSample)
 *   - GPU timing via EXT_disjoint_timer_query (auto-instrumented when available)
 *   - Renderer info snapshots (draw calls, triangle counts, geometry counts)
 *   - Dropped frame detection and render budget utilisation
 *   - Memory sampling (Chromium-only performance.memory)
 *   - Layout shift, paint, and long task observers (PerformanceObserver)
 *   - Trend sampling window (10s rolling average for predictive heuristics)
 *
 * The class is intentionally decoupled from the animation loop. Callers should
 * invoke beginFrame() at the start of their RAF callback and endFrame() after
 * rendering completes. Optional helpers allow instrumentation of renderer.render
 * so GPU timers wrap every draw automatically.
 */

const DEFAULT_SAMPLE_SIZE = 120;
const DEFAULT_AUDIO_SAMPLE_SIZE = 300;
const DEFAULT_HISTORY_SIZE = 600;
const DEFAULT_RENDER_BUDGET_MS = 1000 / 60; // 60 FPS target
const DEFAULT_DROP_THRESHOLD_MULTIPLIER = 1.35;
const DEFAULT_MEMORY_SAMPLE_INTERVAL_MS = 2000;
const DEFAULT_TREND_WINDOW_MS = 10000; // 10 seconds
const MAX_GPU_QUERIES_IN_FLIGHT = 4;
const GPU_QUERY_TIMEOUT_MS = 5000;

const now = () => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

class RollingMetric {
  constructor(size) {
    this.size = Math.max(1, size | 0);
    this.values = new Float32Array(this.size);
    this.count = 0;
    this.index = 0;
    this.sum = 0;
    this._min = Infinity;
    this._max = -Infinity;
    this._latest = 0;
  }

  push(value) {
    if (!Number.isFinite(value)) return;

    const capped = value <= 0 ? 0 : value;
    let old = 0;
    if (this.count === this.size) {
      old = this.values[this.index];
    }

    this.values[this.index] = capped;
    this.index = (this.index + 1) % this.size;

    if (this.count < this.size) {
      this.count += 1;
      this.sum += capped;
    } else {
      this.sum += capped - old;
    }

    if (capped < this._min) this._min = capped;
    if (capped > this._max) this._max = capped;

    if (this.count === this.size && (old === this._min || old === this._max)) {
      this._recomputeExtrema();
    }

    this._latest = capped;
  }

  _recomputeExtrema() {
    if (!this.count) {
      this._min = Infinity;
      this._max = -Infinity;
      return;
    }

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.count; i += 1) {
      const v = this.values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    this._min = min;
    this._max = max;
  }

  get average() {
    return this.count ? this.sum / this.count : 0;
  }

  get min() {
    return this.count ? this._min : 0;
  }

  get max() {
    return this.count ? this._max : 0;
  }

  get latest() {
    return this._latest;
  }
}

export class PerformanceMonitor {
  constructor(options = {}) {
    const {
      renderer = null,
      sampleSize = DEFAULT_SAMPLE_SIZE,
      trendWindowMs = DEFAULT_TREND_WINDOW_MS,
      historySize = DEFAULT_HISTORY_SIZE,
      renderBudgetMs = DEFAULT_RENDER_BUDGET_MS,
      dropThresholdMultiplier = DEFAULT_DROP_THRESHOLD_MULTIPLIER,
      memorySampleIntervalMs = DEFAULT_MEMORY_SAMPLE_INTERVAL_MS,
      onMetricsUpdated = null,
      autoInstrumentRenderer = true,
      observePaint = true,
      observeLongTasks = true,
      observeLayoutShifts = true,
    } = options;

    this._renderer = renderer;
    this._onMetricsUpdated = typeof onMetricsUpdated === 'function' ? onMetricsUpdated : null;

    this._frameMetric = new RollingMetric(sampleSize);
    this._cpuMetric = new RollingMetric(sampleSize);
    this._gpuMetric = new RollingMetric(Math.min(sampleSize, 240));
    this._audioMetric = new RollingMetric(DEFAULT_AUDIO_SAMPLE_SIZE);

    this._budgetMs = renderBudgetMs > 0 ? renderBudgetMs : DEFAULT_RENDER_BUDGET_MS;
    this._dropThresholdMultiplier = dropThresholdMultiplier > 1 ? dropThresholdMultiplier : DEFAULT_DROP_THRESHOLD_MULTIPLIER;

    this._frameStartMs = 0;
    this._cpuStartMs = 0;
    this._frameId = 0;
    this._consecutiveDropped = 0;
    this._totalDropped = 0;

    this._trendWindowMs = Math.max(1000, trendWindowMs | 0);
    this._trendSamples = [];
    this._trendSum = 0;

    this._historySize = Math.max(60, historySize | 0);
    this._history = [];

    this._memorySampleIntervalMs = Math.max(250, memorySampleIntervalMs | 0);
    this._lastMemorySampleMs = 0;
    this._memoryStats = {
      supported: typeof performance !== 'undefined' && performance.memory ? true : false,
      usedJSHeapSize: 0,
      totalJSHeapSize: 0,
      jsHeapSizeLimit: 0,
      usedMB: 0,
      totalMB: 0,
      limitMB: 0,
    };

    this._layoutShiftTotal = 0;
    this._layoutShiftLatest = null;
    this._longTaskCount = 0;
    this._longTaskTotal = 0;
    this._longTaskMax = 0;
    this._longTaskLatest = null;
    this._paintTimings = {
      firstPaint: null,
      firstContentfulPaint: null,
      lastPaint: null,
    };

    this._currentBreakdown = Object.create(null);
    this._lastBreakdown = Object.create(null);
    this._sectionMarkers = Object.create(null);

    this._gpu = {
      supported: false,
      gl: null,
      ext: null,
      isWebGL2: false,
      activeQuery: null,
      pending: [],
      pool: [],
      lastTimeMs: 0,
      maxQueries: MAX_GPU_QUERIES_IN_FLIGHT,
    };

    this._metrics = this._createEmptyMetrics();

    this._setupPerformanceObservers({ observePaint, observeLongTasks, observeLayoutShifts });
    if (renderer) {
      this.instrumentRenderer(renderer, { auto: autoInstrumentRenderer });
    }
  }

  _createEmptyMetrics() {
    return {
      frameId: 0,
      timestamp: 0,
      fps: { instant: 0, avg: 0, min: 0, max: 0, trend10s: 0 },
      frameTime: { latest: 0, avg: 0, min: 0, max: 0 },
      cpu: {
        mainThread: { latest: 0, avg: 0, min: 0, max: 0 },
        audioWorklet: { latest: 0, avg: 0 },
      },
      gpu: {
        supported: false,
        latest: 0,
        avg: 0,
      },
      renderer: {
        drawCalls: 0,
        triangles: 0,
        lines: 0,
        points: 0,
        geometries: 0,
        textures: 0,
      },
      memory: { ...this._memoryStats },
      frameBudget: {
        targetMs: this._budgetMs,
        latestUtilisation: 0,
        avgUtilisation: 0,
        droppedFrames: {
          total: 0,
          consecutive: 0,
        },
        dropThresholdMultiplier: this._dropThresholdMultiplier,
      },
      observers: {
        layoutShiftTotal: 0,
        layoutShiftLatest: null,
        longTaskCount: 0,
        longTaskTotal: 0,
        longTaskMax: 0,
        lastLongTask: null,
        paint: { ...this._paintTimings },
      },
      breakdown: {},
    };
  }

  instrumentRenderer(renderer, { auto = true } = {}) {
    if (!renderer || typeof renderer.getContext !== 'function') {
      return;
    }

    if (this._gpu.supported && this._gpu.gl && renderer === this._renderer) {
      return;
    }

    let gl = null;
    try {
      gl = renderer.getContext();
    } catch (_) {
      gl = null;
    }

    if (!gl) {
      return;
    }

    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') || gl.getExtension('EXT_disjoint_timer_query');

    if (!ext) {
      this._gpu.supported = false;
      this._gpu.gl = gl;
      return;
    }

    this._gpu.supported = true;
    this._gpu.gl = gl;
    this._gpu.ext = ext;
    this._gpu.isWebGL2 = !!(isWebGL2 && typeof gl.beginQuery === 'function');

    if (auto) {
      this._wrapRendererRender(renderer);
    }
  }

  _wrapRendererRender(renderer) {
    if (!renderer || renderer.__performanceMonitorWrapped) return;
    const originalRender = renderer.render;
    if (typeof originalRender !== 'function') return;

    renderer.render = (...args) => {
      this._beginGpuQuery();
      try {
        return originalRender.apply(renderer, args);
      } finally {
        this._endGpuQuery();
      }
    };

    Object.defineProperty(renderer, '__performanceMonitorWrapped', {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  beginFrame(startMs = now()) {
    this._pollGpuQueries();

    this._frameStartMs = startMs;
    this._cpuStartMs = startMs;
    this._frameId += 1;

    this._clearObject(this._currentBreakdown);
    this._clearObject(this._sectionMarkers);

    return this._frameId;
  }

  endFrame(options = {}) {
    const {
      timestamp = now(),
      renderBudgetMs,
      breakdown = null,
      droppedFrame = null,
    } = options;

    if (!this._frameStartMs) {
      this.beginFrame(timestamp);
    }

    if (typeof renderBudgetMs === 'number' && renderBudgetMs > 0) {
      this._budgetMs = renderBudgetMs;
    }

    const frameDuration = Math.max(0, timestamp - this._frameStartMs);
    const cpuDuration = Math.max(0, timestamp - this._cpuStartMs);

    this._frameMetric.push(frameDuration);
    this._cpuMetric.push(cpuDuration);

    const gpuTimeMs = this._gpu.lastTimeMs;
    if (this._gpu.supported && Number.isFinite(gpuTimeMs) && gpuTimeMs > 0) {
      this._gpuMetric.push(gpuTimeMs);
    }

    const targetMs = this._budgetMs;
    const dropThreshold = targetMs * this._dropThresholdMultiplier;
    const dropped = typeof droppedFrame === 'boolean'
      ? droppedFrame
      : frameDuration > dropThreshold;

    if (dropped) {
      this._totalDropped += 1;
      this._consecutiveDropped += 1;
    } else {
      this._consecutiveDropped = 0;
    }

    const instantFps = frameDuration > 0 ? 1000 / frameDuration : 0;
    const avgFrameMs = this._frameMetric.average;
    const avgFps = avgFrameMs > 0 ? 1000 / avgFrameMs : 0;
    const minFrameMs = this._frameMetric.min;
    const maxFrameMs = this._frameMetric.max;

    const minFps = maxFrameMs > 0 ? 1000 / maxFrameMs : 0;
    const maxFps = minFrameMs > 0 ? 1000 / minFrameMs : 0;

    this._updateTrendSamples(timestamp, frameDuration);

    const breakdownData = this._finaliseBreakdown(breakdown);
    this._sampleMemory(timestamp);
    this._captureRendererInfo();

    this._metrics.frameId = this._frameId;
    this._metrics.timestamp = timestamp;
    this._metrics.fps.instant = instantFps;
    this._metrics.fps.avg = avgFps;
    this._metrics.fps.min = minFps;
    this._metrics.fps.max = maxFps;
    this._metrics.fps.trend10s = this._trendAverageMs > 0 ? 1000 / this._trendAverageMs : instantFps;

    this._metrics.frameTime.latest = frameDuration;
    this._metrics.frameTime.avg = avgFrameMs;
    this._metrics.frameTime.min = minFrameMs;
    this._metrics.frameTime.max = maxFrameMs;

    this._metrics.cpu.mainThread.latest = cpuDuration;
    this._metrics.cpu.mainThread.avg = this._cpuMetric.average;
    this._metrics.cpu.mainThread.min = this._cpuMetric.min;
    this._metrics.cpu.mainThread.max = this._cpuMetric.max;

    this._metrics.cpu.audioWorklet.latest = this._audioMetric.latest;
    this._metrics.cpu.audioWorklet.avg = this._audioMetric.average;

    this._metrics.gpu.supported = this._gpu.supported;
    this._metrics.gpu.latest = this._gpuMetric.latest;
    this._metrics.gpu.avg = this._gpuMetric.average;

    this._metrics.memory = { ...this._memoryStats };

    this._metrics.frameBudget.targetMs = targetMs;
    this._metrics.frameBudget.latestUtilisation = targetMs > 0 ? frameDuration / targetMs : 0;
    this._metrics.frameBudget.avgUtilisation = targetMs > 0 && avgFrameMs > 0 ? avgFrameMs / targetMs : 0;
    this._metrics.frameBudget.droppedFrames.total = this._totalDropped;
    this._metrics.frameBudget.droppedFrames.consecutive = this._consecutiveDropped;

    this._metrics.observers.layoutShiftTotal = this._layoutShiftTotal;
    this._metrics.observers.layoutShiftLatest = this._layoutShiftLatest;
    this._metrics.observers.longTaskCount = this._longTaskCount;
    this._metrics.observers.longTaskTotal = this._longTaskTotal;
    this._metrics.observers.longTaskMax = this._longTaskMax;
    this._metrics.observers.lastLongTask = this._longTaskLatest;
    this._metrics.observers.paint = { ...this._paintTimings };

    this._metrics.breakdown = breakdownData;

    this._recordFrameHistory({
      timestamp,
      frameMs: frameDuration,
      cpuMs: cpuDuration,
      gpuMs: this._gpuMetric.latest,
      fps: instantFps,
      dropped,
    });

    if (this._onMetricsUpdated) {
      this._onMetricsUpdated(this._metrics);
    }

    this._frameStartMs = 0;
    this._cpuStartMs = 0;

    return this._metrics;
  }

  recordAudioWorkletSample(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this._audioMetric.push(durationMs);
  }

  markSectionStart(name, timestamp = now()) {
    if (!name) return;
    this._sectionMarkers[name] = timestamp;
  }

  markSectionEnd(name, timestamp = now()) {
    if (!name) return;
    const start = this._sectionMarkers[name];
    if (typeof start !== 'number') return;
    const duration = Math.max(0, timestamp - start);
    this._currentBreakdown[name] = (this._currentBreakdown[name] || 0) + duration;
    delete this._sectionMarkers[name];
  }

  recordSectionDuration(name, durationMs) {
    if (!name || !Number.isFinite(durationMs)) return;
    this._currentBreakdown[name] = (this._currentBreakdown[name] || 0) + Math.max(0, durationMs);
  }

  getMetrics() {
    return this._metrics;
  }

  getHistory() {
    return this._history;
  }

  reset() {
    this._frameMetric = new RollingMetric(this._frameMetric.size);
    this._cpuMetric = new RollingMetric(this._cpuMetric.size);
    this._gpuMetric = new RollingMetric(this._gpuMetric.size);
    this._audioMetric = new RollingMetric(this._audioMetric.size);

    this._frameStartMs = 0;
    this._cpuStartMs = 0;
    this._frameId = 0;
    this._consecutiveDropped = 0;
    this._totalDropped = 0;

    this._trendSamples.length = 0;
    this._trendSum = 0;
    this._trendAverageMs = 0;

    this._history.length = 0;
    this._memoryStats = { ...this._memoryStats, usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 0, usedMB: 0, totalMB: 0, limitMB: 0 };
    this._layoutShiftTotal = 0;
    this._layoutShiftLatest = null;
    this._longTaskCount = 0;
    this._longTaskTotal = 0;
    this._longTaskMax = 0;
    this._longTaskLatest = null;
    this._paintTimings = { firstPaint: null, firstContentfulPaint: null, lastPaint: null };

    this._clearObject(this._currentBreakdown);
    this._clearObject(this._lastBreakdown);
    this._clearObject(this._sectionMarkers);

    this._metrics = this._createEmptyMetrics();
  }

  dispose() {
    this._disconnectObservers();
    this._releaseAllGpuQueries();
    this._renderer = null;
  }

  _updateTrendSamples(timestamp, frameDuration) {
    this._trendSamples.push({ timestamp, frameDuration });
    this._trendSum += frameDuration;

    const cutoff = timestamp - this._trendWindowMs;
    while (this._trendSamples.length && this._trendSamples[0].timestamp < cutoff) {
      const removed = this._trendSamples.shift();
      this._trendSum -= removed.frameDuration;
    }

    const count = this._trendSamples.length;
    this._trendAverageMs = count ? this._trendSum / count : frameDuration;
  }

  _finaliseBreakdown(externalBreakdown) {
    this._clearObject(this._lastBreakdown);
    for (const key in this._currentBreakdown) {
      if (Object.prototype.hasOwnProperty.call(this._currentBreakdown, key)) {
        this._lastBreakdown[key] = this._currentBreakdown[key];
      }
    }

    if (externalBreakdown && typeof externalBreakdown === 'object') {
      for (const [key, value] of Object.entries(externalBreakdown)) {
        if (!Number.isFinite(value)) continue;
        this._lastBreakdown[key] = (this._lastBreakdown[key] || 0) + value;
      }
    }

    return this._lastBreakdown;
  }

  _recordFrameHistory(entry) {
    this._history.push(entry);
    if (this._history.length > this._historySize) {
      this._history.shift();
    }
  }

  _sampleMemory(timestamp) {
    if (!this._memoryStats.supported) return;
    if (timestamp - this._lastMemorySampleMs < this._memorySampleIntervalMs) return;
    if (!performance || !performance.memory) return;

    const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = performance.memory;
    if (!Number.isFinite(usedJSHeapSize)) return;

    const toMB = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

    this._memoryStats = {
      supported: true,
      usedJSHeapSize,
      totalJSHeapSize,
      jsHeapSizeLimit,
      usedMB: toMB(usedJSHeapSize),
      totalMB: toMB(totalJSHeapSize),
      limitMB: toMB(jsHeapSizeLimit),
    };

    this._lastMemorySampleMs = timestamp;
  }

  _captureRendererInfo() {
    if (!this._renderer || !this._renderer.info) return;
    const info = this._renderer.info;

    this._metrics.renderer.drawCalls = info.render?.calls ?? 0;
    this._metrics.renderer.triangles = info.render?.triangles ?? 0;
    this._metrics.renderer.lines = info.render?.lines ?? 0;
    this._metrics.renderer.points = info.render?.points ?? 0;
    this._metrics.renderer.geometries = info.memory?.geometries ?? 0;
    this._metrics.renderer.textures = info.memory?.textures ?? 0;
  }

  _clearObject(obj) {
    if (!obj) return;
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        delete obj[key];
      }
    }
  }

  _beginGpuQuery() {
    if (!this._gpu.supported || this._gpu.activeQuery) return;
    if (this._gpu.pending.length >= this._gpu.maxQueries) return;

    const { gl, ext, isWebGL2 } = this._gpu;
    if (!gl || !ext) return;

    const query = this._acquireGpuQuery();
    if (!query) return;

    try {
      if (isWebGL2) {
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      } else if (typeof ext.beginQueryEXT === 'function') {
        ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, query);
      } else {
        throw new Error('Unsupported EXT_disjoint_timer_query implementation');
      }
      this._gpu.activeQuery = query;
    } catch (err) {
      this._releaseGpuQuery(query);
      this._gpu.activeQuery = null;
      console.warn('[PerformanceMonitor] GPU timer start failed:', err);
    }
  }

  _endGpuQuery() {
    if (!this._gpu.supported || !this._gpu.activeQuery) return;

    const { gl, ext, isWebGL2 } = this._gpu;
    const query = this._gpu.activeQuery;
    this._gpu.activeQuery = null;

    try {
      if (isWebGL2) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
      } else if (typeof ext.endQueryEXT === 'function') {
        ext.endQueryEXT(ext.TIME_ELAPSED_EXT);
      }
      this._gpu.pending.push({ query, timestamp: now() });
    } catch (err) {
      this._releaseGpuQuery(query);
      console.warn('[PerformanceMonitor] GPU timer end failed:', err);
    }
  }

  _pollGpuQueries() {
    if (!this._gpu.supported || this._gpu.pending.length === 0) return;

    const { gl, ext, isWebGL2, pending } = this._gpu;
    if (!gl || !ext) return;

    const getAvailable = (query) => {
      try {
        if (isWebGL2) {
          return gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
        }
        return ext.getQueryObjectEXT(query, ext.QUERY_RESULT_AVAILABLE_EXT);
      } catch (_) {
        return false;
      }
    };

    const getDisjoint = () => {
      try {
        return gl.getParameter(ext.GPU_DISJOINT_EXT);
      } catch (_) {
        return true;
      }
    };

    const getResult = (query) => {
      try {
        if (isWebGL2) {
          return gl.getQueryParameter(query, gl.QUERY_RESULT);
        }
        return ext.getQueryObjectEXT(query, ext.QUERY_RESULT_EXT);
      } catch (_) {
        return null;
      }
    };

    const unwrapQuery = (entry) => (entry && typeof entry === 'object' && 'query' in entry ? entry.query : entry);
    const getTimestamp = (entry) => (entry && typeof entry === 'object' && typeof entry.timestamp === 'number' ? entry.timestamp : null);

    while (pending.length) {
      const entry = pending[0];
      const query = unwrapQuery(entry);

      if (!query) {
        pending.shift();
        continue;
      }

      const enqueuedAt = getTimestamp(entry);
      const timedOut = enqueuedAt !== null ? (now() - enqueuedAt) > GPU_QUERY_TIMEOUT_MS : false;
      const available = getAvailable(query);

      if (!available && !timedOut) {
        break; // Queries resolve in order; exit early until the first is ready
      }

      pending.shift();

      if (!available && timedOut) {
        this._releaseGpuQuery(query);
        continue;
      }

      const disjoint = getDisjoint();
      const result = disjoint ? null : getResult(query);
      if (Number.isFinite(result)) {
        this._gpu.lastTimeMs = result / 1e6; // Nanoseconds → milliseconds
      }

      this._releaseGpuQuery(query);
    }
  }

  _acquireGpuQuery() {
    if (this._gpu.pool.length) {
      return this._gpu.pool.pop();
    }

    const { gl, ext, isWebGL2 } = this._gpu;
    if (!gl || !ext) return null;

    try {
      if (isWebGL2 && typeof gl.createQuery === 'function') {
        return gl.createQuery();
      }
      if (typeof ext.createQueryEXT === 'function') {
        return ext.createQueryEXT();
      }
    } catch (err) {
      console.warn('[PerformanceMonitor] Failed to create GPU query object:', err);
    }
    return null;
  }

  _releaseGpuQuery(query) {
    if (!query) return;
    if (this._gpu.pool.length < this._gpu.maxQueries) {
      this._gpu.pool.push(query);
      return;
    }

    const { gl, ext, isWebGL2 } = this._gpu;
    try {
      if (isWebGL2 && typeof gl.deleteQuery === 'function') {
        gl.deleteQuery(query);
      } else if (typeof ext.deleteQueryEXT === 'function') {
        ext.deleteQueryEXT(query);
      }
    } catch (_) {
      // Ignore context-loss errors
    }
  }

  _releaseAllGpuQueries() {
    const { pending, pool } = this._gpu;
    const unwrapQuery = (entry) => (entry && typeof entry === 'object' && 'query' in entry ? entry.query : entry);
    while (pending.length) {
      const entry = pending.pop();
      this._releaseGpuQuery(unwrapQuery(entry));
    }
    while (pool.length) {
      const query = pool.pop();
      this._releaseGpuQuery(query);
    }
    this._gpu.activeQuery = null;
    this._gpu.supported = false;
  }

  _setupPerformanceObservers({ observePaint, observeLongTasks, observeLayoutShifts }) {
    if (typeof PerformanceObserver === 'undefined') return;

    if (observePaint) {
      try {
        this._paintObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-paint' && this._paintTimings.firstPaint === null) {
              this._paintTimings.firstPaint = entry.startTime;
            }
            if (entry.name === 'first-contentful-paint' && this._paintTimings.firstContentfulPaint === null) {
              this._paintTimings.firstContentfulPaint = entry.startTime;
            }
            this._paintTimings.lastPaint = entry.startTime + entry.duration;
          }
        });
        this._paintObserver.observe({ type: 'paint', buffered: true });
      } catch (err) {
        console.debug('[PerformanceMonitor] Paint observer unavailable:', err);
      }
    }

    if (observeLongTasks) {
      try {
        this._longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this._longTaskCount += 1;
            this._longTaskTotal += entry.duration;
            if (entry.duration > this._longTaskMax) {
              this._longTaskMax = entry.duration;
            }
            this._longTaskLatest = {
              startTime: entry.startTime,
              duration: entry.duration,
              attribution: entry.attribution?.map((item) => ({
                name: item.name,
                entryType: item.entryType,
                duration: item.duration,
              })) || [],
            };
          }
        });
        this._longTaskObserver.observe({ type: 'longtask', buffered: true });
      } catch (err) {
        console.debug('[PerformanceMonitor] Long task observer unavailable:', err);
      }
    }

    if (observeLayoutShifts) {
      try {
        this._layoutObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            this._layoutShiftTotal += entry.value;
            this._layoutShiftLatest = {
              value: entry.value,
              startTime: entry.startTime,
              sources: entry.sources?.map((source) => ({
                node: source.node ? this._describeNode(source.node) : null,
                previousRect: source.previousRect,
                currentRect: source.currentRect,
              })) || [],
            };
          }
        });
        this._layoutObserver.observe({ type: 'layout-shift', buffered: true });
      } catch (err) {
        console.debug('[PerformanceMonitor] Layout shift observer unavailable:', err);
      }
    }
  }

  _disconnectObservers() {
    try { this._paintObserver?.disconnect(); } catch (_) {}
    try { this._longTaskObserver?.disconnect(); } catch (_) {}
    try { this._layoutObserver?.disconnect(); } catch (_) {}
    this._paintObserver = null;
    this._longTaskObserver = null;
    this._layoutObserver = null;
  }

  _describeNode(node) {
    if (!node) return null;
    if (node.id) return `#${node.id}`;
    if (node.className && typeof node.className === 'string') {
      return `${node.nodeName.toLowerCase()}.${node.className.split(/\s+/).filter(Boolean).join('.')}`;
    }
    return node.nodeName ? node.nodeName.toLowerCase() : null;
  }
}

export default PerformanceMonitor;

