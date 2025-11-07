# Bug Fix Implementation Plan

**Created**: 2025-11-07
**Total Bugs**: 14 (3 CRITICAL, 5 HIGH, 4 MEDIUM, 2 LOW)
**Estimated Time**: 8-12 hours
**Approach**: Incremental fixes with testing after each phase

---

## Phase 1: CRITICAL Fixes (Priority: IMMEDIATE)
**Estimated Time**: 3-4 hours
**Goal**: Eliminate production-blocking bugs

### Step 1.1: Fix Bug #1 - Session Recovery Modal Race Condition
**File**: `src/main.js`
**Complexity**: High
**Time**: 60 minutes

#### Implementation Tasks:
1. **Replace global flags with promise-based locking**
   - Remove `recoveryModalRequested` and `recoveryModalShown` flags
   - Add `_modalPromise` variable to track single modal instance
   - Implement atomic check-and-create pattern

2. **Refactor `requestSessionRecoveryModal()` function**
   ```javascript
   // Add at module scope
   let _modalPromise = null;

   async function requestSessionRecoveryModal(snapshot) {
     if (!snapshot) return;

     // Return existing promise if modal already requested
     if (_modalPromise) return _modalPromise;

     // Create new modal promise
     _modalPromise = (async () => {
       try {
         // Wait for dependencies
         await sessionRecoveryGate.whenReady(
           SESSION_RECOVERY_DEPENDENCIES,
           SESSION_RECOVERY_READY_TIMEOUT_MS
         );

         // Double-check after async boundary
         if (document.querySelector('.recovery-modal-overlay')) {
           console.log('[SessionRecovery] Modal already shown');
           return;
         }

         // Show modal
         return showRecoveryModal({
           snapshot,
           context: { sceneApi, audioEngine: audio, presetManager },
           onRestore: (state, context) => {
             restoreCrashedSession(state, context);
           },
           onStartFresh: (_snapshot) => {
             console.log('[SessionRecovery] Starting fresh, snapshot archived');
           },
         });
       } catch (err) {
         console.error('[SessionRecovery] Failed to show modal:', err);
         // Don't reset promise - allow retry after delay
         setTimeout(() => { _modalPromise = null; }, 5000);
         throw err;
       }
     })();

     return _modalPromise;
   }
   ```

3. **Update modal close handler to reset promise**
   - Modify `showRecoveryModal` to return cleanup function
   - Call cleanup in close() method
   - Reset `_modalPromise` after modal closes

4. **Add defensive checks**
   - Check if modal already exists in DOM before creating
   - Add timestamp to modal overlay for debugging
   - Log all state transitions

#### Testing:
- [ ] Rapid page refresh (10 times in 5 seconds) - only 1 modal appears
- [ ] Modal shown with null dependencies - graceful error
- [ ] Close and reopen modal - works correctly
- [ ] Browser DevTools: No duplicate modal elements in DOM

---

### Step 1.2: Fix Bug #2 - AutoSaveCoordinator Memory Leak
**File**: `src/state/autoSaveCoordinator.js`
**Complexity**: Medium
**Time**: 45 minutes

#### Implementation Tasks:
1. **Add beforeunload handler in constructor**
   ```javascript
   constructor(context, options = {}) {
     // ... existing code ...

     // Auto-cleanup on page unload
     this._unloadHandler = () => this.stop();
     if (typeof window !== 'undefined') {
       window.addEventListener('beforeunload', this._unloadHandler);
     }
   }
   ```

2. **Update stop() method to remove unload handler**
   ```javascript
   stop() {
     // Remove unload handler first
     if (this._unloadHandler && typeof window !== 'undefined') {
       window.removeEventListener('beforeunload', this._unloadHandler);
       this._unloadHandler = null;
     }

     // Clear interval
     if (this._saveIntervalId) {
       clearInterval(this._saveIntervalId);
       this._saveIntervalId = null;
     }

     // Save final snapshot before stopping
     this.saveNow('shutdown');

     // Remove activity event listeners
     this._removeEventListeners();

     console.log('[AutoSaveCoordinator] Stopped and cleaned up');
   }
   ```

3. **Add disposal method**
   ```javascript
   dispose() {
     this.stop();

     // Clear all references
     this.context = null;
     this.persistence = null;
     this.history = null;
     this._eventSource = null;
     this._lastErrorLogTime.clear();
   }
   ```

4. **Update main.js to call cleanup**
   ```javascript
   // In main.js, add global cleanup handler
   window.addEventListener('beforeunload', () => {
     try {
       autoSaveCoordinator?.stop();
       sync?.cleanup();
       performanceMonitor?.dispose();
     } catch (err) {
       console.error('[Cleanup] Error during shutdown:', err);
     }
   });
   ```

#### Testing:
- [ ] Start session, navigate away - listeners removed
- [ ] DevTools Memory profiler: No detached listeners after 1 hour
- [ ] Call stop() twice - no errors
- [ ] Page reload - clean shutdown logged

---

### Step 1.3: Fix Bug #3 - GPU Query Timeout Memory Leak
**File**: `src/performance-monitor.js`
**Complexity**: High
**Time**: 90 minutes

#### Implementation Tasks:
1. **Refactor `_releaseGpuQuery()` to forcibly delete timed-out queries**
   ```javascript
   _releaseGpuQuery(query) {
     if (!query) return;

     const { gl, ext, isWebGL2 } = this._gpu;
     if (!gl || !ext) {
       // Context lost - can't delete, just drop reference
       return;
     }

     // If pool is at capacity, forcibly delete oldest query first
     if (this._gpu.pool.length >= this._gpu.maxQueries) {
       const oldest = this._gpu.pool.shift();
       try {
         if (isWebGL2 && typeof gl.deleteQuery === 'function') {
           gl.deleteQuery(oldest);
         } else if (typeof ext.deleteQueryEXT === 'function') {
           ext.deleteQueryEXT(oldest);
         }
       } catch (err) {
         console.warn('[PerformanceMonitor] Failed to delete oldest query:', err);
       }
     }

     // Add query to pool
     this._gpu.pool.push(query);
   }
   ```

2. **Add timeout tracking to queries**
   ```javascript
   _beginGpuQuery() {
     // ... existing checks ...

     try {
       // ... existing query start code ...
       this._gpu.activeQuery = {
         query,
         startTime: now(),  // Add timestamp
       };
     } catch (err) {
       this._releaseGpuQuery(query);
       this._gpu.activeQuery = null;
       console.warn('[PerformanceMonitor] GPU timer start failed:', err);
     }
   }
   ```

3. **Update `_pollGpuQueries()` to use timestamp**
   ```javascript
   _pollGpuQueries() {
     // ... existing validation ...

     while (pending.length) {
       const entry = pending[0];
       const query = unwrapQuery(entry);
       const enqueuedAt = getTimestamp(entry);

       if (!query) {
         pending.shift();
         continue;
       }

       // Check timeout
       const timedOut = enqueuedAt !== null
         ? (now() - enqueuedAt) > GPU_QUERY_TIMEOUT_MS
         : false;

       const available = getAvailable(query);

       if (!available && !timedOut) {
         break; // Wait for this query
       }

       pending.shift();

       if (timedOut) {
         console.warn('[PerformanceMonitor] GPU query timed out, force releasing');
         this._forceDeleteQuery(query); // New method for timeout case
         continue;
       }

       // ... existing result processing ...
       this._releaseGpuQuery(query);
     }
   }
   ```

4. **Add `_forceDeleteQuery()` method**
   ```javascript
   _forceDeleteQuery(query) {
     if (!query) return;

     const { gl, ext, isWebGL2 } = this._gpu;

     try {
       if (isWebGL2 && typeof gl.deleteQuery === 'function') {
         gl.deleteQuery(query);
       } else if (typeof ext.deleteQueryEXT === 'function') {
         ext.deleteQueryEXT(query);
       }
     } catch (err) {
       // Context might be lost, suppress error but log for debugging
       console.debug('[PerformanceMonitor] Force delete failed (expected if context lost):', err.message);
     }

     // Don't add to pool - this query is toast
   }
   ```

5. **Add query leak detection**
   ```javascript
   // In endFrame()
   endFrame(options = {}) {
     // ... existing code ...

     // Leak detection (only in development)
     if (this._gpu.pending.length > this._gpu.maxQueries * 2) {
       console.error('[PerformanceMonitor] GPU query leak detected:',
         this._gpu.pending.length, 'queries pending');
       // Emergency cleanup
       this._releaseAllGpuQueries();
     }

     // ... rest of method ...
   }
   ```

#### Testing:
- [ ] Chrome about:gpu - GPU memory stable after 1 hour
- [ ] Force GPU timeout (disable GPU in DevTools) - no leak
- [ ] Run for 1000 frames - query pool size stable
- [ ] Check `_gpu.pending.length` - never exceeds maxQueries * 2

---

## Phase 2: HIGH Severity Fixes
**Estimated Time**: 3-4 hours
**Goal**: Prevent data loss and improve stability

### Step 2.1: Fix Bug #4 - localStorage Quota Cascade
**File**: `src/sync.js`
**Time**: 45 minutes

#### Implementation Tasks:
1. **Add fallback transport when localStorage fails**
   ```javascript
   _sendMessage(type, payload = {}, { target = 'any', useStorage = false } = {}) {
     const message = {
       version: 1,
       type,
       payload,
       target,
       senderId: this.id,
       sentAt: Date.now(),
     };

     // Try BroadcastChannel first
     let sentViaBroadcast = false;
     if (this.channel) {
       try {
         this.channel.postMessage(message);
         sentViaBroadcast = true;
       } catch (_) {}
     }

     // Try postMessage to windows
     const directTargets = [];
     if (this.projectorWindow && !this.projectorWindow.closed)
       directTargets.push(this.projectorWindow);
     if (this.controlWindow && !this.controlWindow.closed)
       directTargets.push(this.controlWindow);

     let sentViaPostMessage = false;
     for (const win of directTargets) {
       try {
         win.postMessage(message, '*');
         sentViaPostMessage = true;
       } catch (_) {}
     }

     // Try localStorage only if useStorage is true
     if (useStorage && typeof localStorage !== 'undefined') {
       try {
         const payloadWithNonce = { ...message, nonce: Math.random().toString(36).slice(2) };
         localStorage.setItem(STORAGE_KEY, JSON.stringify(payloadWithNonce));
       } catch (err) {
         if (err.name === 'QuotaExceededError') {
           const isCritical = ['hello', 'requestSnapshot', 'paramsSnapshot'].includes(type);

           if (isCritical) {
             // Show user warning (once)
             if (!this._quotaWarningShown) {
               this._quotaWarningShown = true;
               console.error('[SyncCoordinator] CRITICAL: localStorage full, sync may fail!');

               // Try to show toast
               import('./toast.js')
                 .then(({ showToast }) => {
                   showToast('Storage full! Multi-window sync degraded. Clear space.', 10000);
                 })
                 .catch(() => {});
             }

             // If we didn't send via other transports, this is a failure
             if (!sentViaBroadcast && !sentViaPostMessage) {
               console.error('[SyncCoordinator] FAILED to send critical message:', type);
             }
           }
         }
       }
     }
   }
   ```

2. **Add storage health check**
   ```javascript
   getStatus() {
     return {
       connected: this.connected,
       autoSync: this.autoSync,
       remoteRole: this.remoteRole,
       lastHeartbeatAt: this._lastHeartbeatSeen,
       lastFeaturesAt: this._remoteFeaturesWallAt,
       storageHealthy: !this._quotaWarningShown,  // Add health indicator
       transports: {
         broadcast: !!this.channel,
         postMessage: !!(this.projectorWindow || this.controlWindow),
         localStorage: this._checkStorageAvailable(),
       },
     };
   }

   _checkStorageAvailable() {
     try {
       const testKey = '__sync_storage_test__';
       localStorage.setItem(testKey, '1');
       localStorage.removeItem(testKey);
       return true;
     } catch (_) {
       return false;
     }
   }
   ```

#### Testing:
- [ ] Fill localStorage completely - sync still works via postMessage
- [ ] Close projector window - sync falls back to localStorage
- [ ] Quota exceeded - user sees toast warning
- [ ] Check DevTools Console - clear error messages

---

### Step 2.2: Fix Bug #5 - Circular Reference in deepMerge
**File**: `src/sync.js`
**Time**: 30 minutes

#### Implementation Tasks:
1. **Make circular reference detection throw error**
   ```javascript
   function deepMerge(target, source, seen = new WeakSet()) {
     if (!source || typeof source !== 'object') return target;

     // Detect circular references
     if (seen.has(source)) {
       const error = new Error('deepMerge: Circular reference detected in source object');
       error.code = 'CIRCULAR_REFERENCE';
       console.error('[deepMerge] Circular reference detected:', error);
       throw error;
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
   ```

2. **Add error handling in callers**
   ```javascript
   function applySceneSnapshot(sceneApi, snapshot) {
     if (!sceneApi?.state?.params || !snapshot) return;

     const params = sceneApi.state.params;
     let shouldRebuildParticles = false;

     // ... theme changes ...

     // Wrap risky merges in try-catch
     if (snapshot.outerShell && typeof snapshot.outerShell === 'object') {
       try {
         if (!params.outerShell || typeof params.outerShell !== 'object')
           params.outerShell = {};
         deepMerge(params.outerShell, snapshot.outerShell);
       } catch (err) {
         console.error('[applySceneSnapshot] Failed to merge outerShell:', err);
         // Use shallow copy as fallback
         params.outerShell = { ...snapshot.outerShell };
       }
     }

     // Same for map and explosion
     // ... rest of method ...
   }
   ```

#### Testing:
- [ ] Create preset with circular reference - error thrown
- [ ] Error caught and logged - app continues
- [ ] Visual state partially applied - no crash
- [ ] Console shows clear error message

---

### Step 2.3: Fix Bug #6 - PresetManager Listener Accumulation
**File**: `src/preset-manager.js`
**Time**: 45 minutes

#### Implementation Tasks:
1. **Add listener count monitoring**
   ```javascript
   constructor({ sceneApi, audioEngine, storage = window.localStorage } = {}) {
     // ... existing code ...
     this._listeners = new Set();
     this._maxListeners = 50; // Reasonable threshold
     this._listenerWarningShown = false;
   }
   ```

2. **Update on() method with leak detection**
   ```javascript
   on(event, handler) {
     if (typeof handler !== 'function') return () => {};

     // Check for excessive listeners
     if (this._listeners.size >= this._maxListeners && !this._listenerWarningShown) {
       this._listenerWarningShown = true;
       console.error('[PresetManager] MEMORY LEAK WARNING: Listener count exceeded',
         this._maxListeners, 'listeners. Check for missing cleanup.');

       // Log listener breakdown for debugging
       const eventCounts = {};
       for (const l of this._listeners) {
         eventCounts[l.event] = (eventCounts[l.event] || 0) + 1;
       }
       console.table(eventCounts);
     }

     const wrapped = { event, handler };
     this._listeners.add(wrapped);

     return () => this._listeners.delete(wrapped);
   }
   ```

3. **Add periodic cleanup method**
   ```javascript
   _cleanupDuplicateListeners() {
     // Remove duplicate event+handler pairs (can happen with HMR)
     const seen = new Map();
     const toRemove = [];

     for (const listener of this._listeners) {
       // Create fingerprint of handler (first 100 chars of function body)
       const handlerStr = listener.handler.toString().slice(0, 100);
       const key = `${listener.event}:${handlerStr}`;

       if (seen.has(key)) {
         toRemove.push(listener);
       } else {
         seen.set(key, listener);
       }
     }

     for (const listener of toRemove) {
       this._listeners.delete(listener);
     }

     if (toRemove.length > 0) {
       console.log('[PresetManager] Cleaned up', toRemove.length, 'duplicate listeners');
     }
   }
   ```

4. **Call cleanup in load() method**
   ```javascript
   load(identifier, options = {}) {
     // Periodic cleanup every 10 loads
     if ((++this._loadCount % 10) === 0) {
       this._cleanupDuplicateListeners();
     }

     // ... rest of load method ...
   }
   ```

5. **Update cleanup() method**
   ```javascript
   cleanup() {
     // Clear all event listeners
     this._listeners.clear();
     this._listenerWarningShown = false;

     // ... existing cleanup code ...
   }
   ```

#### Testing:
- [ ] Register 100 listeners - warning shown at 50
- [ ] DevTools Console - table showing event breakdown
- [ ] Load preset 10 times - cleanup runs once
- [ ] Check `_listeners.size` - stays reasonable

---

### Step 2.4: Fix Bug #7 - SnapshotHistory Aggressive Pruning
**File**: `src/state/snapshotHistory.js`
**Time**: 45 minutes

#### Implementation Tasks:
1. **Update PRUNE_RULES with minimum threshold**
   ```javascript
   const PRUNE_RULES = {
     keepAllMinutes: 30,
     keepHourlyHours: 4,
     keepDailyDays: 7,
     minSnapshotsToKeep: 5,  // NEW: Always keep at least N snapshots
   };
   ```

2. **Add safety check in `_prune()`**
   ```javascript
   _prune() {
     const now = Date.now();
     const keep = [];
     const toRemove = [];

     // Decompress all snapshots for analysis
     const snapshots = this._snapshots.map(item => {
       try {
         return {
           ...item,
           snapshot: StateSnapshot.decompress(item.compressed),
         };
       } catch (_) {
         return null;
       }
     }).filter(Boolean);

     // If we don't have many snapshots, don't prune
     if (snapshots.length <= PRUNE_RULES.minSnapshotsToKeep) {
       console.log('[SnapshotHistory] Too few snapshots to prune, skipping');
       return;
     }

     // ... existing grouping logic ...

     // Calculate total snapshots we'd keep
     const totalToKeep = keep.length +
       Array.from(hourlyByHour.values()).length +
       Array.from(dailyByDay.values()).length;

     // Safety check: Don't prune if we'd drop below minimum
     if (totalToKeep < PRUNE_RULES.minSnapshotsToKeep) {
       console.warn('[SnapshotHistory] Pruning would reduce snapshots below minimum,',
         'skipping prune. Current:', snapshots.length, 'Would keep:', totalToKeep);
       return;
     }

     // ... rest of pruning logic ...

     console.log('[SnapshotHistory] Pruned', toRemove.length, 'snapshots, kept',
       this._snapshots.length);
   }
   ```

3. **Add logging to prune operations**
   ```javascript
   add(snapshot, options = {}) {
     // ... existing add logic ...

     const beforePrune = this._snapshots.length;

     // Prune according to rules
     this._prune();

     const afterPrune = this._snapshots.length;
     if (beforePrune !== afterPrune) {
       console.log('[SnapshotHistory] Pruned', beforePrune - afterPrune,
         'snapshots. Remaining:', afterPrune);
     }

     // Persist
     this._persist();
   }
   ```

#### Testing:
- [ ] Create 20 snapshots - at least 5 kept after pruning
- [ ] All snapshots in same hour - at least 5 kept
- [ ] Check console logs - clear prune messages
- [ ] Verify bookmarks never pruned

---

### Step 2.5: Fix Bug #8 - Circuit Breaker Lockup
**File**: `src/state/autoSaveCoordinator.js`
**Time**: 45 minutes

#### Implementation Tasks:
1. **Add exponential backoff to circuit breaker**
   ```javascript
   constructor(context, options = {}) {
     // ... existing code ...

     // Circuit breaker with exponential backoff
     this._consecutiveErrors = 0;
     this._circuitBreakerOpen = false;
     this._circuitBreakerOpenTime = 0;
     this._circuitBreakerResetCount = 0;
     this._circuitBreakerMaxResets = 3;
   }
   ```

2. **Update `_performSave()` with better circuit breaker logic**
   ```javascript
   async _performSave(reason, tags = []) {
     if (this._isSaving) return;

     const now = Date.now();

     // Check circuit breaker
     if (this._circuitBreakerOpen) {
       // Calculate backoff time (exponential: 60s, 120s, 240s)
       const backoffMs = CIRCUIT_BREAKER_RESET_MS * Math.pow(2, this._circuitBreakerResetCount);
       const timeOpen = now - this._circuitBreakerOpenTime;

       if (timeOpen > backoffMs) {
         // Check if we've reset too many times
         if (this._circuitBreakerResetCount >= this._circuitBreakerMaxResets) {
           console.error('[AutoSaveCoordinator] Circuit breaker permanently open after',
             this._circuitBreakerResetCount, 'resets. Auto-save disabled.');

           // Show user notification (once)
           if (!this._permanentFailureShown) {
             this._permanentFailureShown = true;
             try {
               const { showToast } = await import('./toast.js');
               showToast('Auto-save permanently disabled due to repeated failures. Check storage.', 10000);
             } catch (_) {}
           }
           return;
         }

         // Attempt reset
         this._circuitBreakerOpen = false;
         this._circuitBreakerResetCount++;
         this._throttledLog('info',
           `[AutoSaveCoordinator] Circuit breaker reset attempt ${this._circuitBreakerResetCount}/${this._circuitBreakerMaxResets}`,
           `Next backoff: ${backoffMs / 1000}s`);
       } else {
         // Still in backoff period
         return;
       }
     }

     // ... existing idle and saving checks ...

     try {
       const startTime = performance.now();

       // Capture snapshot
       const snapshot = StateSnapshot.capture(this.context, tags);
       const compressed = snapshot.compress();
       const success = this.persistence.save(compressed);

       if (success) {
         // SUCCESS: Reset all error tracking
         this._consecutiveErrors = 0;
         this._circuitBreakerResetCount = 0;  // Reset the reset counter
         this._lastSaveTime = now;
         this._saveCount++;

         // ... existing history logic ...
       } else {
         this._handleSaveError('Save returned false', null);
       }
     } catch (err) {
       this._handleSaveError('Save exception', err);
     } finally {
       this._isSaving = false;
     }
   }
   ```

3. **Update stats to include circuit breaker state**
   ```javascript
   getStats() {
     return {
       saveCount: this._saveCount,
       saveErrors: this._saveErrors,
       consecutiveErrors: this._consecutiveErrors,
       circuitBreakerOpen: this._circuitBreakerOpen,
       circuitBreakerResetCount: this._circuitBreakerResetCount,
       circuitBreakerBackoffMs: this._circuitBreakerOpen
         ? CIRCUIT_BREAKER_RESET_MS * Math.pow(2, this._circuitBreakerResetCount)
         : 0,
       isIdle: this._isIdle,
       lastSaveTime: this._lastSaveTime,
       lastActivityTime: this._lastActivityTime,
       storageSize: this.persistence.getStorageSize(),
       historyStats: this.history.getStats(),
     };
   }
   ```

#### Testing:
- [ ] Cause 5 consecutive errors - circuit opens
- [ ] Wait 60s - circuit attempts reset
- [ ] Error again - circuit reopens with 120s backoff
- [ ] Check stats - backoff time increases exponentially
- [ ] After 3 resets - permanent failure message shown

---

## Phase 3: MEDIUM Severity Fixes
**Estimated Time**: 2-3 hours

### Step 3.1: Fix Bug #9 - RecoveryModal Click-Outside
**File**: `src/recovery-modal.js`
**Time**: 15 minutes

```javascript
// Replace click-outside handler
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) {
    // Just close without action - let user decide explicitly
    close();
  }
});
```

### Step 3.2: Fix Bug #10 - SyncCoordinator Missing Cleanup
**File**: `src/main.js`
**Time**: 15 minutes

```javascript
// Add global cleanup handler
window.addEventListener('beforeunload', () => {
  try {
    sync?.cleanup();
    autoSaveCoordinator?.stop();
    performanceMonitor?.dispose();
    presetManager?.cleanup();
  } catch (err) {
    console.error('[Cleanup] Error during shutdown:', err);
  }
});
```

### Step 3.3: Fix Bug #11 - Noise Gate Calibration Race
**File**: `src/audio.js`
**Time**: 30 minutes

Use `AsyncOperationRegistry`:
```javascript
async calibrateNoiseGate() {
  const token = this._asyncRegistry.register('noise-gate-calibration', {
    timeout: 5000
  });

  return token.wrap(this._doNoiseGateCalibration(), 5000);
}

async _doNoiseGateCalibration() {
  // Move existing calibration logic here
}
```

### Step 3.4: Fix Bug #12 - PerformanceMonitor Lifecycle
**File**: `src/performance-monitor.js`
**Time**: 60 minutes

Add `ResourceLifecycle` pattern (detailed implementation in code).

---

## Phase 4: LOW Severity Fixes
**Estimated Time**: 1 hour

### Step 4.1: Fix Bug #13 - StateSnapshot Null Checks
**File**: `src/state-snapshot.js`
**Time**: 30 minutes

Add defensive null checks in `_captureAudioSource()`.

### Step 4.2: Fix Bug #14 - Throttled Logging
**File**: `src/state/autoSaveCoordinator.js`
**Time**: 30 minutes

Improve `_throttledLog()` key generation and add throttle indicator.

---

## Phase 5: Testing & Verification
**Estimated Time**: 2-3 hours

### Step 5.1: Unit Tests
- [ ] Write tests for each fix
- [ ] Mock localStorage quota errors
- [ ] Test race conditions with concurrent calls
- [ ] Verify memory leaks with heap snapshots

### Step 5.2: Integration Tests
- [ ] Start session, run for 1 hour, check metrics
- [ ] Multi-window sync with full storage
- [ ] Rapid preset switching
- [ ] Fill storage, verify graceful degradation

### Step 5.3: Manual Verification
- [ ] Load app in Chrome DevTools
- [ ] Memory profiler: Check for detached listeners
- [ ] Performance tab: No long tasks from cleanup
- [ ] Console: No error storms

---

## Commit Strategy

### Atomic Commits (One per Phase):
1. `fix: CRITICAL - Session recovery modal race condition and memory leaks`
2. `fix: HIGH - Storage quota cascade, circular refs, listener accumulation`
3. `fix: MEDIUM - Modal UX, cleanup handlers, calibration races`
4. `fix: LOW - Null checks and logging improvements`
5. `test: Add comprehensive tests for all bug fixes`

---

## Rollback Plan

If any fix causes regressions:
1. Revert specific commit
2. Re-run tests
3. Re-implement with additional safeguards

---

## Success Criteria

- [ ] All 14 bugs fixed and verified
- [ ] No new bugs introduced
- [ ] Memory profiler shows clean heap after 1 hour
- [ ] Multi-window sync works with full storage
- [ ] GPU memory stable under stress
- [ ] Console logs clean and informative
- [ ] All tests passing

**Estimated Total Time**: 8-12 hours
**Priority**: Start with Phase 1 immediately
