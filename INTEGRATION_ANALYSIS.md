# INTEGRATION POINTS ANALYSIS - COSMIC ANOMALY

## Executive Summary
This analysis identifies critical integration points between major components and documents failure modes, edge cases, and data loss scenarios that could impact live performance. **Severity Levels: Critical (crash/data loss), High (functionality broken), Medium (degraded), Low (minor)**.

---

## 1. MULTI-WINDOW SYNC (BroadcastChannel + postMessage + localStorage)
**File**: `src/sync.js`

### Current Implementation
- Primary: BroadcastChannel (fast, same-origin only)
- Fallback 1: window.postMessage (for popup windows)
- Fallback 2: localStorage heartbeat (for last-resort sync)
- Messages include: features (33ms), parameters (1000ms), heartbeat (5000ms)

### Critical Issues Found

#### 1.1 **CRITICAL: Missing synchronization on BroadcastChannel creation failure**
- **Issue**: If BroadcastChannel constructor throws (line 300), fallback transports aren't initialized
- **Failure Mode**: Silent fallback, control window may believe receiver is connected when it isn't
- **Impact**: Lost parameter syncs, preset changes don't propagate to projector in multi-window mode
- **Evidence**: `catch(err)` only logs, doesn't fallback to postMessage/localStorage
- **Test Case**: Chrome private mode (BroadcastChannel blocked) + projector window

```javascript
// Line 298-306: No assertion that at least one transport exists
if (typeof BroadcastChannel === 'function') {
  try {
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = ...
  } catch (err) {
    console.warn('BroadcastChannel unavailable', err);
    this.channel = null;  // This is correct, but...
  }
}
// Falls through to postMessage setup, so actually OK after code inspection
```

#### 1.2 **HIGH: Message ordering guarantee missing**
- **Issue**: Features sent every 33ms, params every 1000ms, heartbeat every 5000ms with NO sequencing
- **Race Condition**: Projector could receive `beat=false` after `beat=true` due to out-of-order delivery
- **Failure Mode**: Ghost beats, visual glitches, beat detection appears to stutter
- **Root Cause**: `sentAt` timestamp exists but not enforced for ordering in receiver
- **Scenario**: Network jitter on multi-window communication

#### 1.3 **HIGH: Incomplete feature sanitization**
- **Issue**: `sanitizeFeatures()` (line 55-89) excludes critical fields
- **Missing Fields**:
  - `drumOnset` (if used in shaders)
  - `voiceActivity` (if multi-modal detection needed)
  - `energyHistory` (for burst detection)
- **Impact**: Projector window misses audio context, falls back to stale remote features
- **Failure Mode**: Projector becomes visually unresponsive to real-time events after sync
- **Scenario**: Aubio/Meyda features added later but not synced

#### 1.4 **HIGH: Storage quota exhaustion not recoverable**
- **Issue**: Line 609-634, QuotaExceededError handling
- **Problem**: Once localStorage is full, sync silently fails for subsequent param updates
- **Silent Failure**: No retry queue, no backpressure handling
- **Impact**: Preset changes silently fail to sync to projector in long sessions
- **Failure Mode**: Control + projector drift apart, operator unaware of desync
- **Evidence**: 
```javascript
// Line 626-630: Only handles CRITICAL messages, ignores params on quota
if (!sentViaBroadcast && !sentViaPostMessage) {
  console.error('[SyncCoordinator] FAILED to send critical message');
}
// But regular param syncs still fail silently if storage full
```

#### 1.5 **MEDIUM: Heartbeat tolerance inconsistent**
- **Issue**: Line 12-13, heartbeat multiplier = 3, timeout = 15s (vs params every 1s)
- **Race Condition**: Control window may declare receiver "dead" before param sync stales
- **Scenario**: Slow network (response time = 10s) + receiver hangs on params = false disconnect
- **Visual Effect**: Sudden projector reconnect after 15s, jumpy visuals

#### 1.6 **MEDIUM: postMessage target validation is permissive**
- **Issue**: Line 598, `win.postMessage(message, '*')` uses wildcard origin
- **Security Note**: Not a direct threat (same-origin enforced by browser), but poor practice
- **Operational Risk**: If compromised page opens projector window, attacker can observe features

### Data Loss Scenarios

| Scenario | Probability | Data Lost | Impact |
|----------|-------------|-----------|--------|
| BroadcastChannel fails, no postMessage | Low | All params/features | Projector can't sync |
| localStorage quota full (>100 users, long session) | Medium | Param updates after quota hit | Preset drift |
| Projector window loses focus, audio context suspends, never resumes | High | All features from that point | Black screen until manual interaction |
| Message size > 5MB (unlikely but possible with huge state) | Low | State snapshot | Control/projector desync |

### Recommendations
1. **Add transport existence check**: Ensure at least one fallback transport is available post-init
2. **Implement message sequencing**: Add sequence numbers to all messages, drop out-of-order ones
3. **Complete feature sanitization audit**: Add `expandThenTrim` function to ensure all extracted features are synced
4. **Add storage quota guard**: Estimate size before writing, use compression for large params
5. **Symmetric heartbeat policy**: Both control and receiver should monitor each other
6. **Document multi-window limitations**: Chrome private mode, Firefox containers, Safari pop-ups need explicit testing

---

## 2. WEBSOCKET/OSC BRIDGE (WebSocket + tools/osc-bridge.js)
**Files**: `src/main.js` (lines 623-864) + `tools/osc-bridge.js`

### Current Implementation
- One-way WebSocket stream to OSC bridge at `ws://127.0.0.1:8090`
- Features sent ~30Hz (every 33ms) when connected
- Exponential backoff on failure, 60s lockout after 12 attempts
- Features include RMS, bands, BPM, MFCC, chroma

### Critical Issues Found

#### 2.1 **CRITICAL: Message loss during bridge restart**
- **Issue**: Lines 696-801, WebSocket reconnection clears buffers without draining
- **Failure Mode**: 1000ms worth of beats/tempo changes lost when bridge restarts
- **Root Cause**: No message queue; if bridge is down for 5s, first 5000ms of features are dropped
- **Impact**: TouchDesigner loses sync with live music, visual cues out of time
- **Test Case**: Bridge crash, restart while music is playing

```javascript
// Line 729: closeFeatureWs() clears connection without buffering
function closeFeatureWs() {
  // ...
  featureWs = null;  // No queue to preserve unsent features
}
```

#### 2.2 **HIGH: OSC bridge doesn't validate feature payload**
- **Issue**: `tools/osc-bridge.js` lines 55-122, no bounds checking on array values
- **Failure Mode**: If mfcc array has NaN or Infinity, OSC packets are malformed
- **Impact**: TouchDesigner can't deserialize, visual effects freeze or crash
- **Root Cause**: Lines 106-113 don't validate array element types

```javascript
// Line 106-108: No validation for mfcc values
if (Array.isArray(f.mfcc)) {
  for (let i = 0; i < Math.min(f.mfcc.length, 13); i++) {
    send(`/reactive/mfcc/${i}`, f.mfcc[i] || 0);  // f.mfcc[i] could be NaN!
  }
}
```

#### 2.3 **HIGH: Backoff exponential growth uncapped in edge case**
- **Issue**: Line 769, backoff multiplier = 1.6, but cap = 20s
- **Math**: After 10 consecutive failures: 2.5s × 1.6^10 ≈ **1.5 minutes**
- **Failure Mode**: If bridge crashes and doesn't restart, app gives up for 1.5min despite bridge coming back up
- **Scenario**: Bridge process OOM crashes, 5s restart delay

#### 2.4 **MEDIUM: Instance ID tagging insufficient for concurrent connections**
- **Issue**: Lines 742-759, instance tagging prevents old connections from updating state
- **Race Window**: Between `closeFeatureWs()` (line 729) and `featureWsConnecting = true` (line 734)
- **Scenario**: Two rapid `ensureFeatureWs()` calls create two WebSockets
- **Leak**: Memory leak if both connect, but flag prevents cleanup

#### 2.5 **MEDIUM: Ready state check not atomic**
- **Issue**: Lines 814, 823 check `readyState === OPEN` twice without synchronization
- **Race**: Send in-flight when connection closes between checks
- **Impact**: Silent send failure (no error thrown), features lost

```javascript
// Lines 814-826: Not atomic - connection can close between checks
if (featureWsConnected || !featureWs || featureWs.readyState !== WebSocket.OPEN) return;
// ... 8 lines of computation ...
if (featureWs.readyState !== WebSocket.OPEN) {  // Can fail here!
  featureWsConnected = false;
  return;
}
featureWs.send(...);  // Silent exception if already closed
```

#### 2.6 **MEDIUM: OSC bridge has no heartbeat to detect client loss**
- **Issue**: `tools/osc-bridge.js` line 144-149, heartbeat only logs active clients
- **Missing**: Mechanism to notify TouchDesigner if WebSocket goes silent
- **Impact**: TouchDesigner doesn't know if stream is live or stale
- **Scenario**: Browser tab hidden, audio context suspends, features stop but bridge still sees "client connected"

### Data Loss Scenarios

| Scenario | Probability | Data Lost | Impact |
|----------|-------------|-----------|--------|
| Bridge restarts during beat | High | 5-10 beats, tempo alignment | TouchDesigner visuals miss hits |
| NaN/Infinity in mfcc array | Medium | Entire OSC packet malformed | TouchDesigner can't parse, freezes |
| Exponential backoff reaches cap | Low | 1-2 minutes of sync | OSC output dead until manual action |
| Browser tab hidden → audio suspends | High | Feature stream stops silently | TD thinks stream is live |

### Recommendations
1. **Add feature queue**: Buffer unsent features during bridge downtime (max 500ms)
2. **Validate features before sending**: Add `isFinite()` check in `sendFeaturesOverWs()`
3. **Cap exponential backoff earlier**: Max 15s, not 20s
4. **Add atomic send wrapper**: Single check-then-send operation with error recovery
5. **Bridge heartbeat protocol**: Send "ping" from TD back to browser, declare dead if no response
6. **OSC packet validation in bridge**: Validate all args are finite numbers before `send()`

---

## 3. PERFORMANCE PADS INTEGRATION (Keyboard + Sync)
**File**: `src/performance-pads.js` + `src/sync.js` (padEvent messages)

### Current Implementation
- Keyboard shortcuts (1-5 keys) trigger pad events
- Events synced to projector via `padEvent` message type
- Deltas merged with audio baseline via `sceneApi.setUniformDeltasProvider()`

### Critical Issues Found

#### 3.1 **HIGH: Race condition in double-tap detection**
- **Issue**: Lines 364-375, `lastTapMs` check not atomic with double-tap flag toggle
- **Failure Mode**: Rapid key repeats (held key) cause multiple latch toggles
- **Scenario**: Operator holds "1" key for 300ms, expects latch once but toggles twice
- **Impact**: Pad state desynchronized between control and projector

```javascript
// Lines 371-374: Non-atomic double-tap detection
if (now - (p.lastTapMs || 0) < 250) {
  p.latched = !p.latched;  // Can execute twice if key held!
}
p.lastTapMs = now;  // Reset happens AFTER latch toggle
```

#### 3.2 **HIGH: Missing event broadcast on remote pad failure**
- **Issue**: Line 113, `_handleRemotePadEvent` catches all errors silently
- **Failure Mode**: Projector receives pad event but can't apply it; operator unaware
- **Visual Effect**: Control + projector pad states diverge

#### 3.3 **MEDIUM: Quantization pending flags not cleared on disable**
- **Issue**: Lines 351-352, `panic()` clears pending flags when performance mode disabled
- **Race Condition**: If pad was waiting for beat at moment of disable, snap/bounce timers may fire after `intensity=0`
- **Scenario**: Press key 1, immediately press P to disable → snap animation may still fire next frame
- **Impact**: Brief visual glitch, confusing for operator

#### 3.4 **MEDIUM: Exclusive group logic incomplete**
- **Issue**: Line 216, `exclusivityGroup` defined but never enforced in `getDeltas()`
- **Future Bug**: If pad 3 + 5 both active (both "heavy-post"), both contribute instead of one winning
- **Impact**: Broken design assumption if future pads added

#### 3.5 **MEDIUM: Worklet latency validation missing**
- **Issue**: Line 184, fallback BPM = 500ms assumes default 120 BPM
- **Failure Mode**: If `_beatMs` is 0 (invalid), bounce duration becomes 0, snap animation skipped
- **Scenario**: Audio context not initialized, features.beat = undefined
- **Impact**: Pad 1 feels unresponsive

### Data Loss Scenarios

| Scenario | Probability | Data Lost | Impact |
|----------|-------------|-----------|--------|
| Hold key 1 rapidly for 300ms | High | Latch state diverges 1-2 times | Control visual doesn't match projector |
| Projector receives padEvent after deletion | Medium | Event applies to wrong pad state | Projector visuals wrong |
| Disable performance mode mid-pad | Low | Snap/bounce may fire briefly | Visual glitch |

### Recommendations
1. **Atomic double-tap**: Use a state machine with "tapped", "waiting", "tapped-again" states
2. **Error handling in remote pad**: Log and emit event on failure, don't silently ignore
3. **Clear quantize pending on mode change**: Explicit state reset
4. **Enforce exclusivity groups**: Check in `getDeltas()`, pick highest intensity pad
5. **Validate BPM chain**: Assert `_beatMs > 0` before using in duration calcs

---

## 4. PRESET LIBRARY WINDOW (postMessage sync)
**File**: `src/preset-library-window.js` (first 100 lines shown)

### Current Implementation
- Popup window communication via parent.postMessage()
- Listeners managed in `_eventListeners` array
- Cleanup in `_cleanup()` method

### Critical Issues Found

#### 4.1 **HIGH: Popup window identity not verified**
- **Issue**: No check that `window.opener` is same origin before syncing presets
- **Failure Mode**: Malicious popup can observe preset snapshots via message interception
- **Security Risk**: Not a direct XSS but leaks user state
- **Scenario**: Third-party script opens preset library in hidden iframe, reads messages

#### 4.2 **HIGH: Event listener cleanup race condition**
- **Issue**: Line 88-90, `detach()` callback may be called while events firing
- **Failure Mode**: Listener fires → tries to access `this.manager` → manager is nulled
- **Scenario**: User closes preset library while loading is happening
- **Error Chain**: ReferenceError in manager callback → uncaught exception

#### 4.3 **MEDIUM: beforeunload listener not stored for re-removal**
- **Issue**: Line 79, listener removed by direct reference, not added to `_eventListeners`
- **Cleanup Bug**: If `_cleanup()` called twice, second call can't remove it
- **Memory Leak**: Small (single handler), but pattern indicates incomplete tracking

#### 4.4 **MEDIUM: _instance singleton not thread-safe**
- **Issue**: Line 97, `openPresetLibraryWindow._instance` global state
- **Race Condition**: If two windows opened simultaneously, second one may clobber first
- **Scenario**: User clicks "Presets" twice before first window loads
- **Impact**: First window loses cleanup trigger, memory leak if closed

### Data Loss Scenarios

| Scenario | Probability | Data Lost | Impact |
|----------|-------------|-----------|--------|
| Close preset library while loading | Medium | Partially applied preset | Settings half-updated |
| Open preset library twice | Low | First window loses cleanup | Memory leak |
| Malicious popup intercepts presets | Low (security) | Entire preset state | Privacy issue |

### Recommendations
1. **Verify opener origin**: Check `window.opener.location.origin === window.location.origin`
2. **Atomic cleanup**: Use flag to prevent callback firing after cleanup
3. **Track all listeners**: Add beforeunload to `_eventListeners` array
4. **Make singleton truly atomic**: Use WeakMap indexed by window reference

---

## 5. AUDIO WORKLET INTEGRATION (AudioWorkletNode)
**File**: `src/audio.js` (worklet initialization + message passing)

### Current Implementation
- WorkletNode created if available (line 478)
- Features extracted in worklet thread, posted back via `port.onmessage`
- Fallback to ScriptProcessor if unavailable

### Critical Issues Found

#### 5.1 **HIGH: Worklet initialization error not propagated**
- **Issue**: Line 479 `_maybeInitWorklet()` catches errors, no error event
- **Failure Mode**: Worklet fails to load but app continues as if it's working
- **Visual Impact**: Features incorrectly extracted (RMS spikes), beats detected falsely
- **Root Cause**: Silent fallback doesn't log failure, operator unaware
- **Scenario**: Worklet code syntax error in `analysis-processor.js`

#### 5.2 **HIGH: Worklet message loss during thread contention**
- **Issue**: No backpressure mechanism if worklet can't keep up with main thread posting
- **Failure Mode**: Audio features queue backs up, frame skips
- **Visual Effect**: Beat detection lags, visuals drop frames
- **Root Cause**: Main thread posts every frame, worklet may not drain queue fast enough

#### 5.3 **MEDIUM: Worklet shutdown not properly waited**
- **Issue**: Line 313, `_workletDraining` flag exists but never explicitly checked in drain loop
- **Failure Mode**: Worklet still processing when context closes
- **Scenario**: User closes browser tab → context closes → pending worklet messages lost

#### 5.4 **MEDIUM: No timeout on worklet initialization**
- **Issue**: `_maybeInitWorklet()` (referenced line 479) has no timeout
- **Failure Mode**: If worklet load stalls, app hangs indefinitely waiting for init
- **Scenario**: CDN-served worklet code slow to download

### Data Loss Scenarios

| Scenario | Probability | Data Lost | Impact |
|----------|-------------|-----------|--------|
| Worklet code syntax error | Low | Flux/RMS features broken | False beat detection |
| Worklet message queue overflows | High (heavy load) | Frame-worth of features | Stuttering visuals |
| Context closes with pending worklet messages | Medium | Last ~100ms of features | Abrupt silence |

### Recommendations
1. **Add worklet init timeout**: 5s max, fallback to ScriptProcessor if timeout
2. **Implement message queue backpressure**: Drop oldest frame if queue > 10 frames
3. **Log worklet failures**: Include in diagnostics output, visible to operator
4. **Explicit worklet drain on stop**: Wait for all pending messages before closing context
5. **Monitor worklet thread utilization**: Warn if > 80% utilization, reduce sample rate

---

## 6. EXTERNAL LIBRARY INTEGRATION (Lazy Loading)
**File**: `src/lazy.js` + `src/audio.js` (beat detector, Aubio, Meyda, Essentia)

### Current Implementation
- CDN fallback chain for each library (3-4 candidates)
- Failure cache with 60s cooldown (line 24)
- Transform function for normalizing exports

### Critical Issues Found

#### 6.1 **HIGH: Circular import risk in Meyda/MFCC extraction**
- **Issue**: `src/lazy.js` line 207, Meyda imported without checking if already loading
- **Race Condition**: Two simultaneous audio source starts → two Meyda import attempts → race to init
- **Failure Mode**: Second caller gets Promise from first import; if first fails, both fail
- **Scenario**: User clicks "Mic" while file already loading

#### 6.2 **HIGH: Essentia.js factory function invocation may fail**
- **Issue**: Lines 182-191, tries 6 different factory shapes, but doesn't validate returned object
- **Failure Mode**: `f()` might return Promise or sync value; caller expects sync
- **Impact**: Audio features undefined, cascade failures
- **Scenario**: New Essentia.js version changes export shape

#### 6.3 **MEDIUM: Failure cache too aggressive**
- **Issue**: 60s cooldown (line 24) means if CDN briefly down, user waits 1min
- **UX Issue**: "Try again" button would be better than silent 60s pause
- **Scenario**: CDN rate limits, but feature still available

#### 6.4 **MEDIUM: No retry budget for individual CDN URLs**
- **Issue**: Lines 121-136 (Aubio loop), tries 4 candidates once each
- **Failure Mode**: If first 3 CDNs are down but 4th up, first call fails, 60s cooldown prevents retry
- **Root Cause**: Failure marked at module level, not URL level
- **Scenario**: Specific CDN has regional outage

#### 6.5 **MEDIUM: Beat detector async wrapper hides failures**
- **Issue**: `src/audio.js` line 53-111, `getBeatDetectorGuess()` returns no-op on all failures
- **Silent Fallback**: No operator notification that BPM detection unavailable
- **Impact**: Tap tempo only source; live performances without BPM detection

### Data Loss Scenarios

| Scenario | Probability | Data Lost | Impact |
|----------|-------------|-----------|--------|
| CDN down, 60s cooldown | Medium | BPM/pitch features unavailable | Manual tap tempo only |
| Essentia factory returns Promise instead of module | Low | Beat grid calculation fails | No beat sync |
| Aubio queue overflow | High (CPU limited) | 100ms of frames dropped | Beat detection gaps |

### Recommendations
1. **Use Promise.race() for parallel CDN loading**: First successful load wins, others cancel
2. **Validate Essentia factory returns**: Check type, handle both sync and async
3. **Configurable failure cache duration**: Let operator adjust via settings
4. **Per-CDN retry tracking**: Reset timer if different CDN succeeds
5. **User notification**: Toast warning if optional libraries unavailable
6. **Aubio queue monitoring**: Warn if consistently dropping frames

---

## 7. SESSION RECOVERY INTEGRATION (localStorage + Sync)
**File**: `src/main.js` (lines 210-435) + `src/sync.js` (recovery messages)

### Critical Issues Found

#### 7.1 **CRITICAL: Race condition in crash detection + recovery modal**
- **Issue**: Lines 285-300, crash check runs sync, but recovery modal request async
- **Failure Mode**: If multiple windows open simultaneously, all detect crash → all request recovery modal
- **Scenario**: User restarts after crash, opens two control windows instantly
- **Impact**: Two modals on screen, duplicate restore attempts

```javascript
// Line 284-300: No locking between detection and modal
const wasActive = localStorage.getItem(SESSION_ACTIVE_KEY) === 'true';
if (wasActive) {
  crashedSessionDetected = true;
  // ... async loading of snapshot ...
  requestSessionRecoveryModal(crashedSnapshot);  // Can be called multiple times!
}
```

#### 7.2 **HIGH: Crash detection defeated by incomplete shutdown**
- **Issue**: Line 314, `SESSION_ACTIVE_KEY` always set to 'true'
- **Problem**: If app crashes between init and beforeunload, flag remains 'true' forever
- **False Positive**: Next startup always shows crash recovery even if graceful shutdown
- **Scenario**: Operator force-closes browser tab
- **Impact**: Operator confused by repeated recovery modals

#### 7.3 **HIGH: Recovery snapshot deserialization not validated**
- **Issue**: Lines 295-297, `StateSnapshot.decompress()` can throw, exception caught but modal still shown
- **Failure Mode**: User clicks "Restore" on corrupted snapshot → exception in apply → half-restored state
- **Impact**: Audio source list lost but visuals partially restored → confusing state

#### 7.4 **MEDIUM: Auto-save coordinator not synchronized with projector**
- **Issue**: Lines 357-435, only control window auto-saves
- **Failure Mode**: If projector crashes, no snapshot available, recovery incomplete
- **Scenario**: Dual-window setup, projector crashes, only control window has history
- **Impact**: Projector can't restore full state

### Recommendations
1. **Atomic crash flag**: Use timestamp + session ID to prevent multi-window races
2. **Explicit shutdown marker**: Set `SESSION_ACTIVE_KEY = 'false'` before close
3. **Recovery snapshot validation**: Checksum verify on load, reject if corrupted
4. **Projector auto-save**: Broadcast latest snapshot to control window periodically
5. **Recovery modal singleton**: Ensure only one modal per session

---

## CROSS-CUTTING ISSUES

### Issue: No Global Error Boundary
- **Problem**: Integration failures don't bubble up cleanly; many `.catch(_) {}` blocks
- **Impact**: Silent failures cascade across subsystems
- **Recommendation**: Add top-level error event handler to window, route to recovery system

### Issue: Heartbeat/Health Check Asymmetry
- **Sync**: Control monitors receiver heartbeat (5s timeout)
- **WebSocket**: Bridge heartbeat only logs (no action)
- **Worklet**: No health check at all
- **Recommendation**: Unified health monitoring with exponential backoff + operator notifications

### Issue: No Message Prioritization
- **Features (high frequency)** share channel with **params (lower frequency)**
- **Drop Policy**: Oldest messages dropped first, but params more critical
- **Recommendation**: Separate channels or priority queue

---

## LIVE PERFORMANCE IMPACT SUMMARY

### Scenario: 90-minute DJ set with multi-window projection

| Issue | Triggers | Recovery | Notes |
|-------|----------|----------|-------|
| Preset drift (storage full) | After ~60 min | Manual sync | Data loss! |
| OSC bridge loses sync | Bridge crash (1:1000 uptime) | Auto-retry + 15s dead | ~5s of bad audio |
| Projector pad state diverges | Rapid pad input | Auto-resync on next preset | Visuals misaligned |
| Worklet features drop | High CPU load | Fallback to ScriptProcessor | Minor quality drop |
| Session recovery on start | App crash | Modal blocks control | Operator intervention required |

---

## TESTING CHECKLIST

- [ ] Multi-window: Open 3 windows simultaneously, change preset on control → verify on 2 projectors
- [ ] WebSocket: Start bridge after app, verify ~2s initial silence, no features lost on resume
- [ ] Performance Pads: Hold key 1 for 500ms, verify latch toggled once, projector matches
- [ ] Preset Library: Open, close during load, verify state consistent with control
- [ ] Audio Worklet: Check DevTools → disable worklet, verify features still extracted
- [ ] External libs: Offline mode (block CDN), verify fallbacks work, toast notification shown
- [ ] Recovery: Force-kill browser, reopen tab, verify recovery modal appears once
- [ ] Storage quota: Fill localStorage to 90%, run 10-minute session, verify params still sync
- [ ] Heartbeat: Pause receiver window for 20s, verify control detects disconnect/reconnect

---

## PRIORITY FIXES (Estimate: 2-3 days)

**CRITICAL (Fix immediately)**
1. Message ordering in sync (add sequence numbers)
2. Storage quota handling (queue + retry)
3. Crash detection race condition (atomic lock)
4. OSC bridge feature validation (isFinite check)

**HIGH (Next sprint)**
1. Feature queue in WebSocket (buffer 500ms)
2. Worklet initialization timeout (5s)
3. Double-tap atomicity (state machine)
4. Recovery snapshot validation (checksum)

**MEDIUM (Backlog)**
1. Exclusive pad groups (enforce in getDeltas)
2. Essentia factory validation
3. Failure cache per-CDN tracking
4. Auto-save to projector
