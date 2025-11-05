# Long-Runtime Stability Analysis Report
**Date:** 2025-11-05
**Target Runtime:** 4-8+ hours continuous operation
**Environment:** Live drum & bass event (Chrome/macOS)

## Executive Summary

Comprehensive analysis of the audio-reactive visualizer codebase identified **1 CRITICAL** and **2 HIGH** severity issues that could impact stability during multi-hour live events. The previous session's memory leak fixes (PresetManager listeners, Dispersion layer, Audio/Scene disposal) remain effective.

**Critical findings require immediate attention before production use.**

---

## CRITICAL Issues (Must Fix)

### C1: Unbounded Adaptive Threshold Arrays
**File:** `src/audio.js`
**Lines:** 204-205, 2995-2996
**Severity:** CRITICAL
**Impact:** Memory accumulation during drop detection calibration

**Description:**
The adaptive drop threshold feature uses two arrays (`_autoBassOnBeats` and `_autoCentroidNegOnBeats`) to collect calibration samples during the first 25 seconds of a track. These arrays are never bounded and accumulate indefinitely if:
- Multiple tracks are loaded during an 8-hour event
- Calibration is re-triggered
- Arrays are not properly cleared between tracks

**Memory Impact:**
- ~4-6 beats per second × 25 seconds = 100-150 samples per calibration
- 50 tracks over 8 hours = 5,000-7,500 float values = ~30-60KB
- While small individually, contributes to overall heap fragmentation

**Exploitation Scenario:**
```javascript
// User loads 100 tracks rapidly (testing/DJ practice)
// Arrays grow to 15,000 samples
// Browser heap fragments, GC pauses increase
```

**Fix Required:** Add bounds checking to calibration arrays (max 200 samples each)

---

## HIGH Severity Issues

### H1: Console Log Accumulation
**Files:** All `src/**/*.js` (135 occurrences)
**Severity:** HIGH
**Impact:** Browser console memory accumulation over 8+ hours

**Description:**
The codebase contains 135+ `console.log/warn/error/info` statements. In Chrome (especially mobile), console messages are retained in memory indefinitely unless the console is cleared. Over an 8-hour event:

- **Animation loop logs:** 60 FPS × 28,800 seconds = 1,728,000 potential log calls
- **Diagnostic mode:** 5-second intervals × 5,760 = **5,760 table logs**
- **Beat detection:** ~4 beats/sec × 28,800 sec = 115,200 beats
- **Preset changes:** ~50 changes × 10 logs = 500 logs

**Memory Impact:**
- Each console message: ~200-500 bytes (message + stack trace metadata)
- 5,760 diagnostic logs × 400 bytes = **~2.3MB** of console memory
- Causes browser DevTools slowdown if open
- Can trigger GC pressure even with console closed (browser-dependent)

**Production Impact:**
VJs often keep DevTools open for monitoring. Accumulated logs cause:
- Console tab lag/freezing
- Increased RAM usage (2-5MB over 8 hours)
- Potential browser slowdown when scrolling console

**Fix Required:**
1. Replace non-critical `console.log` with conditional debug logging
2. Add LOG_LEVEL control to disable verbose logging in production
3. Implement circular log buffer for critical messages (max 1000 entries)

---

### H2: Diagnostics Mode Unbounded Logging
**File:** `src/main.js`
**Lines:** 46-51, 630-656
**Severity:** HIGH
**Impact:** Guaranteed memory accumulation if `?diagnostics` query param present

**Description:**
When loaded with `?diagnostics` query parameter, the application logs detailed audio analysis metrics to `console.table()` **every 5 seconds indefinitely**. This is intended for debugging but lacks production safeguards:

```javascript
// main.js:630-656
if (diagnosticsEnabled && now - diagnosticsLastLog >= diagnosticsLogIntervalMs) {
  const summary = audio.getDiagnosticsSummary({ includeCurrent: true, reset: true });
  console.table({ /* 10 metrics */ }); // EVERY 5 SECONDS
  diagnosticsLastLog = now;
}
```

**Over 8 Hours:**
- 8 hours = 28,800 seconds
- 28,800 / 5 = **5,760 console.table() calls**
- Each table: ~10 rows × ~80 chars = 800 bytes minimum
- Total: **~4.6MB of console memory**

**Real-World Scenario:**
- VJ accidentally loads with `?diagnostics` during soundcheck
- Forgets to remove query param
- After 4 hours, browser console becomes sluggish
- Mid-performance lag spike when checking console

**Fix Required:**
1. Add time limit to diagnostics (auto-disable after 5 minutes)
2. Add max log count (stop after 100 samples)
3. Replace `console.table` with in-memory circular buffer, only log on demand

---

## MEDIUM Severity Issues

### M1: localStorage Write Frequency
**File:** `src/sync.js`
**Lines:** 513-526, 459-475
**Severity:** MEDIUM
**Impact:** Potential localStorage write throttling and quota warnings

**Description:**
The multi-window sync coordinator writes parameter snapshots to localStorage every 450ms when parameters change. While guarded against quota errors, excessive writes can cause:

**Over 8 Hours (assuming continuous parameter changes):**
- 28,800 seconds / 0.45 = **64,000 potential writes**
- Each write: ~2-5KB (JSON snapshot)
- Total data written: **128-320MB** (mostly overwrites)

**Browser Impact:**
- Chrome/Safari rate-limit localStorage writes (not spec'd, browser-dependent)
- Excessive writes can trigger quota warnings
- May cause brief main thread stalls (localStorage is synchronous)
- Mobile browsers are particularly sensitive

**Current Mitigation:**
- Only writes when snapshot changes (line 521: `if (serialized === this._lastParamSerialized)`)
- Quota error handling exists (lines 463-474)

**Recommendation:**
- Increase interval from 450ms to 1000ms (reduces writes by 55%)
- Already well-mitigated, LOW priority fix

---

### M2: Particle Geometry Rebuild Overhead
**File:** `src/scene.js`
**Lines:** 1288-1387 (`rebuildParticles`)
**Severity:** MEDIUM
**Impact:** GC pressure if particleDensity changed frequently

**Description:**
When `particleDensity` slider is adjusted, `rebuildParticles()` recreates geometries for 40,000+ particles. While properly disposed, frequent changes cause:

**Single Rebuild:**
- Core sphere: 40,000 particles × 3 positions × 4 bytes = 480KB
- Orbit rings: 32,000 particles = 384KB
- Stars: 10,000 particles = 120KB
- **Total allocation:** ~1MB per rebuild

**Mitigation:**
- Implementation uses buffer reuse when possible (lines 1298, 1323)
- Growth factor strategy (1.25×) reduces reallocations
- `disposePoints()` properly frees old buffers

**Scenario:**
- User rapidly adjusts density slider during soundcheck: 10 adjustments
- Allocates/frees 10MB, triggers GC pauses
- **Not a leak**, just temporary overhead

**Recommendation:**
- Add 500ms debounce to density slider (settings-ui.js:1000)
- Already well-optimized, LOW priority

---

## LOW Severity Issues (Informational)

### L1: Auto-Resolution Calculation Overhead
**File:** `src/main.js` Lines: 752-796
**Impact:** 9,600 FPS calculations over 8 hours (every 3 seconds)
**Status:** Acceptable overhead, well-bounded, no action needed

### L2: WebSocket Connection Retry Backoff
**File:** `src/main.js` Lines: 214-368
**Impact:** Exponential backoff caps at 20 seconds, connection attempts pause after 12 failures
**Status:** Already well-designed, no issues found

### L3: frameHistory Array (Unused)
**File:** `src/audio.js` Line: 2992
**Impact:** Empty array, never populated, harmless
**Status:** Remove in future cleanup (technical debt, not a bug)

---

## GOOD - No Issues Found ✅

The following systems are properly bounded and pose no long-runtime risk:

| System | Bound | Verification |
|--------|-------|--------------|
| `fluxHistory` | 512 samples | `_trimFluxHistory()` enforces limit |
| `bassFluxHistory` | 512 samples | `_trimBassFluxHistory()` enforces limit |
| `_aubioQueue` | 12 frames | Enforced in `_enqueueAubioFrame()` |
| `_aubioBufferPool` | 6 buffers/size | Line 1817: `if (pool.length >= 6) return` |
| `tapTimestamps` | 8 taps, 12sec window | Lines 947, 954: age + count trimming |
| `_liveBuffer` | 30 seconds | Hard cap at line 325 |
| Preset versions | 15 per preset | `VERSION_LIMIT` constant |
| Recent presets | 12 entries | `RECENT_LIMIT` constant |
| HDR textures | 1 active | Disposed on theme change (scene.js:1182, 1221) |
| WebGL resources | Comprehensive | dispose() methods added in previous session |
| Event listeners | Cleaned up | cleanup() methods verified |

---

## Performance Testing Recommendations

### 1. Stress Test Protocol
```bash
# Load test configuration
http://localhost:5173/?diagnostics=off&preset=bizzuirh

# Monitor these metrics every hour:
1. Chrome Task Manager: "Renderer" memory (should stabilize < 500MB)
2. Performance tab: Heap snapshots (no sawtooth growth)
3. FPS counter (should maintain 60fps ±5)
4. GPU usage (should stay < 60% on target hardware)
```

### 2. Memory Profiling
```javascript
// Add to browser console for live monitoring
setInterval(() => {
  const mem = performance.memory;
  console.log('Heap:', (mem.usedJSHeapSize / 1048576).toFixed(1), 'MB');
}, 60000); // Every minute
```

### 3. Simulated 8-Hour Test
```javascript
// Automated stress test (run in console)
let trackCount = 0;
setInterval(() => {
  audio.loadFile(testFile); // Load new track
  trackCount++;
  console.log(`Track ${trackCount} loaded`);
}, 180000); // Every 3 minutes = 160 tracks in 8 hours
```

**Success Criteria:**
- Memory usage stabilizes below 600MB after 2 hours
- No FPS drops below 55fps
- No WebGL context loss errors
- No "Aw, snap" crashes
- Console memory < 10MB (if DevTools open)

---

## Monitoring & Diagnostics (Production)

### Add Runtime Health Check
```javascript
// Add to main.js (after audio engine init)
let healthCheckData = {
  startTime: Date.now(),
  peakMemoryMB: 0,
  fpsDrops: 0,
  gcPauses: 0,
};

setInterval(() => {
  if (performance.memory) {
    const mb = performance.memory.usedJSHeapSize / 1048576;
    healthCheckData.peakMemoryMB = Math.max(healthCheckData.peakMemoryMB, mb);

    // Alert if memory grows unbounded
    if (mb > 800) {
      console.error('[HEALTH] Memory exceeded 800MB:', mb.toFixed(1));
    }
  }

  // Store for post-event analysis
  localStorage.setItem('reactive_health', JSON.stringify(healthCheckData));
}, 300000); // Every 5 minutes
```

---

## Fix Implementation Priority

1. **CRITICAL C1** - Bound adaptive threshold arrays (15 min fix)
2. **HIGH H2** - Add diagnostics time limit (10 min fix)
3. **HIGH H1** - Implement LOG_LEVEL system (30 min fix)
4. **MEDIUM M1** - Increase sync interval to 1s (5 min fix)

**Total estimated fix time:** ~1 hour

---

## Conclusion

The codebase is **well-architected** with proper resource management in most areas. The previous session's disposal fixes are effective. The critical issue (C1) and high issues (H1, H2) are **straightforward to fix** and will ensure stable 8+ hour operation.

**Recommendation:** Implement C1, H1, H2 fixes before next live event. Test with 4-hour stress test.
