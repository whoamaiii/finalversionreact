// SyncCoordinator orchestrates control↔projector state sharing with BroadcastChannel,
// postMessage, and localStorage heartbeat fallbacks.

import { ReadinessGate } from './readiness-gate.js';
import { ListenerManager } from './listener-manager.js';

const CHANNEL_NAME = 'reactive-sync-v1';
const STORAGE_KEY = 'reactive_sync_bridge_v1';
const FEATURE_INTERVAL_MS = 33;
const PARAM_PUSH_INTERVAL_MS = 1000; // Increased from 450ms to reduce localStorage write frequency for long-runtime stability
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2 + 800;

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function deepClone(value) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch (_) {
    // structuredClone not available or failed, fall back to JSON
  }
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(target, source, seen = new WeakSet()) {
  if (!source || typeof source !== 'object') return target;

  // Detect circular references to prevent stack overflow
  if (seen.has(source)) {
    console.warn('[deepMerge] Circular reference detected, skipping');
    return target;
  }
  seen.add(source);

  const keys = Object.keys(source);
  for (const key of keys) {
    const src = source[key];
    if (Array.isArray(src)) {
      target[key] = src.slice();
    } else if (src && typeof src === 'object') {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deepMerge(target[key], src, seen);
    } else {
      target[key] = src;
    }
  }
  return target;
}

function sanitizeFeatures(features) {
  if (!features) return null;
  return {
    rms: features.rms,
    rmsNorm: features.rmsNorm,
    bands: features.bands ? { ...features.bands } : undefined,
    bandsEMA: features.bandsEMA ? { ...features.bandsEMA } : undefined,
    bandEnv: features.bandEnv ? { ...features.bandEnv } : undefined,
    bandNorm: features.bandNorm ? { ...features.bandNorm } : undefined,
    centroidNorm: features.centroidNorm,
    flux: features.flux,
    fluxMean: features.fluxMean,
    fluxStd: features.fluxStd,
    beat: !!features.beat,
    drop: !!features.drop,
    isBuilding: !!features.isBuilding,
    buildLevel: features.buildLevel,
    lastDropMs: features.lastDropMs,
    bpm: features.bpm,
    bpmConfidence: features.bpmConfidence,
    bpmSource: features.bpmSource,
    tapBpm: features.tapBpm,
    mfcc: Array.isArray(features.mfcc) ? features.mfcc.slice() : undefined,
    chroma: Array.isArray(features.chroma) ? features.chroma.slice() : undefined,
    flatness: features.flatness,
    rolloff: features.rolloff,
    pitchHz: features.pitchHz,
    pitchConf: features.pitchConf,
    aubioTempoBpm: features.aubioTempoBpm,
    aubioTempoConf: features.aubioTempoConf,
    beatGrid: features.beatGrid
      ? { bpm: features.beatGrid.bpm, confidence: features.beatGrid.confidence }
      : undefined,
  };
}

function collectSceneSnapshot(sceneApi) {
  if (!sceneApi?.state?.params) return null;
  const p = sceneApi.state.params;
  const snapshot = {
    theme: p.theme,
    autoRotate: p.autoRotate,
    useHdrBackground: p.useHdrBackground,
    useLensflare: p.useLensflare,
    bloomStrengthBase: p.bloomStrengthBase,
    bloomReactiveGain: p.bloomReactiveGain,
    fogDensity: p.fogDensity,
    performanceMode: p.performanceMode,
    pixelRatioCap: p.pixelRatioCap,
    particleDensity: p.particleDensity,
    enableSparks: p.enableSparks,
    outerShell: p.outerShell,
    autoResolution: p.autoResolution,
    targetFps: p.targetFps,
    minPixelRatio: p.minPixelRatio,
    map: p.map,
    explosion: p.explosion,
    explosionDuration: sceneApi.state.explosionDuration,
  };
  return deepClone(snapshot);
}

function applySceneSnapshot(sceneApi, snapshot) {
  if (!sceneApi?.state?.params || !snapshot) return;
  const params = sceneApi.state.params;
  let shouldRebuildParticles = false;

  if (snapshot.theme && snapshot.theme !== params.theme) {
    sceneApi.changeTheme(snapshot.theme);
  }

  if (typeof snapshot.useHdrBackground === 'boolean') {
    const changed = snapshot.useHdrBackground !== params.useHdrBackground;
    params.useHdrBackground = snapshot.useHdrBackground;
    if (changed) sceneApi.changeTheme(params.theme);
  }

  if (typeof snapshot.useLensflare === 'boolean' && snapshot.useLensflare !== params.useLensflare) {
    params.useLensflare = snapshot.useLensflare;
    sceneApi.setUseLensflare(snapshot.useLensflare);
  }

  if (typeof snapshot.pixelRatioCap === 'number') {
    sceneApi.setPixelRatioCap(snapshot.pixelRatioCap);
  }

  if (typeof snapshot.particleDensity === 'number' && snapshot.particleDensity !== params.particleDensity) {
    params.particleDensity = snapshot.particleDensity;
    shouldRebuildParticles = true;
  }

  if (typeof snapshot.enableSparks === 'boolean') {
    sceneApi.setEnableSparks(snapshot.enableSparks);
  }

  if (typeof snapshot.fogDensity === 'number') {
    params.fogDensity = snapshot.fogDensity;
    if (sceneApi.state.scene?.fog) sceneApi.state.scene.fog.density = snapshot.fogDensity;
  }

  if (typeof snapshot.bloomStrengthBase === 'number') {
    params.bloomStrengthBase = snapshot.bloomStrengthBase;
    if (sceneApi.state.bloomEffect) sceneApi.state.bloomEffect.intensity = snapshot.bloomStrengthBase;
  }

  if (typeof snapshot.bloomReactiveGain === 'number') {
    params.bloomReactiveGain = snapshot.bloomReactiveGain;
  }

  if (typeof snapshot.autoRotate === 'number') params.autoRotate = snapshot.autoRotate;
  if (typeof snapshot.performanceMode === 'boolean') params.performanceMode = snapshot.performanceMode;
  if (typeof snapshot.autoResolution === 'boolean') params.autoResolution = snapshot.autoResolution;
  if (typeof snapshot.targetFps === 'number') params.targetFps = snapshot.targetFps;
  if (typeof snapshot.minPixelRatio === 'number') params.minPixelRatio = snapshot.minPixelRatio;

  if (snapshot.outerShell && typeof snapshot.outerShell === 'object') {
    if (!params.outerShell || typeof params.outerShell !== 'object') params.outerShell = {};
    const prevEnabled = !!params.outerShell.enabled;
    const nextEnabled = typeof snapshot.outerShell.enabled === 'boolean' ? snapshot.outerShell.enabled : prevEnabled;
    const prevDensity = typeof params.outerShell.densityScale === 'number' ? params.outerShell.densityScale : null;
    const nextDensity = typeof snapshot.outerShell.densityScale === 'number' ? snapshot.outerShell.densityScale : prevDensity;
    const needsRebuild = (typeof snapshot.outerShell.enabled === 'boolean' && nextEnabled !== prevEnabled)
      || (typeof snapshot.outerShell.densityScale === 'number' && nextDensity !== prevDensity);
    deepMerge(params.outerShell, snapshot.outerShell);
    if (needsRebuild) shouldRebuildParticles = true;
  }

  if (snapshot.map && typeof snapshot.map === 'object') {
    if (!params.map || typeof params.map !== 'object') params.map = {};
    if (snapshot.map.eye && (!params.map.eye || typeof params.map.eye !== 'object')) params.map.eye = {};
    deepMerge(params.map, snapshot.map);
  }

  if (snapshot.explosion && typeof snapshot.explosion === 'object') {
    if (!params.explosion || typeof params.explosion !== 'object') params.explosion = {};
    deepMerge(params.explosion, snapshot.explosion);
  }

  if (shouldRebuildParticles) {
    sceneApi.rebuildParticles();
  }

  if (typeof snapshot.explosionDuration === 'number') {
    sceneApi.state.explosionDuration = snapshot.explosionDuration;
  }
}

export function resolveRoleFromUrl(searchString) {
  try {
    const params = new URLSearchParams(searchString || (typeof location !== 'undefined' ? location.search : ''));
    if (params.has('control')) return 'control';
    if (params.has('receiver')) return 'receiver';
    if (params.has('present')) return 'receiver';
    return 'solo';
  } catch (_) {
    return 'solo';
  }
}

export class SyncCoordinator {
  constructor({ role, sceneApi, onStatusChange } = {}) {
    this.role = role || resolveRoleFromUrl();
    this.sceneApi = sceneApi || null;
    this.id = generateId();
    this.autoSync = this.role !== 'receiver';
    this._statusListeners = new Set();
    if (typeof onStatusChange === 'function') this._statusListeners.add(onStatusChange);

    // Readiness gate for coordinating initialization
    this._readiness = new ReadinessGate('SyncCoordinator');
    this._readiness.register('sceneApi');

    // Mark sceneApi as ready if already provided
    if (this.sceneApi) {
      this._readiness.setReady('sceneApi');
    }

    // Listener manager for guaranteed cleanup
    this._listenerMgr = new ListenerManager('SyncCoordinator');

    this.channel = null;
    this.projectorWindow = null;
    this.controlWindow = null;
    this.remoteId = null;
    this.remoteRole = null;
    this.connected = false;

    this._lastHeartbeatSent = 0;
    this._lastHeartbeatSeen = 0;
    this._lastFeaturesSentAt = 0;
    this._lastParamPushAt = 0;
    this._lastParamSerialized = '';
    this._lastSnapshot = null;

    this._remoteFeatures = null;
    this._remoteFeaturesPerfAt = 0;
    this._remoteFeaturesWallAt = 0;

    this._lastAppliedParams = null;

    // Store timer IDs for cleanup
    this._helloTimerId = null;

    this._initTransports();

    // Clear any existing hello timer before setting new one (prevents overlap)
    if (this._helloTimerId) {
      clearTimeout(this._helloTimerId);
    }
    this._helloTimerId = setTimeout(() => this._sendHello(), 60);
  }

  _initTransports() {
    // Clean up ALL existing listeners first (guaranteed cleanup)
    // This prevents listener duplication on reconnection
    this._listenerMgr.removeAll();

    // Close existing BroadcastChannel if present
    if (this.channel) {
      try {
        this.channel.close();
      } catch (_) {}
      this.channel = null;
    }

    if (typeof BroadcastChannel === 'function') {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        // Use onmessage for BroadcastChannel (not tracked by ListenerManager since it's a property setter)
        this.channel.onmessage = (event) => this._handleMessage(event?.data, 'broadcast');
      } catch (err) {
        console.warn('[Sync] BroadcastChannel unavailable', err);
        this.channel = null;
      }
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      // Create bound handler references (only once per instance)
      if (!this._messageHandler) {
        this._messageHandler = (event) => {
          this._handleMessage(event?.data, 'postMessage', event.source || null);
        };
      }
      if (!this._storageHandler) {
        this._storageHandler = (event) => {
          if (event.key !== STORAGE_KEY || !event.newValue) return;
          try {
            const parsed = JSON.parse(event.newValue);
            this._handleMessage(parsed, 'storage');
          } catch (_) {
            // ignore parse errors
          }
        };
      }

      // Add listeners with tracking (guaranteed cleanup)
      this._listenerMgr.add(window, 'message', this._messageHandler);
      this._listenerMgr.add(window, 'storage', this._storageHandler);
    }

    if (this.role === 'receiver' && typeof window !== 'undefined') {
      if (window.opener && !window.opener.closed) this.controlWindow = window.opener;
    }
  }

  _sendHello() {
    const payload = { role: this.role };
    this._sendMessage('hello', payload, { target: this.role === 'receiver' ? 'control' : 'receiver', useStorage: true });
    if (this.role === 'receiver') {
      this._sendMessage('requestSnapshot', {}, { target: 'control', useStorage: true });
    }
  }

  _handleMessage(raw, via, sourceWindow) {
    if (!raw || typeof raw !== 'object') return;
    if (raw.senderId === this.id) return;
    if (raw.target && raw.target !== 'any' && raw.target !== this.role) return;

    if (via === 'postMessage') {
      if (this.role === 'control' && sourceWindow) this.projectorWindow = sourceWindow;
      if (this.role === 'receiver' && sourceWindow) this.controlWindow = sourceWindow;
    }

    const type = raw.type;
    const payload = raw.payload || {};

    if (type === 'hello') {
      this.remoteId = raw.senderId;
      this.remoteRole = payload.role || null;
      this._lastHeartbeatSeen = Date.now();
      this._setConnected(true);
      if (this.role === 'control') {
        this._sendMessage('hello', { role: this.role }, { target: 'receiver', useStorage: true });
        try {
          this.pushNow();
        } catch (err) {
          console.error('[Sync] Error pushing on hello:', err);
        }
      }
      return;
    }

    if (type === 'heartbeat') {
      this._lastHeartbeatSeen = Date.now();
      this._setConnected(true);
      return;
    }

    if (type === 'requestSnapshot') {
      if (this.role === 'control') {
        try {
          this.pushNow();
        } catch (err) {
          console.error('[Sync] Error pushing on requestSnapshot:', err);
        }
      }
      return;
    }

    if (type === 'paramsSnapshot') {
      if (this.role === 'receiver') {
        // Validate that params is an object before applying
        if (payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)) {
          applySceneSnapshot(this.sceneApi, payload.params);
          this._lastAppliedParams = payload.params;
        } else {
          console.warn('Invalid params in paramsSnapshot message:', payload);
        }
      }
      return;
    }

    if (type === 'features') {
      if (this.role === 'receiver') {
        this._remoteFeatures = payload.features || null;
        this._remoteFeaturesPerfAt = typeof performance !== 'undefined' ? performance.now() : 0;
        this._remoteFeaturesWallAt = Date.now();
      }
      return;
    }

    if (type === 'command') {
      if (this.role === 'receiver') this._handleCommand(payload);
      return;
    }

    if (type === 'padEvent') {
      if (this.role === 'receiver') {
        try { this._onPadEvent && this._onPadEvent(payload?.event); } catch (_) {}
      }
      return;
    }
  }

  _handleCommand(payload) {
    const cmd = payload?.name;
    if (!cmd) return;
    if ((cmd === 'toggle-fullscreen' || cmd === 'enter-fullscreen') && typeof document !== 'undefined') {
      try {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(()=>{});
        } else if (cmd === 'toggle-fullscreen') {
          document.exitFullscreen().catch(()=>{});
        }
      } catch (_) {}
    }
    if (cmd === 'exit-fullscreen' && typeof document !== 'undefined') {
      try { document.exitFullscreen().catch(()=>{}); } catch (_) {}
    }
    if (!this.sceneApi) return;
    if (cmd === 'eye-blink') {
      this.sceneApi.triggerEyeBlink?.();
      return;
    }
    if (cmd === 'eye-enable') {
      if (!this.sceneApi.state.params.map.eye) this.sceneApi.state.params.map.eye = {};
      this.sceneApi.state.params.map.eye.enabled = true;
      this.sceneApi.setEyeEnabled?.(true);
      return;
    }
    if (cmd === 'eye-disable') {
      if (!this.sceneApi.state.params.map.eye) this.sceneApi.state.params.map.eye = {};
      this.sceneApi.state.params.map.eye.enabled = false;
      this.sceneApi.setEyeEnabled?.(false);
      return;
    }
    if (cmd === 'eye-predator-on') {
      this.sceneApi.setEyePredatorMode?.(true);
      return;
    }
    if (cmd === 'eye-predator-off') {
      this.sceneApi.setEyePredatorMode?.(false);
      return;
    }
  }

  _setConnected(state) {
    if (this.connected === state) return;
    this.connected = state;
    this._emitStatus();
  }

  _emitStatus() {
    const status = this.getStatus();
    for (const cb of this._statusListeners) {
      try { cb(status); } catch (_) {}
    }
  }

  _sendMessage(type, payload = {}, { target = 'any', useStorage = false } = {}) {
    const message = {
      version: 1,
      type,
      payload,
      target,
      senderId: this.id,
      sentAt: Date.now(),
    };

    // Validate message size before sending (prevent silent failures)
    try {
      const serialized = JSON.stringify(message);
      const sizeBytes = new Blob([serialized]).size;
      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

      // BroadcastChannel has a ~5MB limit
      if (sizeBytes > 5000000) {
        console.error(`[Sync] Message too large: ${sizeMB}MB (limit: 5MB)`);
        console.error(`[Sync] Message type: ${type}, target: ${target}`);

        // Show user notification for large state
        if (typeof showToast === 'function') {
          try {
            showToast(`Sync failed: State too large (${sizeMB}MB). Reduce particle density or simplify scene.`, 'error');
          } catch (_) {}
        }

        return false; // Don't send
      }

      // Warn about large messages (>1MB)
      if (sizeBytes > 1000000) {
        console.warn(`[Sync] Large message: ${sizeMB}MB (type: ${type})`);
      }
    } catch (err) {
      console.error('[Sync] Error validating message size:', err);
      // Continue anyway - validation failure shouldn't block sync
    }

    // Send via BroadcastChannel
    if (this.channel) {
      try {
        this.channel.postMessage(message);
      } catch (err) {
        console.error('[Sync] BroadcastChannel send error:', err.message);
      }
    }

    const directTargets = [];
    if (this.projectorWindow && !this.projectorWindow.closed) directTargets.push(this.projectorWindow);
    if (this.controlWindow && !this.controlWindow.closed) directTargets.push(this.controlWindow);
    if (typeof window !== 'undefined' && window.opener && this.role === 'control') {
      try {
        const opener = window.opener;
        if (opener && !directTargets.includes(opener) && !opener.closed) directTargets.push(opener);
      } catch (_) {
        // Cross-origin or inaccessible window.opener
      }
    }
    for (const win of directTargets) {
      try { win.postMessage(message, '*'); } catch (_) {}
    }

    if (useStorage && typeof localStorage !== 'undefined') {
      try {
        const payloadWithNonce = { ...message, nonce: Math.random().toString(36).slice(2) };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payloadWithNonce));
      } catch (err) {
        // Log quota errors but don't disrupt sync operations
        if (err.name === 'QuotaExceededError') {
          console.warn('[SyncCoordinator] localStorage quota exceeded, sync message dropped');
          // Show warning once per session (avoid dynamic import to prevent memory accumulation)
          if (!this._quotaWarningShown) {
            this._quotaWarningShown = true;
            // Use console.error for visibility (toast would require dynamic import)
            console.error('[SyncCoordinator] Storage quota exceeded! Multi-window sync may be affected. Clear localStorage or close other tabs.');
          }
        }
      }
    }
  }

  onStatusChange(cb) {
    if (typeof cb === 'function') this._statusListeners.add(cb);
    return () => this._statusListeners.delete(cb);
  }

  setAutoSync(enabled) {
    const next = !!enabled;
    if (this.autoSync === next) return;
    this.autoSync = next;
    this._emitStatus();
    if (next) {
      try {
        this.pushNow();
      } catch (err) {
        console.error('[Sync] Error pushing on setAutoSync:', err);
      }
    }
  }

  pushNow() {
    if (this.role !== 'control') return;

    // Check readiness before proceeding
    if (!this._readiness.isReady('sceneApi')) {
      console.warn('[Sync] Cannot push: sceneApi not ready');
      return;
    }

    if (!this.sceneApi) {
      console.warn('[Sync] Cannot push: sceneApi is null');
      return;
    }

    try {
      const snapshot = collectSceneSnapshot(this.sceneApi);
      if (!snapshot) {
        console.warn('[Sync] Cannot push: snapshot collection returned null');
        return;
      }

      const serialized = JSON.stringify(snapshot);
      this._lastParamSerialized = serialized;
      this._lastSnapshot = snapshot;
      this._lastParamPushAt = typeof performance !== 'undefined' ? performance.now() : 0;
      this._sendMessage('paramsSnapshot', { params: snapshot }, { target: 'receiver', useStorage: true });
    } catch (err) {
      console.error('[Sync] Error in pushNow():', err);
      // Gracefully degrade - don't crash the app
    }
  }

  /**
   * Set sceneApi after construction
   */
  setSceneApi(sceneApi) {
    this.sceneApi = sceneApi;
    if (sceneApi) {
      this._readiness.setReady('sceneApi');
    } else {
      this._readiness.setNotReady('sceneApi');
    }
  }

  handleLocalFeatures(features, now) {
    if (this.role !== 'control') return;
    if (!features) return;
    if (!this.autoSync) return;
    if (this.connected === false) return;
    if (now - this._lastFeaturesSentAt < FEATURE_INTERVAL_MS) return;
    this._lastFeaturesSentAt = now;
    const safe = sanitizeFeatures(features);
    this._sendMessage('features', { features: safe }, { target: 'receiver' });
  }

  maybeSendParamSnapshot(now) {
    if (this.role !== 'control') return;
    if (!this.autoSync) return;
    if (!this.sceneApi) return;
    if (now - this._lastParamPushAt < PARAM_PUSH_INTERVAL_MS) return;
    const snapshot = collectSceneSnapshot(this.sceneApi);
    if (!snapshot) return;
    const serialized = JSON.stringify(snapshot);
    if (serialized === this._lastParamSerialized) return;
    this._lastParamSerialized = serialized;
    this._lastSnapshot = snapshot;
    this._lastParamPushAt = now;
    this._sendMessage('paramsSnapshot', { params: snapshot }, { target: 'receiver', useStorage: true });
  }

  tick(now) {
    const wallNow = Date.now();
    if (this.connected && this._lastHeartbeatSeen && wallNow - this._lastHeartbeatSeen > HEARTBEAT_TIMEOUT_MS) {
      this._setConnected(false);
    }

    // Use consistent wall clock time for heartbeat send timing
    if (wallNow - this._lastHeartbeatSent > HEARTBEAT_INTERVAL_MS) {
      this._lastHeartbeatSent = wallNow;
      const target = this.role === 'control' ? 'receiver' : 'control';
      this._sendMessage('heartbeat', {}, { target });
    }
  }

  getRemoteFeatures(now) {
    if (!this._remoteFeatures) return null;
    if (typeof now === 'number' && this._remoteFeaturesPerfAt > 0) {
      if (now - this._remoteFeaturesPerfAt > 1200) return null;
    } else if (this._remoteFeaturesWallAt && Date.now() - this._remoteFeaturesWallAt > 1500) {
      return null;
    }
    return this._remoteFeatures;
  }

  getStatus() {
    return {
      connected: this.connected,
      autoSync: this.autoSync,
      remoteRole: this.remoteRole,
      lastHeartbeatAt: this._lastHeartbeatSeen,
      lastFeaturesAt: this._remoteFeaturesWallAt,
    };
  }

  openProjectorWindow() {
    if (this.role !== 'control' || typeof window === 'undefined') return null;
    const url = new URL(window.location.href);
    url.searchParams.delete('control');
    url.searchParams.set('present', '1');
    url.searchParams.set('receiver', '1');
    url.searchParams.set('from', 'control');
    const win = window.open(url.toString(), 'reactive-projector', 'popup=1,width=1600,height=900,noopener=yes');
    if (win) this.projectorWindow = win;
    // Clear any existing hello timer and set a new one
    if (this._helloTimerId) {
      clearTimeout(this._helloTimerId);
    }
    this._helloTimerId = setTimeout(() => this._sendHello(), 120);
    return win;
  }

  sendCommand(name) {
    if (!name) return;
    const target = this.role === 'control' ? 'receiver' : 'control';
    this._sendMessage('command', { name }, { target });
  }

  // Performance pad events (broadcast to the other role)
  setPadEventHandler(handler) {
    this._onPadEvent = typeof handler === 'function' ? handler : null;
  }
  sendPadEvent(event) {
    if (!event) return;
    const target = this.role === 'control' ? 'receiver' : 'control';
    this._sendMessage('padEvent', { event }, { target });
  }

  // Cleanup method to remove all event listeners and prevent memory leaks
  cleanup() {
    // Clear any pending timers
    if (this._helloTimerId) {
      clearTimeout(this._helloTimerId);
      this._helloTimerId = null;
    }

    // Remove ALL event listeners (guaranteed cleanup)
    this._listenerMgr.removeAll();

    // Clear handler references
    this._messageHandler = null;
    this._storageHandler = null;

    // Close BroadcastChannel if it exists
    if (this.channel) {
      this.channel.onmessage = null;
      try {
        this.channel.close();
      } catch (err) {
        console.warn('[Sync] Error closing BroadcastChannel:', err);
      }
      this.channel = null;
    }

    // Clear any references
    this.projectorWindow = null;
    this.controlWindow = null;
    this._statusListeners.clear();
  }
}
