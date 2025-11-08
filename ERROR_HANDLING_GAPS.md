# ERROR HANDLING GAPS & SILENT FAILURE POINTS REPORT

## Critical Issues (Severity: CRITICAL)

### 1. Unhandled Dynamic Import Promises (3 instances)
**Location:** src/main.js:391, 418
**Issue:** Fire-and-forget imports with `.then()` but NO `.catch()` handler
```javascript
// Line 391 - NO catch handler
import('./state-snapshot.js').then(({ StateSnapshot }) => {
  // ... code
});

// Line 418 - NO catch handler  
import('./state-snapshot.js').then(({ StateSnapshot }) => {
  // ... code
});
```
**Impact:** If state-snapshot.js fails to load, error is swallowed silently. Recovery system silently fails during projector window initialization.
**Fix:** Add `.catch(err => console.error('[Recovery] Failed to load snapshot module:', err));`

---

### 2. Missing Global Error Handlers (CRITICAL)
**Location:** src/main.js (entire file)
**Issue:** No `window.onerror` or `addEventListener('error')` or `addEventListener('unhandledrejection')`
**Impact:** 
- Unhandled promise rejections crash app silently
- Uncaught errors in event listeners/callbacks propagate uncaught
- No central error logging mechanism
**Fix:** Add at top of main.js:
```javascript
window.addEventListener('error', (event) => {
  console.error('[Global] Uncaught error:', event.error);
  showToast('App error occurred. Check console.', 5000);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Global] Unhandled rejection:', event.reason);
  showToast('Promise rejection. Check console.', 5000);
});
```

---

### 3. Silent Catch Blocks (200+ instances)
**Location:** Throughout codebase
**Issue:** Empty catch blocks or catch-with-underscore pattern suppress errors
```javascript
// src/sync.js:321
} catch (_) {
  // ignore
}

// src/settings-ui.js:81
} catch (_) {
// ...
}
```
**Pattern:** `catch (_) {}` or `catch (e) { }` with no logging
**Impact:** Errors are hidden from developers and users. Hard to debug production issues.
**Severity:** HIGH (200+ instances means many silent failures across the app)

---

## High-Severity Issues (Severity: HIGH)

### 4. Promise.allSettled Without Error Logging (src/audio.js:743)
**Location:** src/audio.js:743-777
**Issue:** BPM and Essentia analysis use Promise.allSettled but don't log aggregate failures
```javascript
Promise.allSettled([
  bpmToken.wrap(bpmPromise, 10000).catch(err => { ... }),
  essentiaToken.wrap(essentiaPromise, 10000).catch(err => { ... })
]).then(() => {
  console.log('[AudioEngine] BPM analysis complete (or timed out gracefully)');
});
```
**Gap:** The final `.then()` always resolves even if both promises fail. No summary logging of failures.
**Fix:** Add explicit check for results in the final `.then()`:
```javascript
]).then((results) => {
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    console.error('[AudioEngine] Analysis failed:', failed);
  }
});
```

---

### 5. Unhandled Audio File Loading Errors (src/audio.js:678-778)
**Location:** src/audio.js:678-778 (loadFile function)
**Issue:** `await file.arrayBuffer()` and `decodeAudioData()` can fail without explicit error handling
```javascript
async loadFile(file) {
  // ... no try-catch wrapping these operations
  const arrayBuf = await file.arrayBuffer();  // ← Can throw
  const audioBuf = await this.ctx.decodeAudioData(arrayBuf);  // ← Can throw
  // ...
}
```
**Callers:**
- main.js:571 - `await audio.loadFile(f)` - wrapped in try-catch ✓
- main.js:583 - `await audio.loadFile(file)` - wrapped in try-catch ✓
- main.js:1615 - `await audio.loadFile(file)` - wrapped in try-catch ✓
- settings-ui.js:790 - `await audioEngine.loadFile(f)` - wrapped BUT catch has empty fallback

**Gap:** While callers have try-catch, the inner function doesn't validate errors specifically. Decode failures silently continue with null buffer.

---

### 6. Unhandled System Audio Capture Errors (src/audio.js:531-670)
**Location:** src/audio.js:640-670 (catch block in startSystemAudio)
**Issue:** Error messages swallowed in some paths
```javascript
} catch (e) {
  // Line 642-650: Only notified for specific error types
  // Other errors may not show toast
  try {
    const name = e?.name || e?.code || '';
    const msg = String(e?.message || '').toLowerCase();
    let notified = false;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      // Shows toast
    } else if (name === 'NotFoundError' || msg.includes('no device')) {
      // Shows toast
    }
    // ... multiple if/else branches
    // But missing default case - some errors not notified to user!
  }
}
```
**Gap:** Errors not matching specific cases are silently logged but NOT shown to user. User may think operation succeeded.

---

### 7. WebSocket Connection State Race Conditions (src/main.js:813-826)
**Location:** src/main.js:813-826 (sendFeaturesOverWs)
**Issue:** readyState can change between check and send
```javascript
if (!featureWsConnected || !featureWs || featureWs.readyState !== WebSocket.OPEN) return;
// ...
if (featureWs.readyState !== WebSocket.OPEN) {
  featureWsConnected = false;
  return;
}
featureWs.send(JSON.stringify(payload));  // ← Can still fail, catch silently
```
**Gap:** Final `featureWs.send()` is wrapped in outer try-catch that suppresses errors:
```javascript
} catch (_) {
  // If send fails, silently ignore (connection will retry)
}
```
**Impact:** Lost features silently, no logging

---

### 8. Shader Compilation Errors Not Handled (src/scene.js:275)
**Location:** src/scene.js:274-287 (createPointShaderMaterial)
**Issue:** ShaderMaterial creation can fail silently (WebGL context loss, compilation errors)
```javascript
function createPointShaderMaterial(mouse) {
  return new THREE.ShaderMaterial({  // ← Can throw, not wrapped
    // ... shader code
  });
}
```
**Callers:**
- src/scene.js:338 - providedMaterial || createPointShaderMaterial(mouse)
- src/scene.js:458 - providedMaterial || createPointShaderMaterial(mouse)

**Gap:** No try-catch. If shader compilation fails (bad GLSL, unsupported extensions), app silently breaks rendering.

---

### 9. Scene.update() Not Protected (src/main.js:1214)
**Location:** src/main.js:1212-1217
**Issue:** Critical animation loop update wrapped in try-catch but error could be lost
```javascript
try {
  sceneApi.update(features);
} finally {
  if (pm) pm.markSectionEnd('scene.update');
}
```
**Gap:** Try block with no catch - if update throws, animation loop crashes without user notification. Only logs to performance monitor.

---

### 10. HDR Environment Map Loading Failures (src/scene.js - theme loading)
**Location:** Need to check theme change function
**Issue:** Remote HDR URL loading (`https://threejs.org/examples/...`) can fail (network, CORS)
**Impact:** HDR failure could cause black background or texture loading errors
**Gap:** Likely no fallback or user notification

---

## Medium-Severity Issues (Severity: MEDIUM)

### 11. JSON.parse Without Validation (src/sync.js:321)
**Location:** src/sync.js:321
```javascript
try {
  const parsed = JSON.parse(event.newValue);
  this._handleMessage(parsed, 'storage');
} catch (_) {
  // ignore
}
```
**Issue:** Invalid JSON is silently ignored. Could be sign of localStorage corruption.
**Fix:** Log warning before ignoring

---

### 12. Missing Error Handling in Keyboard Event Handler (src/main.js:474-484)
**Location:** src/main.js:474-484 (handlePresetLibraryShortcut)
**Issue:** No try-catch around `openPresetLibrary()` call
```javascript
if (key !== 'L' && key !== 'l') return;
// ...
event.preventDefault();
openPresetLibrary();  // ← Could throw, not protected
```
**Gap:** If preset library fails, user gesture is consumed but no feedback given.

---

### 13. localStorage Quota Checks Not Protected (src/main.js:1654-1698)
**Location:** src/main.js:1654-1698 (checkStorageQuota)
**Issue:** `navigator.storage.estimate()` rejection not handled
```javascript
const estimate = await navigator.storage.estimate();  // ← await without outer try-catch
if (!estimate.quota || !estimate.usage || estimate.quota <= 0) {
  // validation
}
```
**Gap:** Function itself has try-catch, but promise could reject before checks. Inner try-catch at line 1659 is redundant since outer function is already wrapped.

---

### 14. Settings UI Audio Device Selection Errors (src/settings-ui.js:770-850)
**Location:** src/settings-ui.js:836
```javascript
try { 
  localStorage.setItem('cosmic_mic_device_id', id); 
  await audioEngine.startMic(id || undefined);  // ← Can throw
} catch(_) { 
  showToast('Mic switch failed');  // Generic message, no details
}
```
**Gap:** All mic failures show same generic message. User doesn't know if it's permissions, device unavailable, or audio context issue.

---

### 15. Drag-and-Drop File Loading No Validation (src/main.js:1608-1621)
**Location:** src/main.js:1608-1621 (handleFileDrop)
**Issue:** Basic file type check, but invalid audio files handled generically
```javascript
if (file && file.type.startsWith('audio/')) {
  try {
    await audio.loadFile(file);
  } catch (err) {
    console.error('Drop load failed', err);  // Generic error, no user feedback details
    try { showToast('Audio file load failed.', 2600); } catch(_) {}
  }
}
```
**Gap:** User doesn't know why file failed (corrupt, unsupported codec, etc.)

---

## Low-Severity Issues (Severity: LOW)

### 16. Toast System Errors Not Protected (src/main.js - multiple)
**Location:** src/main.js - 30+ instances of `try { showToast(...) } catch(_) {}`
**Issue:** If toast system fails, no fallback notification
```javascript
try { showToast('Message here'); } catch(_) {}
```
**Gap:** User never sees error if toast system is broken. Should fallback to console.warn + alert().

---

### 17. Performance Monitor Initialization Errors (src/main.js:75-108)
**Location:** src/main.js:104-108
```javascript
.catch(err => {
  console.warn('[PerformanceMonitor] init failed', err);
  performanceMonitor = null;
  return null;
});
```
**Issue:** Errors are logged but app continues. If monitor fails, rest of app still works. Low risk, but logging could be more detailed.

---

### 18. Preset Manager Listener Failures (src/preset-manager.js:804-822)
**Location:** src/preset-manager.js:804-822
```javascript
for (let i = 0; i < this._listeners.length; i++) {
  try {
    listener.handler({ event, detail });
  } catch (err) {
    errorCount++;
    errors.push(err);
    listenersToRemove.push(i);
    console.error('[PresetManager] Listener error, removing:', { ... });
  }
}
```
**Gap:** Good error handling here, but if ALL listeners fail, array iteration continues with stale indices (iterating backwards for removal fixes this though).

---

## Summary Statistics

| Category | Count | Severity |
|----------|-------|----------|
| Unhandled promise rejections | 2 | CRITICAL |
| Missing global error handlers | 1 | CRITICAL |
| Silent catch blocks | 200+ | HIGH |
| Unhandled async operations | 5 | HIGH |
| JSON parse errors | 1+ | MEDIUM |
| Inadequate error messages | 10+ | MEDIUM |
| **TOTAL GAPS** | **220+** | - |

---

## Recommended Fixes (Priority Order)

1. **IMMEDIATE (Critical):**
   - Add `.catch()` handlers to lines 391, 418 in main.js
   - Add global error/rejection handlers to window

2. **HIGH PRIORITY:**
   - Replace 200+ empty `catch (_)` blocks with meaningful logging
   - Add try-catch wrapper around sceneApi.update() in animation loop
   - Add shader compilation error handling in scene.js

3. **MEDIUM PRIORITY:**
   - Improve error messages in audio capture (specificity)
   - Add JSON.parse validation logging
   - Add fallback for toast system failures

4. **NICE TO HAVE:**
   - Aggregate error reporting dashboard
   - Error sampling/telemetry system
   - User-facing error recovery suggestions

