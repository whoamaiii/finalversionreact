# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Interactive Cosmic Anomaly is a browser-based audio-reactive visualizer built with Three.js. It analyzes audio in real-time (from mic, system audio, or files) and renders synchronized 3D particle effects with advanced post-processing. The application is optimized for live VJ performances, particularly drum & bass shows, with a sophisticated preset management system.

**Target Browser**: Chrome on macOS (system audio capture requires Chrome's tab audio sharing)

## Development Commands

### Local Development
```bash
# Development server (Vite)
npm run dev              # Start dev server on http://localhost:5173

# Alternative: Python HTTP server (for ES module support)
python3 -m http.server 5173

# Alternative: Node HTTP server
npx http-server -p 5173
```

### Build & Preview
```bash
npm run build           # Build production bundle to /dist
npm run preview         # Preview production build
```

### TouchDesigner Integration (OSC Bridge)
```bash
cd tools
npm install             # Install bridge dependencies
npm start               # Start WebSocket → OSC bridge

# Production (with PM2)
npm run pm2             # Start bridge with PM2
npm run pm2:logs        # View bridge logs
npm run pm2:stop        # Stop bridge
npm run pm2:restart     # Restart bridge
```

**Bridge Configuration** (via environment variables):
- `WS_HOST` / `WS_PORT`: WebSocket listen address (default: 127.0.0.1:8090)
- `OSC_HOST` / `OSC_PORT`: OSC output destination (default: 127.0.0.1:9000)

## Architecture & Data Flow

### Core System Components

The application is organized into several coordinated subsystems:

**1. Audio Analysis Pipeline** (`src/audio.js`)
- `AudioEngine` class: Central audio processing system
- Creates Web Audio API graph: AudioContext → AnalyserNode → Feature extraction
- Integrates external libraries (Aubio, Meyda, Essentia) via lazy loading
- Extracts 30+ features per frame: RMS, frequency bands, spectral characteristics, beat detection, tempo, pitch, MFCC, chroma
- Uses AudioWorklet for advanced processing in separate thread
- Supports three input sources: microphone, system audio (Chrome tab sharing), audio files

**2. Visual Rendering System** (`src/scene.js`)
- Three.js scene with particle systems: main sphere, orbit rings, stars, sparks
- Custom GLSL shaders for audio-reactive particle motion (noise-based displacement, explosion effects)
- Post-processing pipeline (EffectComposer): bloom, chromatic aberration, lens flare
- Four built-in themes (nebula, sunset, forest, aurora) with HDR environment maps
- Exposes `sceneApi` for parameter control and state management
- Handles auto-resolution (dynamic pixel ratio adjustment to maintain target FPS)

**3. Preset Management** (`src/preset-manager.js`)
- `PresetManager` class: CRUD operations for presets with atomic persistence
- Captures complete show state: audio parameters, mappings, dispersion config, visuals, shader settings
- localStorage persistence with safety: staged writes to `.tmp`, atomic promotion, `.bak` backups
- Version history (15 versions per preset) with rollback capability
- Favorites, recents, search, tags
- Parameter locking system (prevents preset changes to opacity/color unless explicitly enabled)
- Modulation guards for live performance safety

**4. Preset Library UI** (`src/preset-library-window.js`)
- Dedicated popup window (opened with `L` key) to avoid obscuring main visuals
- Search, filter, compare, history restore
- Modulation toggles for opacity and color parameters
- Fast preset switching with rollback support

**5. Multi-Window Sync** (`src/sync.js`)
- `SyncCoordinator` class: Synchronizes state across browser windows (control + projector mode)
- Uses BroadcastChannel, postMessage, localStorage heartbeat fallbacks
- Syncs audio features (33ms interval) and parameters (450ms interval)
- Heartbeat mechanism detects disconnected windows

**6. Settings UI** (`src/settings-ui.js`)
- Sliding drawer panel (glassmorphism design)
- Tabs: Quick, Source, Audio, Visuals, Mapping, Tempo, Presets, Session
- Real-time parameter binding to scene and audio engine
- Delegates preset operations to `PresetManager`

### Critical Data Flow

```
Audio Input
  ↓
AudioEngine.update() [analyze features]
  ↓
main.js animation loop
  ↓
├─→ sceneApi.update(features) [animate visuals]
├─→ sync.pushFeatures(features) [broadcast to projector windows]
└─→ WebSocket.send(features) [send to OSC bridge → TouchDesigner]
```

### Module Responsibilities

| File | Purpose |
|------|---------|
| `src/main.js` | Application entry point, animation loop, component orchestration |
| `src/audio.js` | Audio analysis engine, feature extraction |
| `src/scene.js` | Three.js rendering, particle systems, shaders, themes |
| `src/preset-manager.js` | Preset persistence, CRUD, version history, locking |
| `src/preset-library-window.js` | Popup UI for preset management |
| `src/preset-io.js` | Pure functions for capturing/applying snapshots |
| `src/settings-ui.js` | Settings drawer UI and parameter controls |
| `src/sync.js` | Multi-window synchronization via BroadcastChannel |
| `src/dispersion.js` | Custom shader layer (dispersion effect) |
| `src/dispersion-config.js` | Default parameters for dispersion layer |
| `src/lazy.js` | Lazy module loading with CDN fallbacks |
| `src/feature.js` | Browser capability detection |
| `src/toast.js` | Notification system |
| `src/performance-pads.js` | Live performance pad controls (5 pads: Warp, Shutter, Smear, Stutter, Swirl) |
| `src/midi-launchpad.js` | Launchpad MIDI controller integration (optional) |
| `tools/osc-bridge.js` | WebSocket → OSC bridge for TouchDesigner |

### Important Initialization Patterns

**Lazy Loading**: External libraries (Aubio, Meyda, Essentia) are loaded on-demand with CDN fallbacks to avoid blocking startup. See `src/lazy.js` for the multi-CDN retry pattern.

**Audio Context Unlocking**: Safari/iOS require user gesture before audio playback. The `start-audio-btn` button in `index.html` resumes all audio contexts stored in `window.__reactiveCtxs`.

**Atomic Preset Writes**: Presets follow a staged write pattern:
1. Write to `cosmicPresetLibrary.v1.tmp`
2. Back up current to `cosmicPresetLibrary.v1.bak`
3. Promote `.tmp` to `cosmicPresetLibrary.v1`

**Parameter Delta Merging**: Performance pads and MIDI controller deltas are merged in `main.js` via `sceneApi.setUniformDeltasProvider()` to blend with audio baseline.

## Key Patterns & Conventions

### Parameter Paths
Use dot notation for nested parameters: `visuals.dispersion.opacityBase`, `audio.mapping.beatSensitivity`

### Parameter Locking
Opacity and color parameters are locked by default (see `PresetManager` constructor). Locks prevent preset changes unless explicitly enabled via "Audio Modulation" toggles in the preset library UI.

### Feature Sanitization
When syncing or serializing audio features, use `sanitizeFeatures()` (in `sync.js`) to avoid sending heavy/circular data structures.

### Error Handling
- Always wrap lazy imports in try/catch with graceful fallbacks
- Use `console.warn` for non-critical failures, `console.error` for critical issues
- Prefix log messages with `[ComponentName]` for debugging (e.g., `[PresetManager]`, `[OSC]`)

### State Management
- `sceneApi.state.params` holds all visual/shader parameters
- `audio` instance holds all audio analysis parameters
- `PresetManager` captures both via `capturePresetSnapshot()`

## Working with Presets

Presets capture the entire show state and are the primary way operators switch configurations during live performances.

### Creating Presets Programmatically
```javascript
// Capture current state
const snapshot = presetManager.capturePresetSnapshot();

// Create new preset
presetManager.create({
  name: 'My Preset',
  tags: ['bass', 'high-energy'],
  favorite: false,
  snapshot: snapshot // optional, defaults to current
});
```

### Loading Presets
```javascript
// Load by name or ID
presetManager.load('My Preset', { silent: false });

// Rollback to previous state
presetManager.rollback();
```

### Adding Default Presets
Edit `DEFAULT_PRESETS` array in `src/preset-manager.js`. Each entry should have:
- `name`: Unique preset name
- `tags`: Array of searchable tags
- `favorite`: Boolean
- `snapshot`: Complete state object (audio, mapping, dispersion, visuals, shader)

See existing drum & bass presets ("DnB Heavy Bass", "DnB Geometry Shift") for examples.

## TouchDesigner Integration

The application can stream audio features to TouchDesigner via the OSC bridge.

### Available OSC Addresses
All features are sent as OSC messages with `/reactive/` prefix:

**Scalars**: `/reactive/rms`, `/reactive/rmsNorm`, `/reactive/centroid`, `/reactive/flux`, `/reactive/beat`, `/reactive/bpm`, `/reactive/pitchHz`, etc.

**Bands**: `/reactive/bandsEMA/bass`, `/reactive/bandEnv/sub`, `/reactive/bandNorm/treble`

**Arrays**: `/reactive/mfcc/0..12`, `/reactive/chroma/0..11`

See README.md "TouchDesigner integration" section for complete list and TD setup instructions.

### Typical Mappings
- Beat pulse: `/reactive/beat` → Lag CHOP → gate effects
- Bass brightness: `/reactive/bandEnv/bass` → multiply light/geo intensity
- Camera motion: `/reactive/centroid` → control speed, `/reactive/flux` → energy
- Colorization: `/reactive/chroma/*` or MFCCs → Ramp TOP

## Performance Optimization

### Auto-Resolution
Enabled by default. Dynamically adjusts `renderer.pixelRatio` to maintain target FPS (default: 60). Configured in `sceneApi.state.params.pixelRatio` and `sceneApi.state.params.autoResolution`.

### Heavy Operations
- **Particle density changes** trigger geometry rebuilds (expensive). Adjust sparingly during playback.
- **HDR loading** uses remote CDN URLs. CORS failures fall back to black background.
- **Shader compilation** happens on first render; subsequent theme switches are fast.

### Known Limitations
- System audio capture only works in Chrome (Safari/Firefox don't support tab audio sharing)
- Import map shim included for older Safari/Firefox compatibility
- Essentia.js (advanced ML features) is optional and loaded on-demand

## Debugging

### Debug Mode
Add `?debug` to URL to enable feature detection logging in console.

### Common Issues

**Popup blocked**: Allow popups for localhost to use preset library window.

**Storage quota exceeded**: Check browser devtools → Application → Storage. Clear `cosmicPresetLibrary.*` keys if needed.

**Corrupt preset state**: Clear localStorage keys or use `?factory` query param to reset.

**Audio not unlocking on iOS**: Ensure `start-audio-btn` click handler resumes all contexts in `window.__reactiveCtxs`.

**OSC bridge not sending**: Confirm WebSocket connection in browser console. Check bridge terminal logs for `[WS] client connected`.

## File Modification Guidelines

### When editing shaders (`src/scene.js`, `src/dispersion.js`):
- Vertex/fragment shaders are inline template strings
- Uniforms are updated per-frame in `updateUniforms()` functions
- Use `time` uniform for animations, `uReactiveScale` for audio reactivity
- Test with different themes to ensure color compatibility

### When adding audio features (`src/audio.js`):
- Add feature extraction in `AudioEngine.update()`
- Update `sanitizeFeatures()` in `src/sync.js` if syncing to projector windows
- Update OSC bridge (`tools/osc-bridge.js`) if sending to TouchDesigner
- Document new features in README.md "TouchDesigner integration" section

### When adding settings (`src/settings-ui.js`):
- Add parameter to appropriate tab config object
- Bind to `sceneApi.state.params.*` or `audio.*`
- Update `capturePresetSnapshot()` in `src/preset-io.js` to persist
- Add default value to `withDispersionDefaults()` if dispersion-related

## Testing Workflow

After making changes, verify:
1. Dev server starts without errors: `npm run dev`
2. Audio analysis works (check FPS and beat indicator in settings)
3. Preset load/save/rollback works (press `L`, test operations)
4. Settings persist across page reload (toggle settings, refresh)
5. Multi-window sync works (open second window with `?role=projector`)
6. OSC bridge receives features (if TouchDesigner integration needed)

For detailed verification checklist, see `VERIFICATION.md`.
