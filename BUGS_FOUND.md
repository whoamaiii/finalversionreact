# Bug Report - Interactive Cosmic Anomaly
**Date**: 2025-11-07
**Analysis Type**: Comprehensive codebase review
**Total Issues**: 19

## Executive Summary

This report identifies 19 bugs and issues across the Interactive Cosmic Anomaly codebase:
- **5 Critical** - Can cause crashes or data loss
- **5 High Priority** - Significant functionality impact
- **5 Medium Priority** - Affects UX but not critical
- **4 Low Priority** - Code quality and minor issues

---

## 🔴 CRITICAL ISSUES

### Issue #1: Unhandled Promise Rejection in Sync Initialization
**File**: `src/sync.js:323`
**Severity**: Critical
**Impact**: Multi-window sync can crash silently without user notification

**Description**:
The `pushNow()` method can throw exceptions (e.g., serialization errors, BroadcastChannel errors) but is called without try-catch in initialization code.

**Code Location**:
```javascript
// Line 323 - No error handling
pushNow(); // Can throw!
```

**Fix Approach**:
```javascript
try {
  pushNow();
} catch (err) {
  console.error('[Sync] Failed to push initial state:', err);
  // Gracefully degrade or notify user
}
```

---

### Issue #2: Null Dereference in Scene Snapshot
**File**: `src/sync.js:85-194`
**Severity**: Critical
**Impact**: Application crashes when syncing state without sceneApi initialized

**Description**:
The `collectSceneSnapshot()` function can return `null` when `sceneApi` is not available, but callers don't validate before accessing properties.

**Code Location**:
```javascript
// Line 85-90
function collectSceneSnapshot() {
  if (!sceneApi) return null; // Returns null!
  // ...
}

// Line 323 - No null check before use
const snapshot = collectSceneSnapshot();
pushData.snapshot = snapshot; // Could be null
```

**Fix Approach**:
```javascript
const snapshot = collectSceneSnapshot();
if (snapshot) {
  pushData.snapshot = snapshot;
} else {
  console.warn('[Sync] Scene not ready, deferring snapshot');
}
```

---

### Issue #3: Essentia Worker Job ID Race Condition
**File**: `src/audio.js:2077-2173`
**Severity**: Critical
**Impact**: Rapid file analysis causes wrong BPM/analysis results to be shown

**Description**:
The Essentia worker uses incrementing job IDs, but rapid sequential file analyses can cause responses to arrive out of order. The current implementation doesn't validate that the response matches the most recent request.

**Code Location**:
```javascript
// Line 2087
essentiaJobId++;
const jobId = essentiaJobId;

// Line 2099-2108 - No validation of jobId
essentia.onmessage = ({ data }) => {
  if (data.type === 'bpm') {
    // Doesn't check if data.jobId === essentiaJobId
    resolve(data.bpm);
  }
};
```

**Fix Approach**:
```javascript
essentia.onmessage = ({ data }) => {
  if (data.type === 'bpm') {
    if (data.jobId !== essentiaJobId) {
      console.warn('[Essentia] Discarding stale result');
      return; // Discard stale results
    }
    resolve(data.bpm);
  }
};
```

---

### Issue #4: AudioContext Closure Race Condition
**File**: `src/audio.js:3081-3095`
**Severity**: Critical
**Impact**: Multiple AudioContexts created, causing resource exhaustion and audio glitches

**Description**:
The `closeContext()` method nullifies `this.audioContext` immediately but `audioContext.close()` is asynchronous. If `switchToSource()` or `initContext()` is called before closure completes, a new context is created while the old one is still open.

**Code Location**:
```javascript
// Line 3081-3095
async closeContext() {
  if (this.audioContext) {
    const ctx = this.audioContext;
    this.audioContext = null; // Nullified immediately!

    try {
      if (ctx.state !== 'closed') {
        await ctx.close(); // Async operation
      }
    } catch (err) {
      console.warn('[AudioEngine] Error closing context:', err);
    }
  }
}
```

**Fix Approach**:
```javascript
async closeContext() {
  if (this.audioContext) {
    const ctx = this.audioContext;

    try {
      if (ctx.state !== 'closed') {
        await ctx.close(); // Wait for closure
      }
    } catch (err) {
      console.warn('[AudioEngine] Error closing context:', err);
    } finally {
      this.audioContext = null; // Nullify AFTER closure
    }
  }
}
```

---

### Issue #5: BPM Analysis Timeout Discards Valid Results
**File**: `src/audio.js:673-689`
**Severity**: Critical
**Impact**: Valid BPM data discarded when analysis takes longer than timeout

**Description**:
The BPM analysis uses `Promise.race()` with a timeout, but if the timeout wins, the valid result that arrives later is silently discarded.

**Code Location**:
```javascript
// Line 673-689
const result = await Promise.race([
  analysis,
  new Promise((_, rej) =>
    setTimeout(() => rej(new Error('BPM timeout')), 15000)
  )
]);
// If timeout rejects first, valid result is lost
```

**Fix Approach**:
```javascript
let timeoutId;
const timeoutPromise = new Promise((_, rej) => {
  timeoutId = setTimeout(() => rej(new Error('BPM timeout')), 15000);
});

try {
  const result = await Promise.race([analysis, timeoutPromise]);
  clearTimeout(timeoutId);
  return result;
} catch (err) {
  clearTimeout(timeoutId);
  // Still allow the analysis promise to complete in background
  analysis.then(result => {
    console.log('[Audio] Late BPM result:', result);
    // Cache or use it
  }).catch(() => {});
  throw err;
}
```

---

## 🟠 HIGH PRIORITY ISSUES

### Issue #6: BeatDetectorGuess CDN Failure Cached Permanently
**File**: `src/audio.js:47-78`
**Severity**: High
**Impact**: BPM detection permanently disabled after a single CDN network failure

**Description**:
The `BeatDetectorGuess` lazy loader caches the first failure permanently. If the CDN is temporarily unavailable during first load, BPM detection is disabled for the entire session.

**Code Location**:
```javascript
// Line 47-78
let BeatDetectorGuess = null;
let BeatDetectorGuessLoaded = false;
let BeatDetectorGuessAttempted = false;

async function getBeatDetectorGuess() {
  if (BeatDetectorGuessAttempted) {
    return BeatDetectorGuess; // Returns null forever!
  }
  BeatDetectorGuessAttempted = true;
  // ... load attempt
}
```

**Fix Approach**:
```javascript
let BeatDetectorGuessFailCount = 0;
const MAX_RETRIES = 3;

async function getBeatDetectorGuess() {
  if (BeatDetectorGuess) return BeatDetectorGuess;

  if (BeatDetectorGuessFailCount >= MAX_RETRIES) {
    console.warn('[Audio] BeatDetector disabled after max retries');
    return null;
  }

  try {
    // ... load attempt
    BeatDetectorGuess = result;
    return result;
  } catch (err) {
    BeatDetectorGuessFailCount++;
    throw err;
  }
}
```

---

### Issue #7: Large Message Handling Fails Silently
**File**: `src/sync.js:430-476`
**Severity**: High
**Impact**: Projector windows desync without notification when state >5MB

**Description**:
BroadcastChannel has a size limit (~5MB), but the code doesn't catch or report failures when messages exceed this limit.

**Code Location**:
```javascript
// Line 452-454
bc.postMessage(msg); // Can fail silently on large messages
```

**Fix Approach**:
```javascript
try {
  const msgSize = JSON.stringify(msg).length;
  if (msgSize > 5000000) { // 5MB
    console.error('[Sync] Message too large:', msgSize);
    showToast('Sync failed: State too large', 'error');
    return;
  }
  bc.postMessage(msg);
} catch (err) {
  console.error('[Sync] Failed to post message:', err);
  showToast('Sync failed', 'error');
}
```

---

### Issue #8: Event Listener Duplication
**File**: `src/sync.js:268-290`
**Severity**: High
**Impact**: Major memory leak, event handlers fire multiple times

**Description**:
The `_initTransports()` method can be called multiple times (e.g., during reconnection), but doesn't remove old listeners before adding new ones.

**Code Location**:
```javascript
// Line 268-290
_initTransports() {
  // No cleanup of existing listeners
  if (this.bc) {
    this.bc.addEventListener('message', this._onBcMessage);
  }
  window.addEventListener('storage', this._onStorage);
  // ...
}
```

**Fix Approach**:
```javascript
_cleanupTransports() {
  if (this.bc) {
    this.bc.removeEventListener('message', this._onBcMessage);
  }
  window.removeEventListener('storage', this._onStorage);
}

_initTransports() {
  this._cleanupTransports(); // Clean up first
  // ... then add listeners
}
```

---

### Issue #9: Audio Track Cleanup Incomplete
**File**: `src/audio.js:708-717`
**Severity**: High
**Impact**: Memory leak when switching audio sources repeatedly

**Description**:
The code attaches event listeners to `MediaStreamTrack` objects but relies on custom properties (`track._endedListener`) that may not persist, causing listeners to accumulate.

**Code Location**:
```javascript
// Line 708-717
tracks.forEach(track => {
  const onEnded = () => { /* ... */ };
  track._endedListener = onEnded; // Custom property may not persist
  track.addEventListener('ended', onEnded);
});

// Cleanup assumes property still exists
track.removeEventListener('ended', track._endedListener);
```

**Fix Approach**:
```javascript
// Use WeakMap for listener storage
const trackListeners = new WeakMap();

tracks.forEach(track => {
  const onEnded = () => { /* ... */ };
  trackListeners.set(track, onEnded);
  track.addEventListener('ended', onEnded);
});

// Cleanup
tracks.forEach(track => {
  const listener = trackListeners.get(track);
  if (listener) {
    track.removeEventListener('ended', listener);
  }
});
```

---

### Issue #10: OSC Bridge Lacks Error Handling
**File**: `tools/osc-bridge.js:40-113`
**Severity**: High
**Impact**: Bridge crashes on network errors, requires manual restart

**Description**:
The WebSocket server has no error handler, causing the process to crash on network errors and leaving orphaned client references.

**Code Location**:
```javascript
// Line 40-113
wss.on('connection', (ws) => {
  clients.add(ws);
  // No error handler!
});
```

**Fix Approach**:
```javascript
wss.on('connection', (ws) => {
  clients.add(ws);

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err);
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

wss.on('error', (err) => {
  console.error('[WS] Server error:', err);
});
```

---

## 🟡 MEDIUM PRIORITY ISSUES

### Issue #11: Listener Error Spam
**File**: `src/preset-manager.js:762-790`
**Severity**: Medium
**Impact**: Console pollution, potential performance degradation

**Description**:
When a preset listener throws an error, it continues to be called for every subsequent preset change, spamming the console infinitely.

**Code Location**:
```javascript
// Line 780-786
_notifyListeners(eventType, data) {
  (this._listeners[eventType] || []).forEach(fn => {
    try {
      fn(data);
    } catch (err) {
      console.error(`[PresetManager] Listener error:`, err);
      // Listener stays in array, errors continue
    }
  });
}
```

**Fix Approach**:
```javascript
_notifyListeners(eventType, data) {
  const listeners = this._listeners[eventType] || [];
  this._listeners[eventType] = listeners.filter(fn => {
    try {
      fn(data);
      return true; // Keep listener
    } catch (err) {
      console.error(`[PresetManager] Listener error, removing:`, err);
      return false; // Remove failing listener
    }
  });
}
```

---

### Issue #12: Storage Quota Check Returns Infinity
**File**: `src/main.js:1132-1163`
**Severity**: Medium
**Impact**: Inaccurate storage warnings, confusing UX

**Description**:
Some browsers return inconsistent values from the Storage API, causing the quota calculation to result in `Infinity`.

**Code Location**:
```javascript
// Line 1145-1150
if (estimate.quota && estimate.usage) {
  const pct = (estimate.usage / estimate.quota) * 100;
  // Can be Infinity if quota is 0
}
```

**Fix Approach**:
```javascript
if (estimate.quota && estimate.usage && estimate.quota > 0) {
  const pct = (estimate.usage / estimate.quota) * 100;
  if (!isFinite(pct)) {
    console.warn('[Storage] Invalid quota calculation');
    return;
  }
  // ... use pct
}
```

---

### Issue #13: PerformanceController Handler Cleanup Assumptions
**File**: `src/performance-pads.js:460-553`
**Severity**: Medium
**Impact**: Handlers not properly removed, potential memory leak

**Description**:
The cleanup code assumes handler references never change, but handlers can be reassigned during runtime.

**Code Location**:
```javascript
// Line 460-553
cleanup() {
  // Removes handlers by reference, but references may have changed
  element.removeEventListener('click', this._handler);
}
```

**Fix Approach**:
```javascript
// Store bound handlers separately
this._boundHandlers = new Map();

element.addEventListener('click', this._boundHandlers.get(element));

cleanup() {
  this._boundHandlers.forEach((handler, element) => {
    element.removeEventListener('click', handler);
  });
  this._boundHandlers.clear();
}
```

---

### Issue #14: Missing Null Check for BPM
**File**: `src/performance-pads.js:171-279`
**Severity**: Medium
**Impact**: Performance pad timing breaks when BPM is unavailable

**Description**:
The code assumes `_beatMs` is always a positive number, but it can be 0 when BPM detection fails, causing NaN propagation.

**Code Location**:
```javascript
// Line 171-279
const interval = this._beatMs * multiplier; // Can be 0 * multiplier = 0
setTimeout(() => { /* ... */ }, interval); // setTimeout(fn, 0) fires immediately
```

**Fix Approach**:
```javascript
const interval = this._beatMs * multiplier;
if (!interval || interval <= 0) {
  console.warn('[PerfPad] Invalid beat interval, skipping');
  return;
}
setTimeout(() => { /* ... */ }, interval);
```

---

### Issue #15: Settings Validation Missing
**File**: `src/settings-ui.js`
**Severity**: Medium
**Impact**: Invalid values can crash renderer or cause visual glitches

**Description**:
Numeric input fields have no range validation, allowing users to enter values that break the renderer (e.g., negative particle counts, extreme bloom values).

**Code Location**:
```javascript
// Throughout settings-ui.js
input.addEventListener('input', (e) => {
  const value = parseFloat(e.target.value);
  // No validation!
  setNestedProperty(params, path, value);
});
```

**Fix Approach**:
```javascript
input.addEventListener('input', (e) => {
  let value = parseFloat(e.target.value);

  // Apply min/max constraints
  const min = parseFloat(input.getAttribute('min'));
  const max = parseFloat(input.getAttribute('max'));

  if (!isNaN(min)) value = Math.max(min, value);
  if (!isNaN(max)) value = Math.min(max, value);

  if (isNaN(value)) {
    console.warn('[Settings] Invalid input, skipping');
    return;
  }

  setNestedProperty(params, path, value);
});
```

---

## 🟢 LOW PRIORITY ISSUES

### Issue #16: Heartbeat Oscillation
**File**: `src/sync.js:528-540`
**Severity**: Low
**Impact**: Minor UX annoyance with sync status flicker

**Description**:
The heartbeat mechanism marks a connection as dead after a single missed heartbeat, but network latency can cause occasional misses even on healthy connections.

**Code Location**:
```javascript
// Line 528-540
if (Date.now() - lastSeen > HEARTBEAT_INTERVAL * 1.5) {
  // Disconnected after single miss
}
```

**Fix Approach**:
```javascript
const HEARTBEAT_TOLERANCE = HEARTBEAT_INTERVAL * 3; // Allow 2 missed beats
if (Date.now() - lastSeen > HEARTBEAT_TOLERANCE) {
  // More tolerant
}
```

---

### Issue #17: Inefficient Median Calculation
**File**: `src/audio.js:1010-1023`
**Severity**: Low
**Impact**: Negligible performance cost (~1ms per frame)

**Description**:
Median calculation sorts a new array copy every frame even when values rarely change.

**Code Location**:
```javascript
// Line 1010-1023
function calculateMedian(arr) {
  const sorted = [...arr].sort((a, b) => a - b); // Sorts every time
  return sorted[Math.floor(sorted.length / 2)];
}
```

**Fix Approach**:
```javascript
// Use quick-select algorithm for O(n) average case
// Or cache sorted array and only re-sort when values change
```

---

### Issue #18: Inconsistent Logging
**Files**: Multiple
**Severity**: Low
**Impact**: Harder to debug issues in production

**Description**:
Mix of `console.log`, `console.warn`, `console.error` without standardized module prefixes like `[ModuleName]`.

**Fix Approach**:
Establish logging convention:
```javascript
// Good
console.error('[PresetManager] Failed to load preset:', err);

// Bad
console.log('preset load failed'); // No module, wrong level
```

---

### Issue #19: Magic Numbers
**Files**: Multiple
**Severity**: Low
**Impact**: Code maintainability

**Description**:
Unexplained constants scattered throughout codebase (e.g., `5000000` for message size, `0.85` for smoothing factors).

**Fix Approach**:
```javascript
// Replace
if (msgSize > 5000000) { }

// With
const MAX_MESSAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
if (msgSize > MAX_MESSAGE_SIZE_BYTES) { }
```

---

## Recommended Fix Order

1. **Issue #1** - Add try-catch to sync initialization (10 min)
2. **Issue #2** - Add null checks to snapshot collection (15 min)
3. **Issue #4** - Fix AudioContext closure race (20 min)
4. **Issue #6** - Implement retry logic for BeatDetector (30 min)
5. **Issue #8** - Fix event listener duplication (25 min)
6. **Issue #3** - Add job ID validation for Essentia (30 min)
7. **Issue #5** - Improve BPM timeout handling (45 min)
8. **Issue #10** - Add OSC bridge error handlers (15 min)
9. **Issue #7** - Add message size validation (20 min)
10. **Issues #11-19** - Address remaining issues (2-3 hours)

**Total estimated time**: ~6-8 hours for all fixes

---

## Testing Recommendations

After fixing each issue:
1. Reproduce the original bug scenario
2. Verify the fix prevents the issue
3. Check for regressions in related functionality
4. Test edge cases (null inputs, rapid operations, etc.)
5. Monitor console for new errors

For critical issues (#1-5), create automated tests to prevent regressions.
