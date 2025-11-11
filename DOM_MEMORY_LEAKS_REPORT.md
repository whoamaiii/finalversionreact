# DOM Memory Leaks Analysis Report
**Generated:** 2025-11-11
**Scope:** Complete DOM-related memory leak audit

## Executive Summary

This report identifies **7 categories** of DOM-related memory leak patterns across the codebase. Most critical issues have been addressed in recent commits, but several potential issues remain that could cause memory accumulation during long-running sessions.

**Overall Status:** 🟡 MODERATE RISK
- ✅ **Good:** Comprehensive cleanup in most major components
- ⚠️ **Warning:** Several edge cases with incomplete cleanup
- ❌ **Critical:** Recovery modal event listener leak (high priority)

---

## 1. Popup Window References (preset-library-window.js)

### Status: ✅ GOOD - Properly Implemented

**Analysis:**
The preset library popup window has comprehensive cleanup mechanisms:

**Strengths:**
- ✅ Tracked event listeners via `_eventListeners` array
- ✅ `_cleanup()` method removes all listeners before clearing window reference
- ✅ `beforeunload` handler triggers cleanup when window closes
- ✅ Singleton pattern prevents multiple window instances
- ✅ Exception handling for cross-origin/closed window states

**Code Example (lines 72-100):**
```javascript
_cleanup() {
  // Remove all tracked event listeners first
  this._removeAllTrackedListeners();
  
  // Remove beforeunload listener
  if (this.win && this._beforeUnloadHandler) {
    this.win.removeEventListener('beforeunload', this._beforeUnloadHandler);
  }
  
  // Detach manager event listener
  if (typeof this.detach === 'function') {
    this.detach();
  }
  
  // Clear window reference
  this.win = null;
  
  // Clear singleton
  if (openPresetLibraryWindow._instance === this) {
    openPresetLibraryWindow._instance = null;
  }
}
```

**Potential Issue - innerHTML Usage:**
- Lines 156, 262, 289, 368, 388: Multiple `innerHTML` assignments
- **Risk:** Low (used for clearing containers, not creating persistent references)
- **Pattern:** `doc.body.innerHTML = ''` (clears all children)
- **Recommendation:** Current usage is safe as it's only for cleanup/reset

---

## 2. Recovery Modal Event Listeners (recovery-modal.js)

### Status: ❌ CRITICAL - Incomplete Cleanup

**Issue:**
The recovery modal creates multiple event listeners but only removes the `escapeHandler` when closing via Escape key. Button click handlers and overlay click handler are never explicitly removed.

**Problem Areas:**

### A. Escape Key Handler - Partial Cleanup
**Location:** Lines 387-393
```javascript
const escapeHandler = (e) => {
  if (e.key === 'Escape') {
    close(); // Closes modal
    document.removeEventListener('keydown', escapeHandler); // ✅ Good
  }
};
document.addEventListener('keydown', escapeHandler);
```

**Issue:** Handler is only removed when Escape is pressed. If user closes via button click or overlay click, the handler persists.

### B. Button Click Handlers - No Cleanup
**Location:** Lines 299-321
```javascript
restoreBtn.addEventListener('click', () => { handleRestore(); });
startFreshBtn.addEventListener('click', () => { handleStartFresh(); });
viewDetailsBtn.addEventListener('click', () => { /* toggle details */ });
```

**Issue:** Handlers are not tracked or removed. When modal is removed from DOM, these create detached DOM references.

### C. Overlay Click Handler - No Cleanup
**Location:** Lines 379-383
```javascript
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) {
    close(); // Just closes, doesn't remove listener
  }
});
```

**Issue:** Handler remains attached to overlay element after removal.

### D. Close Function - Incomplete
**Location:** Lines 368-375
```javascript
function close() {
  overlay.style.animation = 'fadeOut 200ms ease';
  setTimeout(() => {
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay); // ✅ Removes from DOM
    }
  }, 200);
}
```

**Issue:** Removes element from DOM but doesn't clean up event listeners first.

**Impact:**
- Memory leak: ~5-10 closures per modal open
- Accumulates with repeated crash/recovery cycles
- Each closure captures `overlay`, `modal`, `snapshot`, `context` references

**Recommended Fix:**
```javascript
function close() {
  // Remove all event listeners first
  document.removeEventListener('keydown', escapeHandler);
  // Note: Button listeners will be cleaned when elements are garbage collected
  // after removal from DOM, but explicit cleanup is safer
  
  overlay.style.animation = 'fadeOut 200ms ease';
  setTimeout(() => {
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    // Clear references to help GC
    restoreBtn = null;
    startFreshBtn = null;
    viewDetailsBtn = null;
    overlay = null;
    modal = null;
  }, 200);
}
```

---

## 3. Sync Coordinator - Projector Window Management (sync.js)

### Status: ✅ GOOD - Proper Cleanup

**Analysis:**
The projector window reference is properly cleaned up in the `cleanup()` method.

**Strengths:**
- ✅ Explicit `this.projectorWindow = null` (line 1086)
- ✅ Attempts to close window before cleanup (lines 1031-1034)
- ✅ Health check timer cleared (lines 1080-1083)
- ✅ All message handlers removed (lines 1059-1070)
- ✅ BroadcastChannel properly closed (lines 1073-1077)

**Code Review (lines 1041-1093):**
```javascript
cleanup() {
  // Clear timers
  if (this._helloTimerId) clearTimeout(this._helloTimerId);
  if (this._chunkCleanupTimer) clearTimeout(this._chunkCleanupTimer);
  if (this._projectorHealthCheck) clearInterval(this._projectorHealthCheck);
  
  // Remove event listeners
  window.removeEventListener('message', this._messageHandler);
  window.removeEventListener('storage', this._storageHandler);
  
  // Close BroadcastChannel
  if (this.channel) {
    this.channel.onmessage = null;
    this.channel.close();
  }
  
  // Clear window references ✅
  this.projectorWindow = null;
  this.controlWindow = null;
  
  // Clear callback references
  this._onRecoveryRequest = null;
  this._onRecoveryApply = null;
  this._onProjectorCrash = null;
}
```

**Potential Issue - window.opener references:**
- Lines 337, 442, 444, 760, 762: Multiple `window.opener` checks
- **Risk:** Low (read-only checks, no persistent references stored)
- **Note:** These are defensive checks with try/catch, safe pattern

---

## 4. Settings UI Event Listeners (settings-ui.js)

### Status: ✅ EXCELLENT - Comprehensive Tracking System

**Analysis:**
The settings UI implements a sophisticated event listener tracking system that ensures complete cleanup.

**Strengths:**
- ✅ `trackDomListener()` function tracks all listeners (lines 96-110)
- ✅ `clearTrackedDomListeners()` removes all tracked listeners (lines 112-117)
- ✅ `trackTimeout()` and `clearAllTrackedTimeouts()` for timer management (lines 69-94)
- ✅ `trackCleanup()` for custom cleanup functions (line 119+)
- ✅ `cleanupSettingsUI()` orchestrates complete cleanup (lines 2968-3022)

**Code Review:**

### Listener Tracking (lines 96-117):
```javascript
const _trackedDomListeners = [];

function trackDomListener(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  const dispose = () => {
    try {
      target.removeEventListener(type, handler, options);
    } catch (_) {}
  };
  _trackedDomListeners.push(dispose);
  return dispose;
}

function clearTrackedDomListeners() {
  while (_trackedDomListeners.length) {
    const dispose = _trackedDomListeners.pop();
    try { dispose(); } catch (_) {}
  }
}
```

### Comprehensive Cleanup (lines 2968-3022):
```javascript
export function cleanupSettingsUI() {
  // 1. Remove global handlers
  window.removeEventListener('keydown', _globalKeydownHandler);
  window.removeEventListener('keydown', _shaderHotkeysHandler, true);
  
  // 2. Remove overflow menu listeners
  _activeOverflowListeners.forEach(handler => {
    document.removeEventListener('click', handler, true);
  });
  
  // 3. Run tracked cleanup
  runTrackedCleanup();
  clearTrackedDomListeners();
  clearAllTrackedTimeouts();
  
  // 4. Remove dynamically created DOM elements
  ['shader-hud-overlay', 'shader-pinned-hud', 
   'settings-hotkey-help', 'settings-ui-injected-styles'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });
  
  // 5. Reset initialization flag
  _settingsUIInitialized = false;
}
```

**Pattern Usage:**
- 47 instances of `trackDomListener()` throughout the file
- All dynamic event handlers are tracked
- Macro key handlers (lines 2840-2842) tracked
- Overflow menu handlers tracked separately (lines 2982-2985)

---

## 5. Canvas Element Memory Management (scene.js)

### Status: ✅ GOOD - Custom Disposal Implemented

**Analysis:**
Canvas textures created with `createGlowTexture()` have custom disposal to prevent memory leaks.

**Implementation (lines 190-230):**
```javascript
function createGlowTexture(size = 256) {
  const canvas = document.createElement('canvas');
  // ... canvas setup ...
  const texture = new THREE.CanvasTexture(canvas);
  
  // Store canvas reference for cleanup
  texture.userData._sourceCanvas = canvas;
  
  // Override dispose to clean up canvas
  const originalDispose = texture.dispose.bind(texture);
  texture.dispose = function() {
    if (this.userData._sourceCanvas) {
      const canvas = this.userData._sourceCanvas;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      // Force canvas to release memory
      canvas.width = 0;
      canvas.height = 0;
      delete this.userData._sourceCanvas;
    }
    originalDispose();
  };
  
  return texture;
}
```

**Disposal Pattern (lines 2534-2683):**
The main `dispose()` function properly cleans up all Three.js resources:
- ✅ Geometries disposed (lines 2540-2563)
- ✅ Materials disposed (lines 2541-2607)
- ✅ Textures disposed (lines 2570-2576)
- ✅ Renderer DOM element removed (lines 2658-2660)
- ✅ Canvas context lost (line 2657)

**Renderer Cleanup (lines 2653-2662):**
```javascript
if (state.renderer) {
  state.renderer.dispose();
  state.renderer.forceContextLoss(); // ✅ Critical for WebGL
  if (state.renderer.domElement && state.renderer.domElement.parentNode) {
    state.renderer.domElement.parentNode.removeChild(state.renderer.domElement);
  }
  state.renderer = null;
}
```

---

## 6. Main Application Lifecycle (main.js)

### Status: ✅ EXCELLENT - Comprehensive Cleanup

**Analysis:**
The main application has proper lifecycle management with `beforeunload` handler.

**Event Handler Tracking (lines 889-903):**
```javascript
const eventHandlers = {
  resize: sceneApi.onResize,
  mousemove: sceneApi.onMouseMove,
  focus: null,
  pointerdown: null,
  dragenter: null,
  dragover: null,
  dragleave: null,
  drop: null,
  visibilitychange: null,
  beforeunload: null, // ✅ Tracked for cleanup
  systemAudioHelp: null,
  presetLibraryShortcut: handlePresetLibraryShortcut
};
```

**Cleanup Orchestration (lines 1029-1046):**
```javascript
eventHandlers.beforeunload = () => {
  // Mark session as cleanly closed
  localStorage.setItem(SESSION_ACTIVE_KEY, 'false');
  
  // Save final snapshot
  // ... snapshot logic ...
  
  // Call comprehensive cleanup
  stopAnimation(); // ✅ Delegates to proper cleanup
};
window.addEventListener('beforeunload', eventHandlers.beforeunload);
```

**stopAnimation() Function (lines 1490+):**
Comprehensive cleanup includes:
- ✅ Cancels animation frame (line 1067)
- ✅ Disposes scene API
- ✅ Disposes audio engine
- ✅ Cleans up sync coordinator (lines 1518-1521)
- ✅ Cleans up performance pads (lines 1527-1529)
- ✅ Disposes performance monitor (lines 1548-1563)
- ✅ Removes event listeners (line 1470)

---

## 7. innerHTML Usage Patterns

### Status: ✅ SAFE - No Memory Leaks

**Analysis:**
All `innerHTML` usage is for safe purposes (clearing or setting static content).

**Instances Found:**

1. **recovery-modal.js** (lines 247, 278, 288)
   - Purpose: Setting static text content
   - Risk: None (no event handlers in innerHTML)

2. **performance-pads.js** (line 527)
   - Purpose: Setting HUD content
   - Risk: None (static HTML)

3. **preset-library-window.js** (lines 156, 262, 289, 368, 388)
   - Purpose: Clearing containers (`innerHTML = ''`) or setting static text
   - Risk: None (proper pattern for cleanup)

**Pattern Review:**
- ✅ No user-generated content in innerHTML (XSS safe)
- ✅ No event handlers created via innerHTML
- ✅ Used for clearing containers or static content only
- ✅ All dynamic event handlers use `addEventListener` + tracking

---

## 8. MutationObserver & IntersectionObserver

### Status: ✅ NONE FOUND

**Search Results:** No instances of `MutationObserver` or `IntersectionObserver` in the codebase.

---

## 9. Document Fragments & Detached Nodes

### Status: ✅ LOW RISK

**Analysis:**
All DOM manipulation uses proper patterns:
- `createElement` + `appendChild` pattern (safe)
- `removeChild` with parent node check (safe)
- No orphaned fragment references found

**Best Practice Example (recovery-modal.js lines 335-374):**
```javascript
document.body.appendChild(overlay); // Attach to DOM

function close() {
  // ... animation ...
  setTimeout(() => {
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay); // ✅ Safe removal
    }
  }, 200);
}
```

---

## Critical Issues Summary

### 🔴 HIGH PRIORITY

1. **Recovery Modal Event Listener Leak**
   - **File:** `src/recovery-modal.js`
   - **Lines:** 299-393
   - **Impact:** Memory leak on every crash recovery cycle
   - **Fix:** Add comprehensive listener cleanup to `close()` function

### 🟡 MEDIUM PRIORITY

None identified - all other patterns are properly implemented.

### 🟢 LOW PRIORITY

1. **innerHTML usage audit**
   - **Files:** Multiple
   - **Recommendation:** Consider migrating to `textContent` where applicable for consistency
   - **Impact:** Minimal (current usage is safe)

---

## Recommendations

### Immediate Actions

1. **Fix recovery modal cleanup** (lines 368-375 in recovery-modal.js)
   ```javascript
   function close() {
     // Remove event listeners BEFORE removing from DOM
     document.removeEventListener('keydown', escapeHandler);
     restoreBtn.removeEventListener('click', restoreHandler);
     startFreshBtn.removeEventListener('click', startFreshHandler);
     viewDetailsBtn.removeEventListener('click', viewDetailsHandler);
     overlay.removeEventListener('click', overlayHandler);
     
     overlay.style.animation = 'fadeOut 200ms ease';
     setTimeout(() => {
       if (overlay.parentNode) {
         overlay.parentNode.removeChild(overlay);
       }
     }, 200);
   }
   ```

2. **Store handler references** (refactor button creation)
   ```javascript
   const restoreHandler = () => handleRestore();
   const startFreshHandler = () => handleStartFresh();
   // ... etc
   
   restoreBtn.addEventListener('click', restoreHandler);
   ```

### Long-term Improvements

1. **Adopt event listener tracking pattern everywhere**
   - Settings UI has excellent pattern with `trackDomListener()`
   - Consider extracting to shared utility module
   - Apply to recovery modal and other one-off components

2. **Add memory leak testing**
   - Current `test-memory-leaks.js` is good foundation
   - Add specific test for recovery modal lifecycle
   - Monitor heap snapshots for detached DOM nodes

3. **Document cleanup requirements**
   - Add JSDoc comments for all components with lifecycle
   - Require `dispose()`/`cleanup()` methods in code reviews
   - Add cleanup checklist to CLAUDE.md

---

## Testing Recommendations

### Manual Testing

1. **Recovery Modal Stress Test**
   ```javascript
   // In browser console
   for (let i = 0; i < 100; i++) {
     showRecoveryModal({ snapshot, context });
     // Close immediately via different methods
     if (i % 3 === 0) document.querySelector('.recovery-modal__btn--primary').click();
     if (i % 3 === 1) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
     if (i % 3 === 2) document.querySelector('.recovery-modal-overlay').click();
   }
   // Check: Performance → Memory → Detached DOM tree size
   ```

2. **Popup Window Lifecycle Test**
   ```javascript
   // Open/close preset library 100 times
   for (let i = 0; i < 100; i++) {
     openPresetLibraryWindow(presetManager);
     await new Promise(r => setTimeout(r, 100));
     window._instance?.close();
     await new Promise(r => setTimeout(r, 100));
   }
   // Check: Should show stable memory, no detached nodes
   ```

### Automated Testing

Add to `test-memory-leaks.js`:

```javascript
async function testRecoveryModalLeaks() {
  console.log('Testing recovery modal for memory leaks...');
  const initialHeap = performance.memory.usedJSHeapSize;
  
  for (let i = 0; i < 50; i++) {
    showRecoveryModal({ snapshot: mockSnapshot, context: mockContext });
    await sleep(50);
    document.querySelector('.recovery-modal__btn--secondary').click();
    await sleep(50);
  }
  
  const finalHeap = performance.memory.usedJSHeapSize;
  const growth = finalHeap - initialHeap;
  console.log(`Recovery modal test: ${(growth / 1024 / 1024).toFixed(2)} MB growth`);
  
  if (growth > 5 * 1024 * 1024) { // 5MB threshold
    console.error('❌ Recovery modal memory leak detected');
  } else {
    console.log('✅ Recovery modal memory stable');
  }
}
```

---

## Conclusion

The codebase demonstrates **excellent awareness** of memory leak prevention with comprehensive cleanup patterns in most areas. The settings UI tracking system is exemplary and could serve as a template for other components.

**Key Strength:** Systematic approach with `trackDomListener`, `cleanup()` methods, and `beforeunload` handlers.

**Main Weakness:** Recovery modal lacks the same rigor, creating a targeted leak in crash recovery scenarios.

**Overall Risk Assessment:** 🟡 MODERATE
- Most code paths are leak-free
- Critical path (normal operation) is clean
- Edge case (recovery modal) needs attention

**Estimated Fix Time:** 2-4 hours for complete recovery modal refactor with tests.
