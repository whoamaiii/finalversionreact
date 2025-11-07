/**
 * Main Application Entry Point
 *
 * This is the central file that orchestrates the entire application.
 * Think of it like the conductor of an orchestra - it coordinates all the different
 * parts (audio engine, 3D scene, settings UI, synchronization) to work together.
 *
 * What this file does:
 * 1. Imports and initializes all major components (scene, audio, settings UI, sync)
 * 2. Sets up event handlers (window resize, mouse movement, drag-and-drop)
 * 3. Runs the main animation loop that updates everything every frame
 * 4. Handles WebSocket connection for sending audio features to TouchDesigner
 * 5. Manages pause/resume behavior when the browser tab is hidden/shown
 *
 * Data Flow:
 * - AudioEngine analyzes audio and produces features (beats, frequencies, etc.)
 * - These features flow to Scene (to animate visuals) and SyncCoordinator (to sync multiple windows)
 * - Features are also sent over WebSocket to OSC bridge (for TouchDesigner integration)
 * - Settings UI controls parameters and displays status information
 */

// Import all the major components we need
import { initScene } from './scene.js';           // 3D scene and rendering
import { AudioEngine } from './audio.js';          // Audio analysis and processing
import { initSettingsUI, cleanupSettingsUI } from './settings-ui.js'; // Settings panel UI
import { SyncCoordinator } from './sync.js';      // Multi-window synchronization
import { resolveRoleFromUrl } from './sync.js';
import { printFeatureMatrix } from './feature.js'; // Browser capability detection
import { showToast, cleanupToast } from './toast.js';           // Temporary notification messages
import { detectAudioRoutingCapabilities } from './audio-routing-detector.js';
import { PresetManager } from './preset-manager.js';
import { openPresetLibraryWindow } from './preset-library-window.js';
import { PerformanceController } from './performance-pads.js';
import PerformanceMonitor from './performance-monitor.js';
import PerformanceHud from './performance-hud.js';
import { ResourceLifecycle } from './resource-lifecycle.js';
import { AutoSaveCoordinator } from './state/autoSaveCoordinator.js';
import { SessionPersistence } from './storage/sessionPersistence.js';
import { showRecoveryModal } from './recovery-modal.js';
import { ReadinessGate } from './readiness-gate.js';

// Debug mode: print browser feature support matrix when ?debug is in the URL
// This helps developers understand what capabilities are available
if (new URLSearchParams(location.search).has('debug')) {
  printFeatureMatrix();
}

const sessionRecoveryGate = new ReadinessGate('SessionRecovery');
const SESSION_RECOVERY_DEPENDENCIES = ['sceneApi', 'audioEngine', 'presetManager'];
const SESSION_RECOVERY_READY_TIMEOUT_MS = 5000;

// Promise-based locking for modal to prevent race conditions
let _recoveryModalPromise = null;

SESSION_RECOVERY_DEPENDENCIES.forEach((dependency) => sessionRecoveryGate.register(dependency));

// Initialize the 3D scene and get its API
// The scene handles all the visual rendering (particles, shaders, etc.)
const sceneApi = initScene();
if (sceneApi) {
  sessionRecoveryGate.setReady('sceneApi');
}

// Create the audio engine that processes audio and extracts features
const audio = new AudioEngine();
if (audio) {
  sessionRecoveryGate.setReady('audioEngine');
}

let performanceHud = null;

// Global performance monitor for Guardian system
// Wrapped with ResourceLifecycle for proper state management
let performanceMonitor = null;
const performanceMonitorPromise = (() => {
  const lifecycle = new ResourceLifecycle('PerformanceMonitor');
  
  return lifecycle.initialize(async () => {
    const monitor = new PerformanceMonitor({
      renderer: sceneApi?.state?.renderer ?? null,
      autoInstrumentRenderer: true,
      onMetricsUpdated: (metrics) => {
        try {
          performanceHud?.update(metrics);
        } catch (err) {
          if (metrics && typeof metrics.frameId === 'number' && metrics.frameId % 120 === 0) {
            console.debug('[PerformanceHud] update failed', err);
          }
        }
      },
    });
    
    // Store lifecycle reference for cleanup
    monitor._lifecycle = lifecycle;
    
    try { window.__performanceMonitor = monitor; } catch (_) {}
    return monitor;
  }).then(monitor => {
    if (monitor) {
      lifecycle.assertReady();
      performanceMonitor = monitor; // Store resolved value
    }
    return monitor;
  }).catch(err => {
    console.warn('[PerformanceMonitor] init failed', err);
    performanceMonitor = null;
    return null;
  });
})();

// Initialize PerformanceHud once monitor is ready
performanceMonitorPromise.then(monitor => {
  if (monitor) {
    try {
      performanceHud = new PerformanceHud({
        targetFpsProvider: () => sceneApi.state?.params?.targetFps || 60,
        qualityProvider: () => ({
          pixelRatio: sceneApi.getPixelRatio?.(),
          pixelRatioCap: sceneApi.state?.params?.pixelRatioCap,
          minPixelRatio: sceneApi.state?.params?.minPixelRatio,
          autoResolution: !!sceneApi.state?.params?.autoResolution,
          profile: sceneApi.state?.params?.effectsProfile,
        }),
      });
      try { window.__performanceHud = performanceHud; } catch (_) {}
    } catch (err) {
      console.warn('[PerformanceHud] init failed', err);
      performanceHud = null;
    }
  }
}).catch(err => {
  console.warn('[PerformanceMonitor] Failed to initialize:', err);
});

async function initAudioRoutingDetection() {
  try {
    const capabilities = await detectAudioRoutingCapabilities();
    try { window.__audioRoutingCapabilities = capabilities; } catch (_) {}

    const { os, capabilityMatrix, devices, enumerateError } = capabilities;
    const groupLabel = `[Audio Routing] ${os} capability matrix`;
    try {
      console.groupCollapsed(groupLabel);
      console.info('Capabilities', capabilityMatrix);
      console.info('Audio inputs', devices.audioInputs);
      console.info('Audio outputs', devices.audioOutputs);
      if (enumerateError) {
        console.warn('enumerateDevices error', enumerateError);
      }
      console.groupEnd();
    } catch (_) {
      console.info(groupLabel, capabilityMatrix);
    }

    if (!capabilityMatrix.blackhole.available) {
      const needsPermission = capabilityMatrix.blackhole.needsPermission;
      let recommendation = 'Install a virtual audio device for low-latency routing. See docs/AUDIO_SETUP.md.';
      if (os === 'macos') {
        recommendation = 'BlackHole not detected. Follow docs/AUDIO_SETUP.md to install and enable it.';
      } else if (os === 'windows') {
        recommendation = 'VB-Cable not detected. Install it for reliable system audio (docs/AUDIO_SETUP.md).';
      } else if (os === 'linux') {
        recommendation = 'PulseAudio virtual sink not detected. Create one using the steps in docs/AUDIO_SETUP.md.';
      }
      if (needsPermission) {
        recommendation += ' Grant microphone permissions so the browser can enumerate audio devices.';
      }
      try { showToast(recommendation, 5200); } catch (_) {}
    }
  } catch (error) {
    console.warn('[Audio Routing] Capability detection failed', error);
  }
}

initAudioRoutingDetection();

const diagnosticsEnabled = new URLSearchParams(location.search).has('diagnostics');
const diagnosticsLogIntervalMs = 5000;
const diagnosticsMaxDurationMs = 300000; // 5 minutes max to prevent unbounded logging
const diagnosticsMaxLogs = 100; // Stop after 100 samples (8.3 minutes at 5sec intervals)
const diagnosticsClearIntervalLogs = 20; // Clear console every 20 samples to prevent memory buildup
let diagnosticsLastLog = typeof performance !== 'undefined' ? performance.now() : Date.now();
let diagnosticsStartTime = diagnosticsLastLog;
let diagnosticsLogCount = 0;
let diagnosticsActive = diagnosticsEnabled;
if (diagnosticsEnabled) {
  console.info('[Audio Diagnostics] Logging audio analysis metrics every 5 seconds');
  console.info('[Audio Diagnostics] Auto-disable after 5 minutes or 100 logs to prevent memory accumulation');
  console.warn('[Audio Diagnostics] ⚠️ Console memory warning: Close DevTools when not actively debugging');
  console.info('[Audio Diagnostics] Console will auto-clear every', diagnosticsClearIntervalLogs, 'samples to reduce memory usage');
  try { window.__audioDiagnostics = audio; } catch (_) {}
}

// Auto-stutter mode: automatically adjust stutter window based on BPM/patterns
const autoStutterUpdateIntervalMs = 500; // Recalculate every 500ms (smooth without being too reactive)
let autoStutterLastUpdate = 0;
let autoStutterCurrentValue = 180; // Start with default value, will sync with actual on first update

// Create the sync coordinator for multi-window synchronization
// This allows multiple browser windows to stay in sync (control + projector mode)
const sync = new SyncCoordinator({ role: resolveRoleFromUrl(location.search), sceneApi });
// Webcam feature removed; no global exposure needed

// Preset manager orchestrates capture, persistence, and live preset operations
const presetManager = new PresetManager({ sceneApi, audioEngine: audio });
if (presetManager) {
  sessionRecoveryGate.setReady('presetManager');
}

// Session Recovery System - Phase 1: Continuous State Snapshotting
// =================================================================
const SESSION_ACTIVE_KEY = 'cosmic_session_active';
const SESSION_START_TIME_KEY = 'cosmic_session_start_time';

// Check for crash on startup
let crashedSessionDetected = false;
let crashedSnapshot = null;

/**
 * Request session recovery modal (with race condition protection)
 * Uses promise-based locking to ensure only ONE modal is ever created
 */
async function requestSessionRecoveryModal(snapshot) {
  if (!snapshot) return;

  // If modal already requested, return existing promise
  if (_recoveryModalPromise) {
    console.log('[SessionRecovery] Modal already requested, returning existing promise');
    return _recoveryModalPromise;
  }

  // Create new modal promise with atomic locking
  _recoveryModalPromise = (async () => {
    try {
      // Wait for dependencies to be ready
      await sessionRecoveryGate.whenReady(
        SESSION_RECOVERY_DEPENDENCIES,
        SESSION_RECOVERY_READY_TIMEOUT_MS
      );

      // Double-check: DOM check after async boundary to prevent duplicate modals
      const existingModal = document.querySelector('.recovery-modal-overlay');
      if (existingModal) {
        console.log('[SessionRecovery] Modal already exists in DOM, skipping');
        return;
      }

      console.log('[SessionRecovery] Presenting recovery modal');

      // Show modal
      const modal = showRecoveryModal({
        snapshot,
        context: { sceneApi, audioEngine: audio, presetManager },
        onRestore: (state, context) => {
          restoreCrashedSession(state, context);
          // Clear promise when modal closes
          _recoveryModalPromise = null;
        },
        onStartFresh: (_snapshot) => {
          console.log('[SessionRecovery] Starting fresh, snapshot archived');
          // Clear promise when modal closes
          _recoveryModalPromise = null;
        },
      });

      return modal;
    } catch (err) {
      console.error('[SessionRecovery] Failed to present recovery modal:', err);

      // Reset promise after delay to allow retry
      setTimeout(() => {
        _recoveryModalPromise = null;
        console.log('[SessionRecovery] Promise reset, retry allowed after 5s');
      }, 5000);

      throw err;
    }
  })();

  return _recoveryModalPromise;
}

try {
  const wasActive = localStorage.getItem(SESSION_ACTIVE_KEY) === 'true';
  if (wasActive) {
    // Previous session didn't cleanly shut down - crash detected
    crashedSessionDetected = true;
    console.warn('[SessionRecovery] Previous session ended unexpectedly (crash detected)');
    
    // Try to load the crashed snapshot (async, will be handled later)
    const persistence = new SessionPersistence();
    const compressed = persistence.load();
    if (compressed) {
      // Load snapshot asynchronously
      import('./state-snapshot.js').then(({ StateSnapshot }) => {
        try {
          crashedSnapshot = StateSnapshot.decompress(compressed);
          console.log('[SessionRecovery] Loaded crashed snapshot:', crashedSnapshot.getDescription());
          
          requestSessionRecoveryModal(crashedSnapshot);
        } catch (err) {
          console.error('[SessionRecovery] Failed to decompress crashed snapshot:', err);
        }
      }).catch(err => {
        console.error('[SessionRecovery] Failed to load snapshot module:', err);
      });
    } else {
      // No snapshot available, but crash was detected
      console.warn('[SessionRecovery] Crash detected but no snapshot found');
    }
  }
  
  // Mark new session as active
  localStorage.setItem(SESSION_ACTIVE_KEY, 'true');
  const sessionStartTime = Date.now();
  localStorage.setItem(SESSION_START_TIME_KEY, String(sessionStartTime));
} catch (err) {
  console.warn('[SessionRecovery] Failed to check session state:', err);
}

/**
 * Restore crashed session
 */
async function restoreCrashedSession(snapshot, context) {
  const { sceneApi, audioEngine, presetManager } = context;
  
  try {
    // Restore preset if available
    if (snapshot.preset?.snapshot) {
      const { applyPresetSnapshot } = await import('./preset-io.js');
      applyPresetSnapshot(snapshot.preset.snapshot, { sceneApi, audioEngine, silent: true });
      
      // Load preset in manager
      if (snapshot.preset.id && presetManager) {
        try {
          presetManager.load(snapshot.preset.id, { silent: true });
        } catch (err) {
          console.warn('[SessionRecovery] Failed to load preset:', err);
        }
      }
    }
    
    // Restore audio source
    if (snapshot.audioSource?.type === 'mic' && snapshot.audioSource.deviceId) {
      audioEngine.startMic(snapshot.audioSource.deviceId).catch(err => {
        console.warn('[SessionRecovery] Failed to restore audio:', err);
      });
    }
    
    console.log('[SessionRecovery] Session restored successfully');
  } catch (err) {
    console.error('[SessionRecovery] Restore failed:', err);
    throw err;
  }
}

// Initialize auto-save coordinator
let autoSaveCoordinator = null;
try {
  autoSaveCoordinator = new AutoSaveCoordinator({
    sceneApi,
    audioEngine: audio,
    presetManager,
    sessionStartTime: parseInt(localStorage.getItem(SESSION_START_TIME_KEY) || '0', 10) || Date.now(),
  });
  
  // Hook into preset manager events
  if (presetManager && typeof presetManager.on === 'function') {
    presetManager.on('preset-loaded', () => {
      autoSaveCoordinator?.handleEvent('preset-changed');
    });
    presetManager.on('preset-saved', () => {
      autoSaveCoordinator?.handleEvent('preset-changed');
    });
  }
  
  // Start auto-saving
  autoSaveCoordinator.start();
  
  // Expose for debugging
  try { window.__autoSaveCoordinator = autoSaveCoordinator; } catch (_) {}
  
  // Integrate recovery system with sync coordinator (after autoSaveCoordinator is ready)
  if (sync && sync.role === 'control') {
    // Control window: broadcast recovery snapshots to projector windows
    sync.setRecoveryRequestHandler(() => {
      // Projector requested recovery - send latest snapshot
      const persistence = new SessionPersistence();
      const compressed = persistence.load();
      if (compressed) {
        import('./state-snapshot.js').then(({ StateSnapshot }) => {
          try {
            const snapshot = StateSnapshot.decompress(compressed);
            sync.broadcastRecovery(snapshot);
          } catch (err) {
            console.error('[Sync] Failed to load recovery snapshot:', err);
          }
        });
      }
    });
    
    // Start health check for projector windows
    sync.startHealthCheck();
    
    // Handle projector crash detection
    sync.setProjectorCrashHandler(() => {
      console.warn('[Sync] Projector window not responding - possible crash');
      try {
        showToast('Projector not responding. Use "Reset All Windows" to restart.', 5000);
      } catch (_) {}
    });
  }
  
  // Projector windows: listen for recovery events
  if (sync && sync.role === 'receiver') {
    sync.setRecoveryApplyHandler((snapshotData) => {
      // Deserialize and apply recovery snapshot
      import('./state-snapshot.js').then(({ StateSnapshot }) => {
        try {
          const snapshot = StateSnapshot.deserialize(snapshotData);
          restoreCrashedSession(snapshot, { sceneApi, audioEngine: audio, presetManager });
        } catch (err) {
          console.error('[Sync] Failed to deserialize recovery snapshot:', err);
        }
      });
    });
    
    // Request recovery on startup if control window is available
    setTimeout(() => {
      sync.requestRecovery();
    }, 1000);
  }
} catch (err) {
  console.warn('[SessionRecovery] Failed to initialize auto-save:', err);
}

let presetLibraryUI = null;
const openPresetLibrary = () => {
  try {
    presetLibraryUI = openPresetLibraryWindow(presetManager, {
      onClose: () => { presetLibraryUI = null; },
      onError: (err) => {
        console.error('Failed to open preset library', err);
        try { showToast('Preset library popup blocked'); } catch (_) {}
      },
    });
  } catch (err) {
    console.error('Failed to open preset library', err);
    try { showToast('Preset library unavailable'); } catch (_) {}
  }
};
// Performance Pads (Phase 1: Pad 1 only)
// --------------------------------------
let performancePads;
try {
  performancePads = new PerformanceController({ sceneApi, sync });
  // Provide a per-frame deltas getter to the scene so it can blend with audio baseline
  // (Provider is finalized below after MIDI creation to merge deltas)
} catch (_) {
  performancePads = { update: () => {}, getDeltas: () => null };
}

// Provide scene with reactive deltas driven by performance pads
sceneApi.setUniformDeltasProvider(() => {
  try {
    return performancePads.getDeltas?.() || null;
  } catch (err) {
    console.warn('Performance pads getDeltas error:', err);
    return null;
  }
});

// Named event handler for preset library shortcut
function handlePresetLibraryShortcut(event) {
  if (event.defaultPrevented) return;
  if (event.repeat) return;
  const key = event.key || '';
  if (key !== 'L' && key !== 'l') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = (event.target && event.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select', 'button'].includes(tag)) return;
  event.preventDefault();
  openPresetLibrary();
}

// Initialize the settings UI
// This creates the settings panel that slides in from the right side
// We wrap it in a try-catch so the app continues working even if UI fails to load
let ui;
try {
  ui = initSettingsUI({
    sceneApi,           // Pass scene API so UI can control visuals
    audioEngine: audio, // Pass audio engine so UI can control audio
    syncCoordinator: sync, // Pass sync coordinator so UI can control synchronization
    presetManager,
    openPresetLibrary,
    
    // Callback: User clicked "Start System Audio" button
    // This attempts to capture system audio (what's playing on the computer)
    onRequestSystemAudio: async () => {
      try {
        await audio.startSystemAudio();
      } catch (e) {
        // If it fails, show a helpful error message
        try { showToast('System audio unavailable. Try Chrome + screen audio, or use BlackHole.', 3200); } catch(_) {}
        console.error(e);
      }
    },
    
    // Callback: User clicked "Start Microphone" button
    // This starts capturing audio from the microphone
    onRequestMic: async () => {
      try {
        // Use Settings → Source device list for selection (no prompts during show)
        // undefined means use default device
        await audio.startMic(undefined);
      } catch (e) {
        // If microphone access is denied or fails, show error
        try { showToast('Microphone capture failed or was denied.', 2800); } catch(_) {}
        console.error(e);
      }
    },
    
    // Callback: User wants to load an audio file
    // This either opens a file picker or loads a dropped file
    onRequestFile: async (file) => {
      try {
        if (!file) {
          // No file provided, so open a file picker dialog
          const input = document.createElement('input');
          input.type = 'file';           // File input
          input.accept = 'audio/*';      // Only accept audio files

          // Cleanup helper to ensure proper disposal in all code paths
          // This prevents memory leaks from orphaned input elements
          let cleanupCalled = false;
          let timeoutId; // Declare before cleanup function to avoid reference error
          const cleanup = () => {
            if (cleanupCalled) return; // Prevent double cleanup
            cleanupCalled = true;

            // Clear event handlers
            input.onchange = null;
            input.oncancel = null;

            // Clear and nullify timeout to prevent race conditions
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }

            // Safely remove element (may already be removed)
            try {
              if (input.parentNode) {
                input.remove();
              }
            } catch (_) {
              // Element already removed or detached, ignore
            }
          };

          // Safety timeout: cleanup after 5 minutes if user never interacts
          // This handles edge cases where oncancel doesn't fire (browser quirks)
          timeoutId = setTimeout(() => {
            cleanup();
            console.warn('[FileInput] Cleanup timeout triggered (5 min)');
          }, 300000);

          input.onchange = async () => {
            const f = input.files?.[0]; // Get the selected file
            if (f) await audio.loadFile(f); // Load it
            cleanup(); // Clean up: remove event handler and element
          };

          // Also handle cancel case (user closes picker without selecting)
          input.oncancel = () => {
            cleanup();
          };

          input.click(); // Trigger the file picker
        } else {
          // File was provided (e.g., from drag-and-drop), load it directly
          await audio.loadFile(file);
        }
      } catch (e) {
        // If file loading fails, show error
        try { showToast('Audio file load failed.', 2600); } catch(_) {}
        console.error(e);
      }
    },
    
    // Callback: User clicked "Stop Audio" button
    // This stops all audio processing
    onStopAudio: () => audio.stop(),
    
    // Callback: User clicked "Screenshot" button
    // This captures the current frame as a PNG image
    onScreenshot: () => {
      try {
        // Get the canvas element from Three.js renderer
        const dataUrl = sceneApi.state.renderer.domElement.toDataURL('image/png');
        // Create a download link and trigger it
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = 'cosmic-anomaly.png'; // Filename
        a.click(); // Trigger download
      } catch (e) { console.error(e); }
    },
  });
} catch (e) {
  // If UI initialization fails, create a minimal stub so the app doesn't break
  console.error('UI failed to initialize, continuing without control panel.', e);
  ui = { 
    updateFpsLabel: () => {},      // No-op functions
    updateBpmLabel: () => {}, 
    updateTapAndDrift: () => {}, 
    updateDriftDetails: () => {} 
  };
}

// Theme is initialized inside scene init; avoid duplicate initial set

// WebSocket Feature Broadcaster
// =============================
// This section handles sending audio features to TouchDesigner via the OSC bridge.
// The bridge runs on localhost:8090 and converts WebSocket messages to OSC.
//
// Features sent include:
// - RMS (volume levels)
// - Frequency bands
// - Beat detection
// - BPM (tempo)
// - MFCC (audio characteristics)
// - Chroma (musical notes)
// - Pitch information

// WebSocket connection state tracking
let featureWs = null;                    // The WebSocket connection object
let featureWsConnected = false;          // Is the connection currently open?
let featureWsConnecting = false;         // Are we currently trying to connect?
let featureWsInstanceId = 0;             // Monotonic counter to identify WebSocket instances
let featureWsLastAttemptMs = 0;          // Timestamp of last connection attempt
let featureWsLastSendMs = 0;             // Timestamp of last feature send
let featureWsBackoffMs = 2500;           // Delay before retrying (exponential backoff, capped)
let featureWsAttemptCount = 0;           // Attempts made in current window
let featureWsLockoutUntil = 0;           // Timestamp when we're allowed to try again after repeated failures
let featureWsLockoutNotifiedAt = 0;      // Last time we notified the user about lockout
const FEATURE_WS_URL = 'ws://127.0.0.1:8090'; // WebSocket server URL (OSC bridge)
const FEATURE_WS_MAX_ATTEMPTS = 12;      // Maximum consecutive attempts before pausing
const FEATURE_WS_LOCKOUT_MS = 60000;     // Pause duration (ms) after hitting attempt ceiling

/**
 * Closes the WebSocket connection and cleans up event handlers.
 * This prevents memory leaks when connections are recreated.
 */
function closeFeatureWs({ resetState = false } = {}) {
  if (featureWs) {
    // Remove event handlers to prevent memory leaks
    featureWs.onopen = null;
    featureWs.onclose = null;
    featureWs.onerror = null;
    featureWs.onmessage = null;

    // Close the connection if it's open
    try {
      if (featureWs.readyState === WebSocket.OPEN || featureWs.readyState === WebSocket.CONNECTING) {
        featureWs.close();
      }
    } catch (_) {}

    // Reset state
    featureWs = null;
    featureWsConnected = false;
    featureWsConnecting = false;
  }

  if (resetState) {
    featureWsAttemptCount = 0;
    featureWsLockoutUntil = 0;
    featureWsLockoutNotifiedAt = 0;
    featureWsBackoffMs = 2500;
  }
}

/**
 * Ensures the WebSocket connection is established.
 *
 * This function tries to connect to the OSC bridge if we're not already connected
 * or connecting. It uses exponential backoff and a lockout window to avoid spamming
 * connection attempts when the bridge is offline.
 *
 * @param {number} [nowMs] - Current timestamp (for rate limiting)
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - Ignore backoff/lockout guards for a manual retry
 */
function ensureFeatureWs(nowMs, { force = false } = {}) {
  const now = typeof nowMs === 'number' ? nowMs : performance.now();

  // Don't try if already connected or currently connecting
  if (featureWsConnected || featureWsConnecting) return;

  // Reset lockout if the cooldown has expired
  if (featureWsLockoutUntil && now >= featureWsLockoutUntil) {
    featureWsLockoutUntil = 0;
    featureWsLockoutNotifiedAt = 0;
  }

  // Respect active lockout unless explicitly forced
  if (!force && featureWsLockoutUntil && now < featureWsLockoutUntil) {
    return;
  }

  // After too many consecutive failures, pause attempts for a while
  if (!force && featureWsAttemptCount >= FEATURE_WS_MAX_ATTEMPTS) {
    featureWsLockoutUntil = now + FEATURE_WS_LOCKOUT_MS;
    featureWsAttemptCount = 0;
    if (!featureWsLockoutNotifiedAt || now - featureWsLockoutNotifiedAt > 1000) {
      featureWsLockoutNotifiedAt = now;
      console.warn('[FeatureWS] reached connection attempt limit, pausing retries for 60 seconds');
      try { showToast('OSC bridge unreachable. Pausing retries for 60s.', 4200); } catch (_) {}
    }
    return;
  }

  // Rate limit: don't try too often (respect backoff delay)
  if (!force && now - featureWsLastAttemptMs < featureWsBackoffMs) return;

  // Clean up any existing connection before creating new one
  closeFeatureWs();

  // CRITICAL: Set connecting flag AFTER cleanup to prevent race condition
  // This ensures multiple rapid calls don't create duplicate WebSocket connections
  // Must be AFTER closeFeatureWs() which resets this flag
  featureWsConnecting = true;

  // Record this attempt
  featureWsLastAttemptMs = now;
  featureWsAttemptCount += 1;

  let ws;
  try {
    // Create new WebSocket connection with unique instance ID
    ws = new WebSocket(FEATURE_WS_URL);
    const instanceId = ++featureWsInstanceId;
    ws._instanceId = instanceId; // Tag for validation

    // Connection opened successfully
    ws.onopen = () => {
      // Only update state if this is still the current WebSocket instance
      if (ws === featureWs && ws._instanceId === featureWsInstanceId) {
        featureWsConnected = true;
        featureWsConnecting = false;
        featureWsLastSendMs = 0; // Reset send timer
        featureWsBackoffMs = 2500; // Reset backoff on success
        featureWsAttemptCount = 0;
        featureWsLockoutUntil = 0;
        featureWsLockoutNotifiedAt = 0;
      }
    };

    // Connection closed (will retry with backoff)
    ws.onclose = () => {
      // Only update state if this is still the current WebSocket instance
      if (ws === featureWs && ws._instanceId === featureWsInstanceId) {
        featureWsConnected = false;
        featureWsConnecting = false;
        featureWs = null;
        // Increase backoff delay (exponential backoff, capped at 20 seconds)
        featureWsBackoffMs = Math.min(20000, Math.max(2500, featureWsBackoffMs * 1.6));
      }
    };

    // Connection error - close it cleanly
    // Only close if this is still the current instance to avoid interfering with new connections
    ws.onerror = () => {
      if (ws === featureWs && ws._instanceId === featureWsInstanceId) {
        try { ws.close(); } catch(_) {}
      }
    };

    featureWs = ws;
  } catch (_) {
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch (closeErr) {
        // Ignore cleanup errors
      }
    }
    // If connection fails, reset state
    featureWsConnected = false;
    featureWsConnecting = false;
    featureWs = null;
  }
}

/**
 * Sends audio features over WebSocket to the OSC bridge.
 * 
 * This packages up all the audio analysis features and sends them to TouchDesigner.
 * Features are throttled to ~30Hz (33ms between sends) to avoid overwhelming the connection.
 *
 * @param {Object} features - Audio features object from AudioEngine
 * @param {number} nowMs - Current timestamp (for rate limiting)
 */
function sendFeaturesOverWs(features, nowMs) {
  // Don't send if not connected or no WebSocket, check readyState to prevent race condition
  if (!featureWsConnected || !featureWs || featureWs.readyState !== WebSocket.OPEN) return;
  if (!features) return;

  // Rate limit: only send ~30 times per second (once every 33ms)
  if (nowMs - featureWsLastSendMs < 33) return;
  featureWsLastSendMs = nowMs;

  try {
    // Double-check readyState before sending
    if (featureWs.readyState !== WebSocket.OPEN) {
      featureWsConnected = false;
      return;
    }

    // Package up all the features we want to send
    const payload = {
      rms: features.rms,                    // Root mean square (overall volume)
      rmsNorm: features.rmsNorm,             // Normalized RMS (0-1)
      bandsEMA: features.bandsEMA,           // Frequency bands (exponentially smoothed)
      bandEnv: features.bandEnv,            // Frequency band envelopes
      bandNorm: features.bandNorm,          // Normalized frequency bands
      centroidNorm: features.centroidNorm,  // Spectral centroid (brightness, normalized)
      flux: features.flux,                  // Spectral flux (how much frequencies are changing)
      fluxMean: features.fluxMean,           // Average flux
      fluxStd: features.fluxStd,             // Standard deviation of flux
      beat: !!features.beat,                // Beat detected (boolean)
      drop: !!features.drop,                // Drop detected (boolean)
      isBuilding: !!features.isBuilding,    // Energy building up (boolean)
      buildLevel: features.buildLevel,      // How much energy is building (0-1)
      bpm: features.bpm,                    // Beats per minute (tempo)
      bpmConfidence: features.bpmConfidence, // How confident we are in the BPM (0-1)
      bpmSource: features.bpmSource,         // Where BPM came from ('tap', 'beatGrid', etc.)
      tapBpm: features.tapBpm,              // Manually tapped BPM
      mfcc: features.mfcc,                   // Mel-frequency cepstral coefficients (audio characteristics)
      chroma: features.chroma,               // Chroma features (musical note information)
      pitchHz: features.pitchHz,             // Detected pitch in Hz
      pitchConf: features.pitchConf,         // Pitch detection confidence (0-1)
      aubioTempoBpm: features.aubioTempoBpm, // BPM from Aubio library
      aubioTempoConf: features.aubioTempoConf, // Aubio confidence
      beatGrid: features.beatGrid ? {        // Beat grid information (if available)
        bpm: features.beatGrid.bpm,
        confidence: features.beatGrid.confidence
      } : null,
    };
    
    // Send as JSON message
    featureWs.send(JSON.stringify({ type: 'features', payload }));
  } catch (_) {
    // If send fails, silently ignore (connection will retry)
  }
}

// Window Event Handlers
// =====================

// Store references to event handlers for cleanup
const eventHandlers = {
  resize: sceneApi.onResize,
  mousemove: sceneApi.onMouseMove,
  focus: null,        // Will be set below
  pointerdown: null,  // Will be set below
  dragenter: null,    // Will be set below
  dragover: null,     // Will be set below
  dragleave: null,    // Will be set below
  drop: null,         // Will be set below
  visibilitychange: null, // Will be set below
  beforeunload: null,     // Will be set below
  systemAudioHelp: null,  // Will be set below
  presetLibraryShortcut: handlePresetLibraryShortcut
};

// Handle window resize - update the 3D scene to match new window size
window.addEventListener('resize', eventHandlers.resize);

// Handle mouse movement - update camera/interaction based on mouse position
window.addEventListener('mousemove', eventHandlers.mousemove);

// Pause/Resume Management
// ======================
// When the browser tab is hidden, pause audio processing to save resources.
// When it becomes visible again, resume everything.

// Shortcut handler for preset library toggle
if (eventHandlers.presetLibraryShortcut) {
  window.addEventListener('keydown', eventHandlers.presetLibraryShortcut);
}

let isPaused = false; // Track if we're currently paused

// Audio Context Resume Race Condition Protection
// ===============================================
// Atomic flag to prevent multiple simultaneous resume attempts that can cause
// audio to get stuck in suspended state during rapid tab switching or interaction.
let _audioResumeInProgress = false;

/**
 * Safely resume audio context with atomic locking to prevent race conditions.
 * Multiple event handlers (visibility, focus, pointerdown, watchdog) can trigger
 * resume simultaneously. This function ensures only one resume happens at a time.
 *
 * @param {string} context - Description of what triggered the resume (for debugging)
 * @returns {Promise<boolean>} True if resumed successfully, false otherwise
 */
async function safeResumeAudioContext(context = 'unknown') {
  // Already resuming, skip to prevent race
  if (_audioResumeInProgress) {
    return false;
  }

  // No audio context or already running
  if (!audio.ctx || audio.ctx.state !== 'suspended') {
    return false;
  }

  // Acquire lock
  _audioResumeInProgress = true;

  try {
    await audio.ctx.resume();
    _audioResumeFailureCount = 0; // Reset on success
    return true;
  } catch (err) {
    handleAudioResumeError(err, context);
    return false;
  } finally {
    // Always release lock
    _audioResumeInProgress = false;
  }
}

// Named handler for visibility changes (tab hidden/shown)
async function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    // Tab was hidden - pause everything
    isPaused = true;
    lastTime = performance.now(); // Reset time tracking
    try { await audio.ctx?.suspend?.(); } catch (err) {
      console.warn('Failed to suspend audio context:', err);
    } // Suspend audio context
  } else {
    // Tab became visible - resume everything
    isPaused = false;
    lastTime = performance.now(); // Reset time tracking
    await safeResumeAudioContext('visibility change');
  }
}

// Store handler reference for cleanup
eventHandlers.visibilitychange = handleVisibilityChange;

// Listen for visibility changes (tab hidden/shown)
document.addEventListener('visibilitychange', eventHandlers.visibilitychange);

// Resume Watchdog
// ===============
// Some browsers (especially Safari) can suspend the audio context unexpectedly.
// These event handlers aggressively resume it when the user interacts with the page.

// Track consecutive resume failures to notify user of persistent issues
let _audioResumeFailureCount = 0;
let _lastAudioResumeNotification = 0;
const AUDIO_RESUME_NOTIFICATION_THRESHOLD = 3;
const AUDIO_RESUME_NOTIFICATION_COOLDOWN_MS = 30000; // 30 seconds

function handleAudioResumeError(err, context) {
  console.warn(`Failed to resume audio on ${context}:`, err);
  _audioResumeFailureCount++;

  // Notify user after threshold of consecutive failures
  const now = performance.now();
  if (_audioResumeFailureCount >= AUDIO_RESUME_NOTIFICATION_THRESHOLD &&
      now - _lastAudioResumeNotification > AUDIO_RESUME_NOTIFICATION_COOLDOWN_MS) {
    try {
      showToast('Audio playback blocked. Check browser permissions or click the audio unlock button.', 5000);
      _lastAudioResumeNotification = now;
      _audioResumeFailureCount = 0; // Reset after notifying
    } catch (_) {
      // Toast unavailable, user will see console warnings
    }
  }
}

// Resume on window focus (user clicks back into the tab)
eventHandlers.focus = async () => {
  await safeResumeAudioContext('focus');
};
window.addEventListener('focus', eventHandlers.focus);

// Resume on pointer down (user clicks/taps anywhere)
eventHandlers.pointerdown = async () => {
  await safeResumeAudioContext('pointer down');
};
window.addEventListener('pointerdown', eventHandlers.pointerdown);

// Cleanup on page unload to prevent memory leaks
eventHandlers.beforeunload = () => {
  // Mark session as cleanly closed (not crashed)
  try {
    localStorage.setItem(SESSION_ACTIVE_KEY, 'false');
    
    // Save final snapshot before shutdown
    if (autoSaveCoordinator) {
      autoSaveCoordinator.saveNow('shutdown', ['pre-crash']);
      autoSaveCoordinator.stop();
    }
  } catch (err) {
    console.warn('[SessionRecovery] Failed to mark clean shutdown:', err);
  }
  
  // Call the comprehensive cleanup function
  stopAnimation();
};
window.addEventListener('beforeunload', eventHandlers.beforeunload);

// Main Animation Loop
// ===================
// This is the heart of the application - it runs every frame (~60 times per second)
// and updates all components (audio, visuals, sync, WebSocket, UI).

let lastTime = performance.now(); // Last frame timestamp (for delta time calculation)

// FPS tracking variables
let fpsFrames = 0;        // Frame counter
let fpsElapsedMs = 0;     // Elapsed time accumulator
let fpsLast = performance.now(); // Last FPS calculation time

// Auto-resolution tracking variables
let autoFrames = 0;        // Frame counter for auto-resolution
let autoElapsedMs = 0;    // Elapsed time accumulator
let autoLast = performance.now(); // Last auto-resolution check time

// Resume watchdog tracking
let resumeWatchLastAttempt = 0; // Last time we tried to resume audio context
let animationFrameId = null; // Store RAF ID for proper cleanup

/**
 * Main animation loop function.
 *
 * This function runs continuously, updating:
 * - Audio analysis (extracting features from audio)
 * - 3D scene (animating visuals based on audio features)
 * - Synchronization (keeping multiple windows in sync)
 * - WebSocket communication (sending features to TouchDesigner)
 * - UI updates (FPS counter, BPM display, beat indicator)
 * - Auto-resolution (adjusting quality based on performance)
 */
function animate() {
  // Schedule the next frame (this creates the loop)
  animationFrameId = requestAnimationFrame(animate);
  
  const frameStart = performance.now();
  const pm = performanceMonitor;
  if (pm && pm._lifecycle?.isReady) {
    pm.beginFrame(frameStart);
  }
  const now = frameStart;
  
  // If paused, skip updating and reset timers
  if (isPaused) {
    lastTime = now;
    fpsLast = now;
    autoLast = now;
    // Reset auto-resolution counters to prevent calculation errors on resume
    autoFrames = 0;
    autoElapsedMs = 0;
    return;
  }
  
  // Resume watchdog: if tab is visible but audio context is suspended, try to resume it
  // Only try every 400ms to avoid spamming
  if (document.visibilityState === 'visible' && audio.ctx && audio.ctx.state === 'suspended') {
    if (now - resumeWatchLastAttempt > 400) {
      resumeWatchLastAttempt = now;
      safeResumeAudioContext('watchdog');
    }
  }
  
  // Calculate delta time (time since last frame) in seconds
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  
  // Update audio engine and get features
  // This analyzes the audio and extracts beat, frequency, tempo, etc.
  let features = null;
  if (pm) pm.markSectionStart('audio.update');
  try {
    features = audio.update();
  } finally {
    if (pm) pm.markSectionEnd('audio.update');
  }
  if (!features) {
    // Receiver windows can render using remote features from sync
    if (pm) pm.markSectionStart('sync.remoteFeatures');
    try {
      features = sync.getRemoteFeatures(now);
    } catch (err) {
      console.warn('Failed to get remote features:', err);
    } finally {
      if (pm) pm.markSectionEnd('sync.remoteFeatures');
    }
  }
  if (pm) pm.markSectionStart('performancePads.update');
  try {
    performancePads.update(dt, now, features);
  } catch (err) {
    console.warn('Performance pads update error:', err);
  } finally {
    if (pm) pm.markSectionEnd('performancePads.update');
  }

  const latestWorkletLatency = audio.getLastWorkletLatencyMs?.();
  if (pm && Number.isFinite(latestWorkletLatency)) {
    pm.recordAudioWorkletSample(latestWorkletLatency);
  }

  // Auto-stutter mode: Automatically adjust stutter window based on music tempo/pattern
  // This makes visuals adapt to different BPMs without manual tweaking
  if (pm) pm.markSectionStart('auto.stutter');
  try {
    if (features && sceneApi.state?.params?.visuals?.dispersion?.autoStutterMode) {
      // Only recalculate periodically (every 500ms) to avoid jitter
      if (now - autoStutterLastUpdate > autoStutterUpdateIntervalMs) {
        autoStutterLastUpdate = now;

        // Calculate optimal window size based on current BPM and pattern
        const optimalWindow = audio.calculateOptimalStutterWindow(features);

        // Smoothly interpolate towards target (prevents sudden jumps)
        const lerpFactor = 0.15; // Smooth transition over ~2-3 updates
        autoStutterCurrentValue = autoStutterCurrentValue * (1 - lerpFactor) + optimalWindow * lerpFactor;

        // Update the dispersion parameter (rounded to nearest 10ms for stability)
        const roundedValue = Math.round(autoStutterCurrentValue / 10) * 10;
        sceneApi.state.params.visuals.dispersion.stutterWindowMs = roundedValue;
      }
    } else {
      // When auto mode is off, sync our tracked value with the manual setting
      // This prevents jumps when re-enabling auto mode
      if (sceneApi.state?.params?.visuals?.dispersion?.stutterWindowMs) {
        autoStutterCurrentValue = sceneApi.state.params.visuals.dispersion.stutterWindowMs;
      }
    }
  } finally {
    if (pm) pm.markSectionEnd('auto.stutter');
  }

  // Auto-disable diagnostics after time/count limits to prevent memory accumulation
  if (diagnosticsActive) {
    const diagnosticsElapsed = now - diagnosticsStartTime;
    if (diagnosticsElapsed > diagnosticsMaxDurationMs || diagnosticsLogCount >= diagnosticsMaxLogs) {
      diagnosticsActive = false;
      console.warn('[Audio Diagnostics] Auto-disabled after',
        Math.floor(diagnosticsElapsed / 1000), 'seconds /',
        diagnosticsLogCount, 'logs to prevent console memory accumulation');
      console.info('[Audio Diagnostics] Reload with ?diagnostics to re-enable');
    }
  }

  if (diagnosticsActive && now - diagnosticsLastLog >= diagnosticsLogIntervalMs) {
    const summary = audio.getDiagnosticsSummary({ includeCurrent: true, reset: true });
    if (summary) {
      diagnosticsLogCount++;
      const fmt = (value) => (typeof value === 'number' && Number.isFinite(value)
        ? Number(value).toFixed(3)
        : 'n/a');
      const utilPct = (typeof summary.avgUtilization === 'number' && Number.isFinite(summary.avgUtilization))
        ? (summary.avgUtilization * 100).toFixed(1)
        : '0.0';

      // Use compact console.log instead of console.table to reduce memory footprint
      // This prevents large object accumulation in browser devtools memory
      console.log(
        `[Audio #${diagnosticsLogCount}]`,
        `${fmt(summary.avgUpdateMs)}ms avg`,
        `(${fmt(summary.minUpdateMs)}-${fmt(summary.maxUpdateMs)})`,
        `| ${utilPct}% util`,
        `| ${summary.sampleCount} samples`,
        `| worklet: ${fmt(summary.avgWorkletLatencyMs)}ms`,
        `(${fmt(summary.minWorkletLatencyMs)}-${fmt(summary.maxWorkletLatencyMs)})`
      );

      // Periodically clear console to prevent unbounded memory growth
      // Even with compact logging, browsers accumulate console history
      if (diagnosticsLogCount % diagnosticsClearIntervalLogs === 0) {
        try {
          console.info(`[Audio Diagnostics] Clearing console after ${diagnosticsLogCount} samples to free memory`);
          console.clear();
          console.info(`[Audio Diagnostics] Console cleared. Continuing diagnostics...`);
        } catch (_) {
          // console.clear() may be blocked in some environments
        }
      }
    }
    diagnosticsLastLog = now;
  }

  // Update 3D scene with audio features
  // This animates the particles and visuals based on the audio
  if (pm) pm.markSectionStart('scene.update');
  try {
    sceneApi.update(features);
  } finally {
    if (pm) pm.markSectionEnd('scene.update');
  }
  
  // Update synchronization coordinator
  // This handles syncing between multiple windows (control + projector mode)
  if (pm) pm.markSectionStart('sync.tick');
  try {
    sync.tick(now);
  } catch (_) {
    // existing best-effort behaviour
  } finally {
    if (pm) pm.markSectionEnd('sync.tick');
  }
  
  // Send local features to sync coordinator
  // This allows other windows to see what's happening here
  if (pm) pm.markSectionStart('sync.handleLocalFeatures');
  try {
    if (features) sync.handleLocalFeatures(features, now);
  } catch (_) {
    // swallow to match prior behaviour
  } finally {
    if (pm) pm.markSectionEnd('sync.handleLocalFeatures');
  }
  
  // Send parameter snapshots periodically
  // This syncs settings changes between windows
  if (pm) pm.markSectionStart('sync.maybeSendParamSnapshot');
  try {
    sync.maybeSendParamSnapshot(now);
  } catch (_) {
    // swallow to keep previous behaviour
  } finally {
    if (pm) pm.markSectionEnd('sync.maybeSendParamSnapshot');
  }
  
  // Maintain WebSocket connection and broadcast features
  // Try to connect if not connected
  if (pm) pm.markSectionStart('network.ws.ensure');
  try {
    if (!featureWsConnected) ensureFeatureWs(now);
  } finally {
    if (pm) pm.markSectionEnd('network.ws.ensure');
  }
  // Send features to TouchDesigner if connected
  if (pm) pm.markSectionStart('network.ws.send');
  try {
    if (features) sendFeaturesOverWs(features, now);
  } finally {
    if (pm) pm.markSectionEnd('network.ws.send');
  }
  
  // Defensive safety check: ensure core visuals exist
  // If something failed earlier, try to rebuild particles
  if (!sceneApi.state.coreSphere || !sceneApi.state.orbitRings) {
    try {
      console.warn('[Scene Recovery] Core visuals missing, attempting rebuild...');
      sceneApi.rebuildParticles();
      console.log('[Scene Recovery] Particle rebuild successful');
    } catch(err) {
      console.error('[Scene Recovery] Failed to rebuild particles:', err);
    }
  }
  
  // Update UI Labels
  // ================
  // These update the settings panel with current values
  if (pm) pm.markSectionStart('ui.update');
  try {
    // Update BPM label (shows detected tempo)
    if (features && ui.updateBpmLabel) {
      ui.updateBpmLabel({ 
        bpm: features.bpm, 
        confidence: features.bpmConfidence, 
        source: features.bpmSource 
      });
    }
    
    // Update tap BPM and drift display
    if (features && ui.updateTapAndDrift) {
      ui.updateTapAndDrift({ 
        tapBpm: features.tapBpm, 
        bpm: features.bpm 
      });
    }
    
    // Update drift details (more advanced tempo information)
    if (features && ui.updateDriftDetails) {
      ui.updateDriftDetails({
        tapBpm: features.tapBpm,
        beatGrid: features.beatGrid,
        aubioTempo: features.aubioTempoBpm,
        aubioConf: features.aubioTempoConf,
      });
    }
    
    // Update beat indicator (small pulsing dot in settings header)
    if (ui.updateBeatIndicator) {
      ui.updateBeatIndicator(!!(features && features.beat));
    }
  } finally {
    if (pm) pm.markSectionEnd('ui.update');
  }
  
  // FPS Tracking
  // ============
  // Calculate and display frames per second
  // We update the UI every 500ms with the average FPS
  
  fpsFrames += 1; // Increment frame counter
  const frameMs = (now - fpsLast); // Time since last calculation
  fpsElapsedMs += frameMs; // Accumulate elapsed time
  fpsLast = now;
  
  // If 500ms have passed, calculate and display FPS
  if (fpsElapsedMs > 500) {
    // Calculate: (frames / milliseconds) * 1000 = frames per second
    ui.updateFpsLabel((fpsFrames * 1000) / fpsElapsedMs);
    fpsFrames = 0; // Reset counters
    fpsElapsedMs = 0;
  }
  
  // Auto-Resolution System
  // ======================
  // Automatically adjusts rendering quality (pixel ratio) based on performance
  // If FPS is too low, reduce quality. If FPS is high, increase quality.
  // This ensures smooth performance on different hardware.
  
  if (pm) pm.markSectionStart('auto.resolution');
  try {
    if (sceneApi.state.params.autoResolution) {
      autoFrames += 1; // Increment frame counter
      const autoMs = (now - autoLast); // Time since last check
      autoElapsedMs += autoMs; // Accumulate elapsed time
      autoLast = now;
      
      // Check every ~3 seconds
      if (autoElapsedMs > 3000 && autoFrames > 0) {
        // Estimate current FPS (guard against division by zero or very small values)
        // Since we require autoElapsedMs > 3000, no need for additional MIN_ELAPSED_MS check
        const fpsApprox = (autoFrames * 1000) / autoElapsedMs;

        // Validate FPS calculation is finite and reasonable before using it
        if (Number.isFinite(fpsApprox) && fpsApprox > 0 && fpsApprox < 1000) {
          const target = sceneApi.state.params.targetFps || 60; // Target FPS (default 60)
          const currentPR = sceneApi.getPixelRatio(); // Current pixel ratio (quality)
          const desiredMaxPR = sceneApi.state.params.pixelRatioCap; // Maximum allowed quality

          let newPR = currentPR; // Start with current value

          // If FPS is too low, reduce quality (lower pixel ratio)
          if (fpsApprox < target - 8) {
            newPR = Math.max(sceneApi.state.params.minPixelRatio, currentPR - 0.05);
          }
          // If FPS is too high, increase quality (asymmetric hysteresis prevents oscillation)
          else if (fpsApprox > target + 12) {
            newPR = Math.min(desiredMaxPR, currentPR + 0.05);
          }

          // Only update if change is significant (avoids tiny adjustments)
          // Validate newPR is finite before using it
          if (Number.isFinite(newPR) && Math.abs(newPR - currentPR) > 0.01) {
            const clampedPR = parseFloat(newPR.toFixed(2));
            // Double-check the result is valid
            if (Number.isFinite(clampedPR)) {
              sceneApi.setPixelRatioCap(clampedPR);
            }
          }
        } else if (!Number.isFinite(fpsApprox)) {
          // Diagnostic logging for invalid FPS calculations to catch root cause
          console.error('[AutoRes] Invalid FPS calculation detected', {
            fpsApprox,
            autoFrames,
            autoElapsedMs,
            autoMs: now - autoLast,
            now,
            autoLast
          });
          // Force reset to recover from invalid state
          autoFrames = 0;
          autoElapsedMs = 0;
          autoLast = now;
        }

        // Reset counters (always reset even if calculation succeeded)
        if (Number.isFinite(fpsApprox)) {
          autoFrames = 0;
          autoElapsedMs = 0;
        }
      }
    }
  } finally {
    if (pm) pm.markSectionEnd('auto.resolution');
  }

  if (pm && pm._lifecycle?.isReady) {
    const frameEnd = performance.now();
    const targetFps = sceneApi.state?.params?.targetFps || 60;
    const renderBudgetMs = targetFps > 0 ? 1000 / targetFps : undefined;
    pm.endFrame({ timestamp: frameEnd, renderBudgetMs });
  }
}

// Animation control functions
function startAnimation() {
  if (!animationFrameId) {
    animate();
  }
}

/**
 * Removes all event listeners to prevent memory leaks
 */
function removeAllEventListeners() {
  // Remove window event listeners
  if (eventHandlers.resize) window.removeEventListener('resize', eventHandlers.resize);
  if (eventHandlers.mousemove) window.removeEventListener('mousemove', eventHandlers.mousemove);
  if (eventHandlers.focus) window.removeEventListener('focus', eventHandlers.focus);
  if (eventHandlers.pointerdown) window.removeEventListener('pointerdown', eventHandlers.pointerdown);
  if (eventHandlers.beforeunload) window.removeEventListener('beforeunload', eventHandlers.beforeunload);
  if (eventHandlers.dragenter) window.removeEventListener('dragenter', eventHandlers.dragenter);
  if (eventHandlers.dragover) window.removeEventListener('dragover', eventHandlers.dragover);
  if (eventHandlers.dragleave) window.removeEventListener('dragleave', eventHandlers.dragleave);
  if (eventHandlers.drop) window.removeEventListener('drop', eventHandlers.drop);
  if (eventHandlers.presetLibraryShortcut) window.removeEventListener('keydown', eventHandlers.presetLibraryShortcut);

  // Remove document event listeners
  if (eventHandlers.visibilitychange) document.removeEventListener('visibilitychange', eventHandlers.visibilitychange);

  // Remove button event listener
  const helpButton = document.getElementById('open-system-audio-help');
  if (helpButton && eventHandlers.systemAudioHelp) {
    helpButton.removeEventListener('click', eventHandlers.systemAudioHelp);
  }

  // Reset drag-drop listener flag to allow re-initialization
  window.__dragDropListenersAdded = false;
}

function stopAnimation() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  // Clean up storage quota check interval
  if (_quotaCheckIntervalId !== null) {
    clearInterval(_quotaCheckIntervalId);
    _quotaCheckIntervalId = null;
  }

  // Clean up WebSocket connection
  closeFeatureWs({ resetState: true });

  // Clean up sync coordinator
  if (sync && typeof sync.cleanup === 'function') {
    try {
      sync.cleanup();
    } catch (err) {
      console.warn('Error cleaning up sync coordinator:', err);
    }
  }

  // Clean up performance pads
  if (performancePads && typeof performancePads.cleanup === 'function') {
    try {
      performancePads.cleanup();
    } catch (err) {
      console.warn('Error cleaning up performance pads:', err);
    }
  }

  if (performanceHud && typeof performanceHud.destroy === 'function') {
    try {
      performanceHud.destroy();
    } catch (err) {
      console.warn('Error cleaning up performance HUD:', err);
    }
    performanceHud = null;
    try { window.__performanceHud = null; } catch (_) {}
  }

  // Clean up performance monitor using lifecycle wrapper
  if (performanceMonitor && performanceMonitor._lifecycle) {
    try {
      // Use fire-and-forget pattern since stopAnimation may be called from beforeunload
      // which can't wait for async operations
      performanceMonitor._lifecycle.close(async () => {
        if (typeof performanceMonitor.dispose === 'function') {
          performanceMonitor.dispose();
        }
      }).catch(err => {
        console.warn('Error cleaning up performance monitor:', err);
      });
    } catch (err) {
      console.warn('Error initiating performance monitor cleanup:', err);
      // Fallback to direct dispose if lifecycle.close fails
      if (typeof performanceMonitor.dispose === 'function') {
        try {
          performanceMonitor.dispose();
        } catch (disposeErr) {
          console.warn('Error disposing performance monitor:', disposeErr);
        }
      }
    }
  } else if (performanceMonitor && typeof performanceMonitor.dispose === 'function') {
    // Fallback if lifecycle not available
    try {
      performanceMonitor.dispose();
    } catch (err) {
      console.warn('Error cleaning up performance monitor:', err);
    }
  }

  // Clean up auto-save coordinator
  if (autoSaveCoordinator && typeof autoSaveCoordinator.dispose === 'function') {
    try {
      autoSaveCoordinator.dispose();
    } catch (err) {
      console.warn('Error cleaning up auto-save coordinator:', err);
    }
  }

  // Clean up preset manager
  if (presetManager && typeof presetManager.cleanup === 'function') {
    try {
      presetManager.cleanup();
    } catch (err) {
      console.warn('Error cleaning up preset manager:', err);
    }
  }

  // Clean up audio engine
  if (audio && typeof audio.dispose === 'function') {
    try {
      audio.dispose();
    } catch (err) {
      console.warn('Error disposing audio engine:', err);
    }
  }

  // Clean up Three.js scene and WebGL resources
  if (sceneApi && typeof sceneApi.dispose === 'function') {
    try {
      sceneApi.dispose();
    } catch (err) {
      console.warn('Error disposing scene resources:', err);
    }
  }

  // Clean up toast notifications
  try {
    cleanupToast();
  } catch (err) {
    console.warn('Error cleaning up toast:', err);
  }

  // Clean up settings UI event listeners
  try {
    cleanupSettingsUI();
  } catch (err) {
    console.warn('Error cleaning up settings UI:', err);
  }

  // Remove all event listeners
  removeAllEventListeners();
}

// Export for external control if needed
window.stopAnimation = stopAnimation;
window.startAnimation = startAnimation;

// Start the animation loop
startAnimation();

// Drag-and-Drop File Loading
// ===========================
// Allows users to drag audio files onto the window to load them

const dropOverlay = document.getElementById('drop-overlay');

// Named handlers for drag and drop
function handleDragEnterOver(e) {
  e.preventDefault(); // Prevent default browser behavior
  if (dropOverlay) dropOverlay.classList.add('active'); // Show overlay
}

function handleDragLeaveOrDrop(e) {
  e.preventDefault(); // Prevent default browser behavior
  if (dropOverlay) dropOverlay.classList.remove('active'); // Hide overlay
}

async function handleFileDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0]; // Get first dropped file

  // Only process audio files
  if (file && file.type.startsWith('audio/')) {
    try {
      await audio.loadFile(file);
    } catch (err) {
      console.error('Drop load failed', err);
      try { showToast('Audio file load failed.', 2600); } catch(_) {}
    }
  }
}

// Store drag-and-drop handlers
eventHandlers.dragenter = handleDragEnterOver;
eventHandlers.dragover = handleDragEnterOver;
eventHandlers.dragleave = handleDragLeaveOrDrop;
eventHandlers.drop = handleFileDrop;

// Add drag-and-drop listeners only if not already added (prevent duplication)
// These handlers are stored in eventHandlers object and removed in removeAllEventListeners()
if (!window.__dragDropListenersAdded) {
  window.addEventListener('dragenter', eventHandlers.dragenter);
  window.addEventListener('dragover', eventHandlers.dragover);
  window.addEventListener('dragleave', eventHandlers.dragleave);
  window.addEventListener('drop', eventHandlers.drop);
  window.__dragDropListenersAdded = true;
}

// localStorage Quota Monitoring
// ==============================
// Proactively warn users when storage is approaching capacity
// This prevents silent failures during live performances

let _lastQuotaCheck = 0;
let _quotaWarningShown = false;
let _quotaCheckIntervalId = null; // Store interval ID for cleanup
const QUOTA_CHECK_INTERVAL_MS = 300000; // Check every 5 minutes
const QUOTA_WARNING_THRESHOLD = 0.80; // Warn at 80% capacity

/**
 * Check localStorage quota and warn if approaching limit.
 * Uses Storage API when available, falls back to error-based detection.
 */
async function checkStorageQuota() {
  const now = performance.now();
  if (now - _lastQuotaCheck < QUOTA_CHECK_INTERVAL_MS) return;
  _lastQuotaCheck = now;

  try {
    // Modern browsers with Storage API
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      
      // Validate quota values before calculation (some browsers return inconsistent values)
      if (!estimate.quota || !estimate.usage || estimate.quota <= 0) {
        console.debug('[Storage] Invalid quota estimate, skipping check');
        return;
      }
      
      const percentUsed = (estimate.usage / estimate.quota) * 100;
      
      // Check for Infinity or invalid calculation
      if (!isFinite(percentUsed)) {
        console.warn('[Storage] Invalid quota calculation (Infinity or NaN)');
        return;
      }

      if (percentUsed >= QUOTA_WARNING_THRESHOLD * 100 && !_quotaWarningShown) {
        _quotaWarningShown = true;
        const usedMB = (estimate.usage / 1024 / 1024).toFixed(1);
        const quotaMB = (estimate.quota / 1024 / 1024).toFixed(1);
        showToast(
          `Storage ${percentUsed.toFixed(0)}% full (${usedMB}MB / ${quotaMB}MB). Consider clearing old presets to avoid save failures.`,
          6000
        );
        console.warn('[Storage] Quota warning:', { percentUsed, usage: estimate.usage, quota: estimate.quota });
      }

      // Reset warning flag if usage drops below threshold (allows re-warning if it fills up again)
      if (percentUsed < (QUOTA_WARNING_THRESHOLD - 0.1) * 100) {
        _quotaWarningShown = false;
      }
    }
  } catch (err) {
    // Storage API not available or failed, silently continue
    console.debug('[Storage] Quota check failed:', err);
  }
}

// Start periodic quota monitoring (will check every 5 minutes during playback)
// First check happens after 30 seconds to avoid startup overhead
setTimeout(() => {
  checkStorageQuota();
  _quotaCheckIntervalId = setInterval(checkStorageQuota, QUOTA_CHECK_INTERVAL_MS);
}, 30000);

// System Audio Help Button
// ========================
// Shows helpful instructions for capturing system audio on different platforms

// System audio help button handler
eventHandlers.systemAudioHelp = () => {
  // Detect if we're on macOS
  const isMac = /Mac/i.test(navigator.userAgent || '') || /Mac/i.test(navigator.platform || '');

  // Show platform-specific instructions
  const msg = isMac
    ? 'macOS: Click "Screen (Chrome)" and, when the Chrome picker appears, choose "Entire Screen" then tick "Share audio" to feed the Mac mix.\n\nFallback: Install BlackHole 2ch → in Audio MIDI Setup create a Multi-Output (BlackHole + speakers) → set system output to that device → in the app choose Mic → BlackHole.\n\nIf capture fails, allow Chrome in System Settings → Privacy & Security → Screen Recording.'
    : 'Click System, then select a tab/window with audio and enable audio sharing. If capture is blocked, allow screen recording permissions for your browser.';

  // Try to show as toast, fall back to alert if toast fails
  try { showToast(msg, 5200); } catch (_) { alert(msg); }
};

document.getElementById('open-system-audio-help')?.addEventListener('click', eventHandlers.systemAudioHelp);
