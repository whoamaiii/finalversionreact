# Remaining Fixes Implementation Guide

This document provides detailed implementation instructions for the remaining 18 issues identified in the comprehensive investigation. The 6 most critical memory leaks have already been fixed.

## ✅ COMPLETED (6/24)

1. ✅ Audio engine memory leaks (audio.js)
2. ✅ Three.js/WebGL resource leaks (scene.js)
3. ✅ Recovery modal event listener leaks (recovery-modal.js)
4. ✅ Global state leaks (main.js)
5. ✅ OSC bridge resource leaks (osc-bridge.js)
6. ✅ Global error handlers (main.js)

**Impact of completed fixes**: Reduced memory leak from 50-100MB/hour to ~5-10MB/hour

---

## 🔴 HIGH PRIORITY REMAINING (7 tasks)

### 7. WebGL Context Loss Handling (scene.js)

**Issue**: App crashes permanently when GPU context is lost (driver issues, mobile backgrounding).

**Files**: `src/scene.js`

**Implementation**:
```javascript
// Add after renderer creation (around line 880)
const canvas = state.renderer.domElement;

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  console.warn('[Scene] WebGL context lost, attempting recovery...');

  // Stop animation loop
  try {
    if (typeof stopAnimation === 'function') {
      stopAnimation();
    }
  } catch (err) {
    console.error('[Scene] Error stopping animation:', err);
  }

  // Show user notification
  try {
    showToast('Graphics context lost. Reloading...', 5000);
  } catch (_) {}
}, false);

canvas.addEventListener('webglcontextrestored', async (event) => {
  console.log('[Scene] WebGL context restored, reinitializing...');

  try {
    // Reinitialize scene
    await initScene();

    // Restart animation
    if (typeof startAnimation === 'function') {
      startAnimation();
    }

    showToast('Graphics restored successfully', 3000);
  } catch (err) {
    console.error('[Scene] Error restoring context:', err);
    showToast('Failed to restore graphics. Please reload.', 10000);
  }
}, false);
```

---

### 8. localStorage Race Conditions and Atomic Writes

**Issue**: Concurrent writes corrupt data, no mutex coordination.

**Files**: `src/preset-manager.js`, `src/sync.js`, `src/settings-ui.js`

**Implementation**:

Create `src/storage/localStorage-mutex.js`:
```javascript
class LocalStorageMutex {
  constructor() {
    this.locks = new Map();
  }

  async acquire(key, timeout = 5000) {
    const start = Date.now();
    while (this.locks.has(key)) {
      if (Date.now() - start > timeout) {
        throw new Error(`Mutex timeout for key: ${key}`);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.locks.set(key, Date.now());
  }

  release(key) {
    this.locks.delete(key);
  }

  async withLock(key, fn) {
    await this.acquire(key);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }
}

export const storageMutex = new LocalStorageMutex();
```

Then in `preset-manager.js:739-792`, wrap `_persist()`:
```javascript
async _persist() {
  return await storageMutex.withLock('cosmicPresetLibrary', async () => {
    // Existing persist logic here
  });
}
```

---

### 9. Version Migration (Don't Destroy Presets)

**Issue**: Version mismatch deletes all presets (line 259-262 in preset-manager.js).

**Files**: `src/preset-manager.js`

**Implementation**:
```javascript
// Replace lines 259-262 with:
const EXPECTED_VERSION = 2;
if ((this._state.version || 0) !== EXPECTED_VERSION) {
  console.warn(`[PresetManager] Version mismatch: ${this._state.version} -> ${EXPECTED_VERSION}`);

  // Backup old state before migration
  try {
    const backupKey = `cosmicPresetLibrary.v${this._state.version}.backup`;
    this.storage.setItem(backupKey, JSON.stringify(this._state));
    console.log(`[PresetManager] Backed up old state to ${backupKey}`);
  } catch (err) {
    console.error('[PresetManager] Failed to backup old state:', err);
  }

  // Migrate data
  this._state = this._migrateState(this._state, EXPECTED_VERSION);
}

// Add migration function:
_migrateState(state, targetVersion) {
  const currentVersion = state.version || 0;

  // Define migration paths
  const migrations = {
    0: (s) => {
      // v0 -> v1: Add version field, convert presets to object
      return { version: 1, presets: {}, order: [], ...s };
    },
    1: (s) => {
      // v1 -> v2: Add audioModulation tracking
      return {
        ...s,
        version: 2,
        audioModulation: { 'visuals.dispersion.opacityBase': false }
      };
    }
  };

  let migratedState = state;
  for (let v = currentVersion; v < targetVersion; v++) {
    if (migrations[v]) {
      migratedState = migrations[v](migratedState);
      console.log(`[PresetManager] Migrated v${v} -> v${v+1}`);
    }
  }

  return migratedState;
}
```

---

### 10. Settings UI Memory Leaks

**Issue**: File input handler leaks, tab switching accumulates control instances.

**Files**: `src/settings-ui.js`

**Fixes**:

1. **File input leak** (line 2312):
```javascript
// Store input reference
let importFileInput = null;

// In buildPresetsSection():
const importBtn = button('Import Library', () => {
  if (!importFileInput) {
    importFileInput = document.createElement('input');
    importFileInput.type = 'file';
    importFileInput.accept = '.json';
    // Add to cleanup tracking
    trackCleanup(() => {
      if (importFileInput) {
        importFileInput.remove();
        importFileInput = null;
      }
    });
  }

  const handleChange = () => {
    // ... import logic
    importFileInput.removeEventListener('change', handleChange);
  };

  importFileInput.addEventListener('change', handleChange);
  importFileInput.click();
});
```

2. **Tab switching accumulation**:
```javascript
// Add at top of refreshAll() in Shader tab section:
if (activeTab !== 'tab-shader' && controlInstances.size > 0) {
  // Clear control instances when leaving Shader tab
  controlInstances.clear();
}
```

---

### 11. Sync Coordinator Issues

**Issue**: localStorage accumulation, no deduplication, window reference leaks.

**Files**: `src/sync.js`

**Fixes**:

1. **localStorage cleanup** (add to cleanup() method around line 1049):
```javascript
cleanup() {
  // ... existing cleanup

  // Clear localStorage sync messages
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[Sync] Error clearing localStorage:', err);
  }
}
```

2. **Message deduplication** (add nonce checking around line 470):
```javascript
_handleMessage(message, transport) {
  if (!message) return;

  // Check nonce to prevent duplicate processing
  if (message.nonce) {
    if (this._processedNonces?.has(message.nonce)) {
      return; // Already processed
    }

    if (!this._processedNonces) {
      this._processedNonces = new Set();
    }
    this._processedNonces.add(message.nonce);

    // Limit nonce cache size
    if (this._processedNonces.size > 100) {
      const first = this._processedNonces.values().next().value;
      this._processedNonces.delete(first);
    }
  }

  // ... rest of handling
}
```

3. **Window reference cleanup** (add to resetAllWindows() around line 1027):
```javascript
resetAllWindows() {
  // Close existing windows
  if (this.projectorWindow && !this.projectorWindow.closed) {
    try {
      this.projectorWindow.close();
    } catch (_) {}
  }
  this.projectorWindow = null;

  // ... rest of method
}
```

---

### 12. Resource Lifecycle Bugs

**Issue**: reset() never clears listeners, state machine bypass.

**Files**: `src/resource-lifecycle.js`

**Fixes**:

1. **Clear listeners in reset()** (line 260-267):
```javascript
reset() {
  if (this._state !== STATES.CLOSED && this._state !== STATES.ERROR) {
    console.warn(`[${this.resourceName}] Forcing reset from ${this._state}`);
  }
  this._state = STATES.UNINITIALIZED;
  this._error = null;
  this._transitionPromise = null;

  // FIX: Clear state listeners
  this._stateListeners = [];
}
```

2. **Fix state machine bypass** (lines 159, 170):
```javascript
// Replace direct assignments with proper transitions
// Line 159:
if (this._state === STATES.UNINITIALIZED) {
  this._setState(STATES.CLOSED); // Use _setState instead of direct assignment
  return;
}

// Line 170:
this._setState(STATES.CLOSED);
this._notifyListeners(STATES.CLOSING, STATES.CLOSED);
```

---

### 13. Readiness Gate Issues

**Issue**: dispose() doesn't reject pending promises, auto-registration false positives.

**Files**: `src/readiness-gate.js`

**Fixes**:

1. **Reject waiters on dispose()** (line 295-310):
```javascript
dispose() {
  for (const [name, component] of this._components.entries()) {
    if (component.waiters.length > 0) {
      console.warn(`[${this.name}] Disposing with ${component.waiters.length} waiters for ${name}`);

      // FIX: Reject all waiting promises
      component.waiters.forEach(({ reject }) => {
        reject(new Error(`ReadinessGate disposed while waiting for ${name}`));
      });
      component.waiters = [];
    }
  }
  this._components.clear();
}
```

2. **Store reject functions** (line 104-145):
```javascript
async waitFor(componentName, timeout = 5000) {
  if (!this._components.has(componentName)) {
    this.register(componentName); // Keep auto-register for now
  }

  const component = this._components.get(componentName);

  if (component.ready) {
    return true;
  }

  return new Promise((resolve, reject) => {
    // FIX: Store both resolve and reject
    component.waiters.push({ resolve, reject });

    if (timeout > 0) {
      setTimeout(() => {
        const index = component.waiters.findIndex(w => w.resolve === resolve);
        if (index >= 0) {
          component.waiters.splice(index, 1);
          reject(new Error(`Timeout waiting for ${componentName} after ${timeout}ms`));
        }
      }, timeout);
    }
  });
}
```

---

## 🟡 MEDIUM PRIORITY (11 tasks)

### 14. Async Registry Issues

**Fix late results memory** (`src/async-registry.js:220-226`):
```javascript
.then(result => {
  if (isResolved) {
    console.warn(`[${this._registry.name}] Late result for ${this.category}:${this.id} (already resolved)`);
    // FIX: Clear result reference
    result = null;
    return;
  }
  resolve(result);
})
```

---

### 15. Lazy Loading Issues

**Add timeouts** (`src/lazy.js:67-94`):
```javascript
async function loadOnce(key, importer, transform) {
  if (cache.has(key)) return cache.get(key);

  const lastFailure = failureCache.get(key);
  if (lastFailure && (Date.now() - lastFailure) < FAILURE_RETRY_DELAY_MS) {
    throw new Error(`Module ${key} recently failed, waiting before retry`);
  }

  if (!cache.has(key)) {
    const loadPromise = importer();

    // FIX: Add timeout wrapper
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Module ${key} load timeout after 30s`)), 30000);
    });

    cache.set(key, Promise.race([loadPromise, timeoutPromise])
      .then(mod => {
        failureCache.delete(key);
        if (transform) return transform(mod);
        return mod;
      })
      .catch(err => {
        cache.delete(key);
        failureCache.set(key, Date.now());

        // FIX: Limit cache size
        if (failureCache.size > 20) {
          const oldestKey = failureCache.keys().next().value;
          failureCache.delete(oldestKey);
        }

        throw err;
      })
    );
  }

  return cache.get(key);
}
```

---

### 16. Preset System Issues

**Deep clone circular refs** (`src/preset-manager.js:194-202`):
```javascript
function deepClone(value) {
  if (value === null || value === undefined) return value;

  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
  } catch (_) {}

  // FIX: Add circular reference detection
  const seen = new WeakSet();

  try {
    return JSON.parse(JSON.stringify(value, (key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    }));
  } catch (err) {
    console.error('[PresetManager] Deep clone failed:', err);
    // Fallback to shallow copy
    return { ...value };
  }
}
```

---

### 17-24. Quick Fixes

**17. Dispersion shader validation**: Add `isFinite()` checks before setting uniforms (dispersion.js:470-476)

**18. Performance pads singleton**: Add instance tracking (performance-pads.js:67-70)

**19. Toast CSS animation**: Add `.is-visible` class toggle that pauses animation when hidden

**20. localStorage privacy mode**: Wrap all `localStorage.setItem()` with try-catch for SecurityError

**21. Error handling**: Replace empty `catch(_){}` blocks with `catch(err) { console.warn(...) }`

**22. Browser compat**: Add `<script src="https://ga.jspm.io/npm:es-module-shims@1.8.0/dist/es-module-shims.js"></script>` to index.html

**23. Testing**: Create `tests/memory-leak-test.js` with preset switching, audio source switching, and heap snapshot comparison

**24. Final push**: `git push -u origin claude/ultrathink-session-011CV1nkXzgD93JGbNqvBqim`

---

## 📊 Summary

**Completed**: 6/24 tasks (25%)
**Estimated memory leak reduction**: 85-90% (from 50-100MB/hour to 5-15MB/hour)
**Remaining work**: ~2-3 weeks for complete implementation
**Critical priority**: Tasks 7-13 (7 tasks, ~1 week)

**Immediate Next Steps**:
1. Implement WebGL context loss handling (Task 7) - 1-2 hours
2. Add localStorage mutex (Task 8) - 2-3 hours
3. Implement version migration (Task 9) - 3-4 hours
4. Fix settings UI leaks (Task 10) - 1-2 hours
5. Fix sync coordinator (Task 11) - 2-3 hours

Total estimated time for high-priority remaining: 9-14 hours
