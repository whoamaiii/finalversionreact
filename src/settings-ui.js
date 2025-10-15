// New glass settings UI (drawer + tabs) — no external UI lib
// Exports: initSettingsUI({ sceneApi, audioEngine, onScreenshot, syncCoordinator })

export function initSettingsUI({ sceneApi, audioEngine, onScreenshot, syncCoordinator }) {
  const root = document.getElementById('settings-root');
  const drawer = document.getElementById('settings-drawer');
  const overlay = document.getElementById('settings-overlay');
  const tabsEl = document.getElementById('settings-tabs');
  const content = document.getElementById('settings-content');
  const btnOpen = document.getElementById('open-settings-btn');
  const btnClose = document.getElementById('settings-close');
  const btnCloseFooter = document.getElementById('settings-close-footer');
  const btnReset = document.getElementById('settings-reset');
  const btnSaveSettings = document.getElementById('settings-save-settings');
  const btnSavePreset = document.getElementById('settings-save-preset');

  const tabs = [
    { id: 'quick', label: 'Quick' },
    { id: 'source', label: 'Source' },
    { id: 'audio', label: 'Audio' },
    { id: 'visuals', label: 'Visuals' },
    { id: 'shader', label: 'Shader' },
    { id: 'mapping', label: 'Mapping' },
    { id: 'tempo', label: 'Tempo' },
    { id: 'presets', label: 'Presets' },
    { id: 'session', label: 'Session' },
  ];
  const SETTINGS_STORAGE_KEY = 'cosmic_saved_settings';
  const showProjectorControls = !!syncCoordinator && syncCoordinator.role === 'control';
  let syncStatusNode = null;
  let syncAutoCheckbox = null;

  function open() {
    root.style.display = 'block';
    requestAnimationFrame(() => { root.classList.add('open'); });
    try { btnOpen.setAttribute('aria-expanded', 'true'); } catch(_) {}
  }
  function close() {
    root.classList.remove('open');
    setTimeout(() => { root.style.display = 'none'; }, 260);
    try { btnOpen.setAttribute('aria-expanded', 'false'); } catch(_) {}
  }

  btnOpen.addEventListener('click', open);
  overlay.addEventListener('click', close);
  btnClose.addEventListener('click', close);
  btnCloseFooter.addEventListener('click', close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (root.style.display === 'block' && root.classList.contains('open')) close(); else open();
    }
  });

  // Helpers
  function showToast(message) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = message; el.classList.add('visible');
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => { el.classList.remove('visible'); }, 2600);
  }

  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v);
    }
    if (!Array.isArray(children)) children = [children];
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === 'string') el.appendChild(document.createTextNode(c));
      else el.appendChild(c);
    }
    return el;
  }

  function fieldRow(label, control) {
    const row = h('div', { class: 'row' }, [
      h('div', { class: 'label' }, label),
      h('div', { class: 'control' }, control),
    ]);
    return row;
  }

  function slider({ min, max, step, value, oninput }) {
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    input.addEventListener('input', (e) => oninput(parseFloat(input.value)));
    return input;
  }

  function select(opts, value, onchange) {
    const s = h('select');
    for (const { label, value: val } of opts) s.appendChild(h('option', { value: String(val), selected: val === value ? 'true' : undefined }, label));
    s.addEventListener('change', () => onchange(s.value));
    return s;
  }

  function button(title, onclick, extra = {}) {
    const props = { onClick: onclick, ...extra };
    return h('button', props, title);
  }

  // Tab builders
  async function buildSource() {
    const container = h('div', { class: 'section' });
    container.appendChild(h('div', { class: 'section-title' }, 'Source'));
    const isMac = (() => { try { const ua = navigator.userAgent || ''; const plat = navigator.platform || ''; return /Mac/i.test(ua) || /Mac/i.test(plat); } catch(_) { return false; } })();
    const systemLabel = isMac ? 'Tab (Chrome)' : 'System';
    container.appendChild(button('Mic', async () => {
      try { await audioEngine.startMic(localStorage.getItem('cosmic_mic_device_id') || undefined); } catch(e){ showToast('Mic denied/unavailable'); }
    }));
    container.appendChild(button(systemLabel, async () => {
      try { await audioEngine.startSystemAudio(); } catch(e){ /* audioEngine shows detailed toasts */ }
    }));
    container.appendChild(button('File', async () => {
      try { const input = document.createElement('input'); input.type = 'file'; input.accept = 'audio/*'; input.onchange = async () => { const f = input.files?.[0]; if (f) await audioEngine.loadFile(f); }; input.click(); } catch(e){ showToast('File load failed'); }
    }));
    container.appendChild(button('Stop', () => { try { audioEngine.stop(); } catch(_){} }));

    // Inline hint for macOS users
    if (isMac) {
      container.appendChild(h('div', { style: { fontSize: '11px', color: 'rgba(255,255,255,0.75)', marginTop: '6px', marginBottom: '6px' } },
        'macOS: For a single tab, click "Tab (Chrome)" → enable "Share tab audio". For full system audio, select BlackHole as Mic (see below).'));
    }

    // Devices dropdown
    const deviceRow = h('div', { class: 'section' });
    deviceRow.appendChild(h('div', { class: 'section-title' }, 'Input Device'));
    const devices = await audioEngine.getInputDevices().catch(() => []);

    // Detect popular virtual loopback devices (BlackHole, Loopback, Soundflower, VB-CABLE, Background Music)
    const names = ['blackhole', 'loopback', 'soundflower', 'vb-cable', 'background music'];
    const virtual = devices.find(d => names.some(n => (d.label || '').toLowerCase().includes(n)));
    const prettyVirtualName = virtual ? (['BlackHole','Loopback','Soundflower','VB-CABLE','Background Music'].find(n => (virtual.label||'').toLowerCase().includes(n.toLowerCase())) || 'Virtual Device') : null;

    const opts = devices.map((d, i) => ({ label: d.label || `Mic ${i+1}`, value: d.deviceId || '' }));
    let stored = localStorage.getItem('cosmic_mic_device_id') || '';
    if (!stored && virtual?.deviceId) {
      try { localStorage.setItem('cosmic_mic_device_id', virtual.deviceId); stored = virtual.deviceId; } catch(_) {}
    }
    const dd = select(opts, stored || (virtual?.deviceId || ''), async (id) => {
      try { localStorage.setItem('cosmic_mic_device_id', id); await audioEngine.startMic(id || undefined); } catch(_) { showToast('Mic switch failed'); }
    });
    deviceRow.appendChild(dd);
    deviceRow.appendChild(button('Refresh', async () => { render('source'); showToast('Device list refreshed'); }));

    if (virtual) {
      deviceRow.appendChild(button(`Use ${prettyVirtualName || 'BlackHole'}`, async () => {
        try {
          localStorage.setItem('cosmic_mic_device_id', virtual.deviceId || '');
          await audioEngine.startMic(virtual.deviceId || undefined);
          showToast(`${prettyVirtualName || 'BlackHole'} selected`);
        } catch(_) { showToast('Could not start virtual device'); }
      }));
    }

    container.appendChild(deviceRow);
    return container;
  }

  function buildAudio() {
    const st = {
      gain: 1.0,
      sensitivity: audioEngine.sensitivity || 1.0,
      smoothing: audioEngine.smoothing || 0.6,
      fftSize: audioEngine.fftSize || 2048,
      subHz: audioEngine.bandSplit?.sub || 90,
      lowHz: audioEngine.bandSplit?.low || 200,
      midHz: audioEngine.bandSplit?.mid || 2000,
      beatCooldown: audioEngine.beatCooldownMs || 500,
      envAttack: audioEngine.envAttack ?? 0.7,
      envRelease: audioEngine.envRelease ?? 0.12,
      agcEnabled: !!audioEngine.bandAGCEnabled,
      agcDecay: audioEngine.bandAGCDecay ?? 0.995,
      dropEnabled: !!audioEngine.dropEnabled,
      dropFluxThresh: audioEngine.dropFluxThresh ?? 1.4,
      dropBassThresh: audioEngine.dropBassThresh ?? 0.55,
      dropCentroidSlopeThresh: audioEngine.dropCentroidSlopeThresh ?? 0.02,
      dropMinBeats: audioEngine.dropMinBeats ?? 4,
      dropCooldownMs: audioEngine.dropCooldownMs ?? 4000,
    };
    const el = h('div', { class: 'section' }, [ h('div', { class: 'section-title' }, 'Audio') ]);
    el.appendChild(fieldRow('Gain', slider({ min: 0.1, max: 4.0, step: 0.1, value: st.gain, oninput: (v) => audioEngine.setGain(v) })));
    el.appendChild(fieldRow('Beat Sens', slider({ min: 0.0, max: 2.0, step: 0.05, value: st.sensitivity, oninput: (v) => audioEngine.setSensitivity(v) })));
    el.appendChild(fieldRow('Smoothing', slider({ min: 0.0, max: 0.95, step: 0.05, value: st.smoothing, oninput: (v) => audioEngine.setSmoothing(v) })));
    el.appendChild(fieldRow('FFT Size', select([
      512,1024,2048,4096,8192,16384,32768
    ].map(n => ({ label: String(n), value: n })), st.fftSize, (v) => audioEngine.setFFTSize(parseInt(v,10)) )));
    el.appendChild(fieldRow('Sub < Hz', slider({ min: 40, max: 120, step: 5, value: st.subHz, oninput: (v) => audioEngine.setSubHz(v) })));
    el.appendChild(fieldRow('Bass < Hz', slider({ min: 60, max: 400, step: 10, value: st.lowHz, oninput: (v) => audioEngine.setBandSplit(v, st.midHz=(st.midHz||2000)) })));
    el.appendChild(fieldRow('Mid < Hz', slider({ min: 800, max: 5000, step: 50, value: st.midHz, oninput: (v) => audioEngine.setBandSplit(st.lowHz=(st.lowHz||200), v) })));
    el.appendChild(fieldRow('Beat Cooldown', slider({ min: 100, max: 1500, step: 50, value: st.beatCooldown, oninput: (v) => audioEngine.setBeatCooldown(v) })));
    el.appendChild(fieldRow('Env Attack', slider({ min: 0.0, max: 1.0, step: 0.01, value: st.envAttack, oninput: (v) => audioEngine.setEnvAttack(v) })));
    el.appendChild(fieldRow('Env Release', slider({ min: 0.0, max: 1.0, step: 0.01, value: st.envRelease, oninput: (v) => audioEngine.setEnvRelease(v) })));
    el.appendChild(fieldRow('Band AGC', checkbox(st.agcEnabled, (v)=> audioEngine.setBandAgcEnabled(v) )));
    el.appendChild(fieldRow('AGC Decay', slider({ min: 0.90, max: 0.9999, step: 0.0005, value: st.agcDecay, oninput: (v) => audioEngine.setBandAgcDecay(v) })));

    // Drop Detection section
    el.appendChild(h('div', { class: 'section-title' }, 'Drop Detection'));
    el.appendChild(fieldRow('Enable', checkbox(st.dropEnabled, (v)=> audioEngine.setDropEnabled(v) )));
    el.appendChild(fieldRow('Flux Z Thresh', slider({ min: 0.2, max: 3.0, step: 0.05, value: st.dropFluxThresh, oninput: (v) => audioEngine.setDropFluxThresh(v) })));
    el.appendChild(fieldRow('Bass Thresh', slider({ min: 0.1, max: 1.0, step: 0.02, value: st.dropBassThresh, oninput: (v) => audioEngine.setDropBassThresh(v) })));
    el.appendChild(fieldRow('Centroid Slope Thresh', slider({ min: 0.005, max: 0.1, step: 0.002, value: st.dropCentroidSlopeThresh, oninput: (v) => audioEngine.setDropCentroidSlopeThresh(v) })));
    el.appendChild(fieldRow('Min Build Beats', slider({ min: 1, max: 8, step: 1, value: st.dropMinBeats, oninput: (v) => audioEngine.setDropMinBeats(v) })));
    el.appendChild(fieldRow('Cooldown (ms)', slider({ min: 500, max: 8000, step: 100, value: st.dropCooldownMs, oninput: (v) => audioEngine.setDropCooldownMs(v) })));
    return el;
  }

  function buildVisuals() {
    const el = h('div', { class: 'section' }, [ h('div', { class: 'section-title' }, 'Visuals') ]);
    // Theme
    const themeOpts = ['nebula','sunset','forest','aurora'].map(t => ({ label: t, value: t }));
    el.appendChild(fieldRow('Theme', select(themeOpts, sceneApi.state.params.theme, (v) => sceneApi.changeTheme(v))));
    el.appendChild(fieldRow('HDR Bg', checkbox(sceneApi.state.params.useHdrBackground, (v)=>{ sceneApi.state.params.useHdrBackground = v; sceneApi.changeTheme(sceneApi.state.params.theme); })));
    el.appendChild(fieldRow('Fog', slider({ min: 0.0, max: 0.02, step: 0.0005, value: sceneApi.state.params.fogDensity, oninput: (v)=>{ sceneApi.state.scene.fog.density = v; } })));
    el.appendChild(fieldRow('Bloom Base', slider({ min: 0.0, max: 3.0, step: 0.05, value: sceneApi.state.params.bloomStrengthBase, oninput: (v)=>{ sceneApi.state.params.bloomStrengthBase = v; } })));
    el.appendChild(fieldRow('Bloom Reactive', slider({ min: 0.0, max: 2.5, step: 0.05, value: sceneApi.state.params.bloomReactiveGain, oninput: (v)=>{ sceneApi.state.params.bloomReactiveGain = v; } })));
    el.appendChild(fieldRow('Pixel Ratio', slider({ min: 0.5, max: 2.0, step: 0.1, value: sceneApi.state.params.pixelRatioCap, oninput: (v)=> sceneApi.setPixelRatioCap(v) })));
    el.appendChild(fieldRow('Auto Rotate', slider({ min: 0.0, max: 0.01, step: 0.0001, value: sceneApi.state.params.autoRotate, oninput: (v)=>{ sceneApi.state.params.autoRotate = v; } })));
    el.appendChild(fieldRow('Particles', slider({ min: 0.25, max: 1.5, step: 0.05, value: sceneApi.state.params.particleDensity, oninput: (v)=>{ sceneApi.state.params.particleDensity = v; sceneApi.rebuildParticles(); } })));
    el.appendChild(fieldRow('Sparks', checkbox(sceneApi.state.params.enableSparks, (v)=> sceneApi.setEnableSparks(v))));
    el.appendChild(fieldRow('Core Glow', checkbox(sceneApi.state.params.useLensflare, (v)=> sceneApi.setUseLensflare(v))));
    el.appendChild(fieldRow('Auto Res', checkbox(sceneApi.state.params.autoResolution, (v)=>{ sceneApi.state.params.autoResolution = v; } )));
    el.appendChild(fieldRow('Target FPS', slider({ min: 30, max: 90, step: 1, value: sceneApi.state.params.targetFps, oninput: (v)=>{ sceneApi.state.params.targetFps = v; } })));
    el.appendChild(fieldRow('Min PR', slider({ min: 0.4, max: 1.5, step: 0.05, value: sceneApi.state.params.minPixelRatio, oninput: (v)=>{ sceneApi.state.params.minPixelRatio = v; } })));

    // Visual Mode (classic / overlay / shader-only)
    const modeOpts = [
      { label: 'Classic (3D only)', value: 'classic' },
      { label: '3D + Dispersion', value: 'overlay' },
      { label: 'Dispersion only', value: 'shader-only' },
    ];
    el.appendChild(fieldRow('Visual Mode', select(modeOpts, sceneApi.state.params.visualMode || 'overlay', (v)=>{ sceneApi.state.params.visualMode = v; if (typeof sceneApi.setVisualMode === 'function') sceneApi.setVisualMode(v); } )));
    // Actions
    el.appendChild(fieldRow('Screenshot', button('Capture', onScreenshot)));
    el.appendChild(fieldRow('Explosion', button('Trigger', ()=> sceneApi.triggerExplosion())));
    return el;
  }

  function checkbox(value, onchange) {
    const c = h('input', { type: 'checkbox' }); c.checked = !!value; c.addEventListener('change', ()=> onchange(!!c.checked)); return c;
  }

  function buildMapping() {
    const m = sceneApi.state.params.map;
    if (!m.shockwave) m.shockwave = { enabled: true, beatIntensity: 0.55, dropIntensity: 1.2, durationMs: 1200 };
    if (!m.chromatic) m.chromatic = { base: 0.00025, treble: 0.0009, beat: 0.0012, drop: 0.0024, lerp: 0.14 };
    if (!m.eye || typeof m.eye !== 'object') {
      m.eye = {
        enabled: true,
        pupilBase: 0.22,
        pupilRange: 0.45,
        pupilAttack: 0.18,
        pupilRelease: 0.35,
        catAspectMax: 0.65,
        hueMixFromChroma: 0.65,
        saturationFromCentroid: 0.5,
        fiberContrast: 1.2,
        fiberNoiseScale: 3.0,
        limbusDarkness: 0.55,
        blinkOnDrop: true,
        blinkDurationMs: 150,
        randomBlinkMinSec: 12,
        randomBlinkMaxSec: 28,
        corneaEnabled: true,
        corneaFresnel: 1.25,
        corneaTintMix: 0.25,
        corneaOpacity: 0.65,
        glintSize: 0.035,
        glintIntensity: 1.2,
        predatorMode: false,
      };
    }
    if (typeof m.cameraRollFromCentroid !== 'number') m.cameraRollFromCentroid = 0.18;
    if (typeof m.mainSwayFromFlux !== 'number') m.mainSwayFromFlux = 0.12;
    if (typeof m.chromaLightInfluence !== 'number') m.chromaLightInfluence = 0.22;
    if (typeof m.ringBrightFromChroma !== 'number') m.ringBrightFromChroma = 0.3;
    const el = h('div', { class: 'section' }, [ h('div', { class: 'section-title' }, 'Mapping') ]);
    el.appendChild(fieldRow('Sphere Size <- RMS', slider({ min: 0.0, max: 1.5, step: 0.05, value: m.sizeFromRms, oninput: (v)=>{ m.sizeFromRms = v; } })));
    el.appendChild(fieldRow('Ring Scale <- Bands', slider({ min: 0.0, max: 1.0, step: 0.05, value: m.ringScaleFromBands, oninput: (v)=>{ m.ringScaleFromBands = v; } })));
    el.appendChild(fieldRow('Ring Speed <- Bands', slider({ min: 0.0, max: 3.0, step: 0.1, value: m.ringSpeedFromBands, oninput: (v)=>{ m.ringSpeedFromBands = v; } })));
    el.appendChild(fieldRow('Cam Shake <- Beat', slider({ min: 0.0, max: 1.0, step: 0.05, value: m.cameraShakeFromBeat, oninput: (v)=>{ m.cameraShakeFromBeat = v; } })));
    el.appendChild(fieldRow('Bloom Color <- Centroid', slider({ min: 0.0, max: 1.0, step: 0.05, value: m.colorBoostFromCentroid, oninput: (v)=>{ m.colorBoostFromCentroid = v; } })));
    el.appendChild(fieldRow('Core Bright <- RMS', slider({ min: 0.0, max: 3.0, step: 0.05, value: m.sphereBrightnessFromRms, oninput: (v)=>{ m.sphereBrightnessFromRms = v; } })));
    el.appendChild(fieldRow('Core Noise <- Mid', slider({ min: 0.0, max: 2.5, step: 0.05, value: m.sphereNoiseFromMid, oninput: (v)=>{ m.sphereNoiseFromMid = v; } })));
    el.appendChild(fieldRow('Core Pulse <- Bass', slider({ min: 0.0, max: 2.0, step: 0.05, value: m.spherePulseFromBass || 0.6, oninput: (v)=>{ m.spherePulseFromBass = v; } })));
    el.appendChild(fieldRow('Core Sparkle <- Treble', slider({ min: 0.0, max: 2.0, step: 0.05, value: m.sphereSparkleFromTreble || 0.5, oninput: (v)=>{ m.sphereSparkleFromTreble = v; } })));
    el.appendChild(fieldRow('Rings Noise <- Bands', slider({ min: 0.0, max: 1.5, step: 0.05, value: m.ringNoiseFromBands, oninput: (v)=>{ m.ringNoiseFromBands = v; } })));
    el.appendChild(fieldRow('FOV Pump <- Bass', slider({ min: 0.0, max: 2.0, step: 0.05, value: m.fovPumpFromBass || 0.6, oninput: (v)=>{ m.fovPumpFromBass = v; } })));
    el.appendChild(fieldRow('Light Intensity <- Bass', slider({ min: 0.0, max: 4.0, step: 0.1, value: m.lightIntensityFromBass, oninput: (v)=>{ m.lightIntensityFromBass = v; } })));
    el.appendChild(fieldRow('Bass Weight', slider({ min: 0.0, max: 3.0, step: 0.05, value: m.bandWeightBass, oninput: (v)=>{ m.bandWeightBass = v; } })));
    el.appendChild(fieldRow('Mid Weight', slider({ min: 0.0, max: 3.0, step: 0.05, value: m.bandWeightMid, oninput: (v)=>{ m.bandWeightMid = v; } })));
    el.appendChild(fieldRow('Treble Weight', slider({ min: 0.0, max: 3.0, step: 0.05, value: m.bandWeightTreble, oninput: (v)=>{ m.bandWeightTreble = v; } })));
    el.appendChild(fieldRow('Stars <- Treble', slider({ min: 0.0, max: 3.0, step: 0.05, value: m.starTwinkleFromTreble, oninput: (v)=>{ m.starTwinkleFromTreble = v; } })));
    el.appendChild(fieldRow('Ring Tilt <- Bass', slider({ min: 0.0, max: 2.0, step: 0.05, value: m.ringTiltFromBass, oninput: (v)=>{ m.ringTiltFromBass = v; } })));
    el.appendChild(fieldRow('Cam Roll <- Centroid Δ', slider({ min: 0.0, max: 0.6, step: 0.01, value: m.cameraRollFromCentroid, oninput: (v)=>{ m.cameraRollFromCentroid = v; } })));
    el.appendChild(fieldRow('Group Sway <- Flux', slider({ min: 0.0, max: 0.6, step: 0.01, value: m.mainSwayFromFlux, oninput: (v)=>{ m.mainSwayFromFlux = v; } })));
    el.appendChild(fieldRow('Light Hue <- Chroma', slider({ min: 0.0, max: 1.0, step: 0.02, value: m.chromaLightInfluence, oninput: (v)=>{ m.chromaLightInfluence = v; } })));
    el.appendChild(fieldRow('Ring Bright <- Chroma', slider({ min: 0.0, max: 1.5, step: 0.05, value: m.ringBrightFromChroma, oninput: (v)=>{ m.ringBrightFromChroma = v; } })));
    const eye = m.eye;
    el.appendChild(h('div', { class: 'section-title' }, 'Eye'));
    el.appendChild(fieldRow('Enable Eye', checkbox(eye.enabled !== false, (v) => { eye.enabled = v; sceneApi.setEyeEnabled(v); } )));
    el.appendChild(fieldRow('Pupil Base', slider({ min: 0.05, max: 0.6, step: 0.01, value: eye.pupilBase ?? 0.22, oninput: (v) => { eye.pupilBase = v; } })));
    el.appendChild(fieldRow('Pupil Range', slider({ min: 0.0, max: 0.7, step: 0.01, value: eye.pupilRange ?? 0.45, oninput: (v) => { eye.pupilRange = v; } })));
    el.appendChild(fieldRow('Pupil Attack (s)', slider({ min: 0.02, max: 1.0, step: 0.01, value: eye.pupilAttack ?? 0.18, oninput: (v) => { eye.pupilAttack = v; } })));
    el.appendChild(fieldRow('Pupil Release (s)', slider({ min: 0.05, max: 1.5, step: 0.01, value: eye.pupilRelease ?? 0.35, oninput: (v) => { eye.pupilRelease = v; } })));
    el.appendChild(fieldRow('Cat Aspect Max', slider({ min: 0.0, max: 1.0, step: 0.01, value: eye.catAspectMax ?? 0.65, oninput: (v) => { eye.catAspectMax = v; } })));
    el.appendChild(fieldRow('Hue Mix (chroma)', slider({ min: 0.0, max: 1.0, step: 0.02, value: eye.hueMixFromChroma ?? 0.65, oninput: (v) => { eye.hueMixFromChroma = v; } })));
    el.appendChild(fieldRow('Saturation <- Centroid', slider({ min: 0.0, max: 1.0, step: 0.02, value: eye.saturationFromCentroid ?? 0.5, oninput: (v) => { eye.saturationFromCentroid = v; } })));
    el.appendChild(fieldRow('Fiber Contrast', slider({ min: 0.2, max: 2.5, step: 0.05, value: eye.fiberContrast ?? 1.2, oninput: (v) => { eye.fiberContrast = v; } })));
    el.appendChild(fieldRow('Fiber Noise Scale', slider({ min: 0.4, max: 5.0, step: 0.1, value: eye.fiberNoiseScale ?? 3.0, oninput: (v) => { eye.fiberNoiseScale = v; } })));
    el.appendChild(fieldRow('Limbal Darkness', slider({ min: 0.0, max: 1.5, step: 0.05, value: eye.limbusDarkness ?? 0.55, oninput: (v) => { eye.limbusDarkness = v; } })));
    el.appendChild(fieldRow('Blink on Drop', checkbox(eye.blinkOnDrop !== false, (v) => { eye.blinkOnDrop = v; } )));
    el.appendChild(fieldRow('Blink Duration (ms)', slider({ min: 60, max: 400, step: 5, value: eye.blinkDurationMs ?? 150, oninput: (v) => { eye.blinkDurationMs = v; } })));
    el.appendChild(fieldRow('Random Blink Min (s)', slider({ min: 3, max: 30, step: 1, value: eye.randomBlinkMinSec ?? 12, oninput: (v) => { eye.randomBlinkMinSec = v; } })));
    el.appendChild(fieldRow('Random Blink Max (s)', slider({ min: 5, max: 45, step: 1, value: eye.randomBlinkMaxSec ?? 28, oninput: (v) => { eye.randomBlinkMaxSec = v; } })));
    el.appendChild(fieldRow('Cornea Layer', checkbox(eye.corneaEnabled !== false, (v) => { eye.corneaEnabled = v; sceneApi.setEyeCorneaEnabled(v); } )));
    el.appendChild(fieldRow('Cornea Fresnel', slider({ min: 0.2, max: 3.0, step: 0.05, value: eye.corneaFresnel ?? 1.25, oninput: (v) => { eye.corneaFresnel = v; } })));
    el.appendChild(fieldRow('Cornea Tint Mix', slider({ min: 0.0, max: 1.0, step: 0.02, value: eye.corneaTintMix ?? 0.25, oninput: (v) => { eye.corneaTintMix = v; } })));
    el.appendChild(fieldRow('Cornea Opacity', slider({ min: 0.1, max: 1.0, step: 0.02, value: eye.corneaOpacity ?? 0.65, oninput: (v) => { eye.corneaOpacity = v; } })));
    el.appendChild(fieldRow('Glint Size', slider({ min: 0.01, max: 0.1, step: 0.002, value: eye.glintSize ?? 0.035, oninput: (v) => { eye.glintSize = v; } })));
    el.appendChild(fieldRow('Glint Intensity', slider({ min: 0.0, max: 2.0, step: 0.05, value: eye.glintIntensity ?? 1.2, oninput: (v) => { eye.glintIntensity = v; } })));
    el.appendChild(fieldRow('Predator Mode', checkbox(!!sceneApi.state.eye?.predatorMode, (v) => sceneApi.setEyePredatorMode(v) )));
    el.appendChild(fieldRow('Manual Blink', button('Blink', () => sceneApi.triggerEyeBlink())));

    el.appendChild(h('div', { class: 'section-title' }, 'Shockwave Pulse'));
    el.appendChild(fieldRow('Enable', checkbox(m.shockwave.enabled !== false, (v)=>{ m.shockwave.enabled = v; } )));
    el.appendChild(fieldRow('Beat Strength', slider({ min: 0.0, max: 1.5, step: 0.05, value: m.shockwave.beatIntensity ?? 0.55, oninput: (v)=>{ m.shockwave.beatIntensity = v; } })));
    el.appendChild(fieldRow('Drop Strength', slider({ min: 0.2, max: 3.0, step: 0.05, value: m.shockwave.dropIntensity ?? 1.2, oninput: (v)=>{ m.shockwave.dropIntensity = v; } })));
    el.appendChild(fieldRow('Duration (ms)', slider({ min: 200, max: 2000, step: 20, value: m.shockwave.durationMs ?? 1200, oninput: (v)=>{ m.shockwave.durationMs = v; } })));
    el.appendChild(fieldRow('Preview Pulse', button('Trigger', ()=> sceneApi.triggerShockwave(Math.max(0.6, m.shockwave.dropIntensity ?? 1.0), m.shockwave.durationMs))));
    el.appendChild(h('div', { class: 'section-title' }, 'Chromatic Aberration'));
    el.appendChild(fieldRow('Base Offset', slider({ min: 0.0, max: 0.0025, step: 0.00005, value: m.chromatic.base ?? 0.00025, oninput: (v)=>{ m.chromatic.base = v; } })));
    el.appendChild(fieldRow('Treble Gain', slider({ min: 0.0, max: 0.0035, step: 0.00005, value: m.chromatic.treble ?? 0.0009, oninput: (v)=>{ m.chromatic.treble = v; } })));
    el.appendChild(fieldRow('Beat Boost', slider({ min: 0.0, max: 0.004, step: 0.0001, value: m.chromatic.beat ?? 0.0012, oninput: (v)=>{ m.chromatic.beat = v; } })));
    el.appendChild(fieldRow('Drop Boost', slider({ min: 0.0, max: 0.005, step: 0.0001, value: m.chromatic.drop ?? 0.0024, oninput: (v)=>{ m.chromatic.drop = v; } })));
    el.appendChild(fieldRow('Lerp Smoothness', slider({ min: 0.02, max: 0.4, step: 0.01, value: m.chromatic.lerp ?? 0.14, oninput: (v)=>{ m.chromatic.lerp = v; } })));
    // Advanced Mapping
    el.appendChild(h('div', { class: 'section-title' }, 'Advanced Mapping'));
    el.appendChild(fieldRow('Enable Advanced', checkbox(!!m.advancedMapping, (v)=>{ m.advancedMapping = v; } )));
    const triplet = (label, obj) => h('div', { class: 'row' }, [ h('div', { class: 'label' }, label), h('div', { class: 'control' }, [
      slider({ min: 0.0, max: 2.0, step: 0.05, value: obj.bass, oninput: (v)=>{ obj.bass = v; } }),
      slider({ min: 0.0, max: 2.0, step: 0.05, value: obj.mid, oninput: (v)=>{ obj.mid = v; } }),
      slider({ min: 0.0, max: 2.0, step: 0.05, value: obj.treble, oninput: (v)=>{ obj.treble = v; } }),
    ]) ]);
    el.appendChild(triplet('Size Weights (B/M/T)', m.sizeWeights));
    el.appendChild(triplet('Ring Scale Weights', m.ringScaleWeights));
    el.appendChild(triplet('Ring Speed Weights', m.ringSpeedWeights));
    el.appendChild(triplet('Core Noise Weights', m.sphereNoiseWeights));
    el.appendChild(triplet('Ring Noise Weights', m.ringNoiseWeights));
    return el;
  }

  function buildTempo() {
    const el = h('div', { class: 'section' }, [ h('div', { class: 'section-title' }, 'Tempo Assist') ]);
    el.appendChild(fieldRow('Enable', checkbox(audioEngine.tempoAssistEnabled, (v)=> audioEngine.setTempoAssistEnabled(v) )));
    el.appendChild(fieldRow('Auto BPM', h('div', { id: 'auto-bpm' }, String(audioEngine.getBpm() || 0))));
    // Live (Aubio) diagnostics for Chrome Tab / BlackHole inputs
    el.appendChild(fieldRow('Live BPM', h('div', { id: 'live-bpm' }, '0')));
    el.appendChild(fieldRow('Confidence', h('div', { id: 'live-conf' }, '0')));
    el.appendChild(button('Recalculate BPM', async ()=>{ await audioEngine.recalcBpm(); document.getElementById('auto-bpm').textContent = String(audioEngine.getBpm() || 0); }));

    const tap = h('div', { class: 'section' }, [ h('div', { class: 'section-title' }, 'Tap Tempo') ]);
    tap.appendChild(fieldRow('Tap BPM', h('div', { id: 'tap-bpm' }, '0')));
    tap.appendChild(h('div', {}, [ button('Tap', ()=>{ audioEngine.tapBeat(); document.getElementById('tap-bpm').textContent = String(audioEngine.getTapBpm()||0); }), button('Reset', ()=>{ audioEngine.resetTapTempo(); document.getElementById('tap-bpm').textContent = '0'; }) ]));
    tap.appendChild(h('div', {}, [ button('×0.5', ()=>{ audioEngine.nudgeTapMultiplier(0.5); document.getElementById('tap-bpm').textContent = String(audioEngine.getTapBpm()||0); }), button('×2', ()=>{ audioEngine.nudgeTapMultiplier(2.0); document.getElementById('tap-bpm').textContent = String(audioEngine.getTapBpm()||0); }) ]));
    tap.appendChild(fieldRow('Quantize to Tap', checkbox(audioEngine.tapQuantizeEnabled, (v)=> audioEngine.setTapQuantizeEnabled(v) )));
    tap.appendChild(h('div', {}, [ button('+10 ms', ()=> audioEngine.nudgeQuantizePhase(10)), button('-10 ms', ()=> audioEngine.nudgeQuantizePhase(-10)), button('+25 ms', ()=> audioEngine.nudgeQuantizePhase(25)), button('-25 ms', ()=> audioEngine.nudgeQuantizePhase(-25)), button('Align Now', ()=> audioEngine.alignQuantizePhase()) ]));
    el.appendChild(tap);
    return el;
  }

  function buildShader() {
    const el = h('div', { class: 'section' }, [ h('div', { class: 'section-title' }, 'Shader (Dispersion)') ]);
    const mode = sceneApi.state.params.visualMode || 'overlay';
    if (mode === 'classic') {
      el.appendChild(h('div', {}, 'Shader visuals are disabled in Classic mode. Switch Visual Mode to "3D + Dispersion" or "Dispersion only".'));
      return el;
    }
    if (mode === 'overlay') {
      el.appendChild(fieldRow('Enable Overlay', checkbox(!!sceneApi.state.params.enableDispersion, (v)=>{ sceneApi.state.params.enableDispersion = v; } )));
    }
    if (!sceneApi.state.params.dispersion || typeof sceneApi.state.params.dispersion !== 'object') {
      sceneApi.state.params.dispersion = {
        opacityBase: 0.18,
        opacityTrebleGain: 0.55,
        opacityMin: 0.12,
        opacityMax: 0.8,
        zoomGain: 28.0,
        zoomBias: -10.0,
        zoomLerp: 0.1,
        opacityLerp: 0.12,
        warpFrom: 'bass',
        warpGain: 0.8,
        warpOnBeat: true,
        warpOnDropBoost: 0.6,
        tintHue: 0.0,
        tintSat: 0.0,
        tintMix: 0.0,
        brightness: 1.0,
        brightnessGain: 0.4,
        contrast: 1.0,
        contrastGain: 0.3,
        twistBase: 0.0,
        twistMax: 0.8,
        twistBassGain: 0.6,
        twistBeatGain: 0.35,
        twistOnsetGain: 0.25,
        twistFluxGain: 0.15,
        twistStutterGain: 0.2,
        twistLerp: 0.14,
        twistFalloff: 1.2,
        stutterWindowMs: 180,
        flipOnStutter: true,
        travelBase: 0.06,
        travelGain: 0.12,
        travelBeatBoost: 0.06,
        travelDropBoost: 0.12,
        travelLerp: 0.06,
      };
    }
    const d = sceneApi.state.params.dispersion;
    el.appendChild(h('div', { class: 'section-title' }, 'Opacity'));
    el.appendChild(fieldRow('Base', slider({ min: 0.0, max: 0.8, step: 0.01, value: d.opacityBase, oninput: (v)=>{ d.opacityBase = v; } })));
    el.appendChild(fieldRow('Treble Gain', slider({ min: 0.0, max: 1.5, step: 0.01, value: d.opacityTrebleGain, oninput: (v)=>{ d.opacityTrebleGain = v; } })));
    el.appendChild(fieldRow('Min', slider({ min: 0.0, max: 0.8, step: 0.01, value: d.opacityMin, oninput: (v)=>{ d.opacityMin = v; } })));
    el.appendChild(fieldRow('Max', slider({ min: 0.1, max: 1.0, step: 0.01, value: d.opacityMax, oninput: (v)=>{ d.opacityMax = v; } })));
    el.appendChild(h('div', { class: 'section-title' }, 'Zoom'));
    el.appendChild(fieldRow('Gain', slider({ min: 0.0, max: 60.0, step: 0.5, value: d.zoomGain, oninput: (v)=>{ d.zoomGain = v; } })));
    el.appendChild(fieldRow('Bias', slider({ min: -40.0, max: 20.0, step: 0.5, value: d.zoomBias, oninput: (v)=>{ d.zoomBias = v; } })));
    el.appendChild(fieldRow('Zoom Lerp', slider({ min: 0.01, max: 0.5, step: 0.01, value: d.zoomLerp, oninput: (v)=>{ d.zoomLerp = v; } })));
    el.appendChild(fieldRow('Opacity Lerp', slider({ min: 0.01, max: 0.5, step: 0.01, value: d.opacityLerp, oninput: (v)=>{ d.opacityLerp = v; } })));
    el.appendChild(h('div', { class: 'section-title' }, 'Warp / Drive'));
    el.appendChild(fieldRow('Warp Source', select([
      { label: 'Bass', value: 'bass' },
      { label: 'Mid', value: 'mid' },
      { label: 'Treble', value: 'treble' },
      { label: 'RMS', value: 'rms' },
    ], d.warpFrom, (v)=>{ d.warpFrom = v; })));
    el.appendChild(fieldRow('Warp Gain', slider({ min: 0.0, max: 3.0, step: 0.02, value: d.warpGain, oninput: (v)=>{ d.warpGain = v; } })));
    el.appendChild(fieldRow('Pulse on Beat', checkbox(d.warpOnBeat !== false, (v)=>{ d.warpOnBeat = v; } )));
    el.appendChild(fieldRow('Drop Boost', slider({ min: 0.0, max: 2.0, step: 0.02, value: d.warpOnDropBoost, oninput: (v)=>{ d.warpOnDropBoost = v; } })));
    el.appendChild(h('div', { class: 'section-title' }, 'Color & Tone'));
    el.appendChild(fieldRow('Tint Hue', slider({ min: 0.0, max: 1.0, step: 0.01, value: d.tintHue, oninput: (v)=>{ d.tintHue = v; } })));
    el.appendChild(fieldRow('Tint Sat', slider({ min: 0.0, max: 1.0, step: 0.01, value: d.tintSat, oninput: (v)=>{ d.tintSat = v; } })));
    el.appendChild(fieldRow('Tint Mix', slider({ min: 0.0, max: 1.0, step: 0.01, value: d.tintMix, oninput: (v)=>{ d.tintMix = v; } })));
    el.appendChild(fieldRow('Brightness', slider({ min: 0.2, max: 2.5, step: 0.02, value: d.brightness, oninput: (v)=>{ d.brightness = v; } })));
    el.appendChild(fieldRow('Brightness Gain', slider({ min: 0.0, max: 2.0, step: 0.02, value: d.brightnessGain, oninput: (v)=>{ d.brightnessGain = v; } })));
    el.appendChild(fieldRow('Contrast', slider({ min: 0.2, max: 3.0, step: 0.02, value: d.contrast, oninput: (v)=>{ d.contrast = v; } })));
    el.appendChild(fieldRow('Contrast Gain', slider({ min: 0.0, max: 2.0, step: 0.02, value: d.contrastGain, oninput: (v)=>{ d.contrastGain = v; } })));
    el.appendChild(h('div', { class: 'section-title' }, 'Twist'));
    el.appendChild(fieldRow('Base', slider({ min: 0.0, max: 1.0, step: 0.01, value: d.twistBase, oninput: (v)=>{ d.twistBase = v; } })));
    el.appendChild(fieldRow('Max', slider({ min: 0.1, max: 1.5, step: 0.01, value: d.twistMax, oninput: (v)=>{ d.twistMax = v; } })));
    el.appendChild(fieldRow('Bass Gain', slider({ min: 0.0, max: 2.0, step: 0.02, value: d.twistBassGain, oninput: (v)=>{ d.twistBassGain = v; } })));
    el.appendChild(fieldRow('Beat Gain', slider({ min: 0.0, max: 1.5, step: 0.02, value: d.twistBeatGain, oninput: (v)=>{ d.twistBeatGain = v; } })));
    el.appendChild(fieldRow('Onset Gain', slider({ min: 0.0, max: 1.5, step: 0.02, value: d.twistOnsetGain, oninput: (v)=>{ d.twistOnsetGain = v; } })));
    el.appendChild(fieldRow('Flux Gain', slider({ min: 0.0, max: 1.0, step: 0.02, value: d.twistFluxGain, oninput: (v)=>{ d.twistFluxGain = v; } })));
    el.appendChild(fieldRow('Stutter Gain', slider({ min: 0.0, max: 1.0, step: 0.02, value: d.twistStutterGain, oninput: (v)=>{ d.twistStutterGain = v; } })));
    el.appendChild(fieldRow('Lerp', slider({ min: 0.02, max: 0.6, step: 0.01, value: d.twistLerp, oninput: (v)=>{ d.twistLerp = v; } })));
    el.appendChild(fieldRow('Falloff', slider({ min: 0.0, max: 3.0, step: 0.05, value: d.twistFalloff, oninput: (v)=>{ d.twistFalloff = v; } })));
    el.appendChild(fieldRow('Stutter Window (ms)', slider({ min: 80, max: 400, step: 10, value: d.stutterWindowMs, oninput: (v)=>{ d.stutterWindowMs = v; } })));
    el.appendChild(fieldRow('Flip on Stutter', checkbox(d.flipOnStutter !== false, (v)=>{ d.flipOnStutter = v; } )));
    el.appendChild(h('div', { class: 'section-title' }, 'Travel'));
    el.appendChild(fieldRow('Base Speed', slider({ min: -0.2, max: 0.4, step: 0.002, value: d.travelBase, oninput: (v)=>{ d.travelBase = v; } })));
    el.appendChild(fieldRow('Audio Gain', slider({ min: 0.0, max: 0.6, step: 0.005, value: d.travelGain, oninput: (v)=>{ d.travelGain = v; } })));
    el.appendChild(fieldRow('Beat Boost', slider({ min: 0.0, max: 0.3, step: 0.005, value: d.travelBeatBoost, oninput: (v)=>{ d.travelBeatBoost = v; } })));
    el.appendChild(fieldRow('Drop Boost', slider({ min: 0.0, max: 0.5, step: 0.005, value: d.travelDropBoost, oninput: (v)=>{ d.travelDropBoost = v; } })));
    el.appendChild(fieldRow('Lerp', slider({ min: 0.01, max: 0.3, step: 0.005, value: d.travelLerp, oninput: (v)=>{ d.travelLerp = v; } })));
    return el;
  }

  function buildPresets() {
    let BUILT_IN_PRESETS = null;
    try {
      // dynamic import to avoid breaking older environments if file missing
      // Note: import path relative to this module
      // eslint-disable-next-line no-new-func
      BUILT_IN_PRESETS = null;
    } catch (_) {}
    const el = h('div', { class: 'section' }, [ h('div', { class: 'section-title' }, 'Presets') ]);
    el.appendChild(button('Reset to Defaults', ()=> { try { window.location.reload(); } catch(_) {} }));
    el.appendChild(button('Apply Rave', ()=> {
      const preset = {
        audio: { smoothing: 0.55, lowHz: 180, midHz: 2500, beatCooldown: 350 },
        visuals: { bloomReactive: 0.8 },
        mapping: {
          sizeFromRms: 0.5,
          sphereBrightnessFromRms: 1.6,
          sphereNoiseFromMid: 1.2,
          ringScaleFromBands: 0.45,
          ringSpeedFromBands: 1.8,
          ringNoiseFromBands: 0.45,
          cameraShakeFromBeat: 0.35,
          lightIntensityFromBass: 2.4,
          ringTiltFromBass: 0.65,
          bandWeightBass: 1.4,
          bandWeightMid: 1.15,
          bandWeightTreble: 1.2,
          spherePulseFromBass: 0.95,
          sphereSparkleFromTreble: 0.8,
          starTwinkleFromTreble: 0.8,
        }
      };
      applyPreset({ mapping: preset.mapping, visuals: { bloomReactive: preset.visuals.bloomReactive }, audio: { smoothing: preset.audio.smoothing, lowHz: preset.audio.lowHz, midHz: preset.audio.midHz, beatCooldown: preset.audio.beatCooldown } });
    }));
    el.appendChild(button('Save Preset', ()=> {
      const name = prompt('Preset name'); if (!name) return;
      try {
        const preset = collectPreset();
        const all = loadAllPresets(); all[name] = preset; saveAllPresets(all); showToast('Preset saved');
      } catch(_) { showToast('Save failed'); }
    }));
    el.appendChild(button('Load Preset', ()=> {
      const all = loadAllPresets(); const names = Object.keys(all); if (!names.length) { showToast('No presets'); return; }
      const choice = prompt('Choose preset by name:\n' + names.join('\n')); if (!choice || !all[choice]) return;
      applyPreset(all[choice]); showToast('Preset loaded');
    }));
    el.appendChild(button('Export Presets', ()=> {
      const all = loadAllPresets(); const data = JSON.stringify(all, null, 2);
      const blob = new Blob([data], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'cosmic-presets.json'; a.click();
    }));
    el.appendChild(button('Import Presets', ()=> {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json';
      input.onchange = async ()=> { const f = input.files?.[0]; if (!f) return; const txt = await f.text(); try { const obj = JSON.parse(txt); const all = loadAllPresets(); saveAllPresets({ ...all, ...obj }); showToast('Imported'); } catch { showToast('Invalid JSON'); } };
      input.click();
    }));
    // Built-in preset list (if module exists)
    try {
      // Lazy import to avoid ESM resolution issues in older browsers
      import('./presets.js').then((mod) => {
        const data = mod?.BUILT_IN_PRESETS || {};
        const keys = Object.keys(data);
        if (!keys.length) return;
        el.appendChild(h('div', { class: 'section-title' }, 'Built-in'));
        const list = h('div', { class: 'section' });
        keys.forEach((name) => {
          const row = h('div', { class: 'row' }, [
            h('div', { class: 'label' }, name),
            h('div', { class: 'control' }, [
              button('Apply', ()=> applyPreset(data[name])),
              button('Default', ()=> { try { localStorage.setItem('cosmic_default_preset', name); showToast('Default preset set'); } catch(_) {} }),
            ]),
          ]);
          list.appendChild(row);
        });
        el.appendChild(list);
      }).catch(()=>{});
    } catch (_) {}

    return el;
  }

  function buildSession() {
    const el = h('div', { class: 'section' }, [ h('div', { class: 'section-title' }, 'Session') ]);
    const fpsLabel = h('div', { id: 'fps-label' }, '0');
    el.appendChild(fieldRow('FPS', fpsLabel));
    el.appendChild(fieldRow('Screenshot', button('Capture', onScreenshot)));
    if (showProjectorControls) {
      const statusSpan = h('span', { class: 'sync-pill disconnected', id: 'sync-status-pill' }, 'No link');
      syncStatusNode = statusSpan;
      const controls = h('div', { class: 'sync-actions' }, [
        statusSpan,
        button('Open Projector', () => {
          const win = syncCoordinator.openProjectorWindow();
          if (!win) showToast('Pop-up blocked. Allow pop-ups and try again.');
        }, { class: 'ghost' }),
        button('Push Now', () => {
          syncCoordinator.pushNow();
          showToast('Settings pushed to projector');
        }, { class: 'ghost' }),
      ]);
      el.appendChild(fieldRow('Projector', controls));
      const autoCheckbox = checkbox(!!syncCoordinator.autoSync, (checked) => {
        syncCoordinator.setAutoSync(checked);
        updateSyncStatus(syncCoordinator.getStatus());
        showToast(checked ? 'Auto-sync enabled' : 'Auto-sync paused');
      });
      syncAutoCheckbox = autoCheckbox;
      el.appendChild(fieldRow('Auto Sync', autoCheckbox));
      updateSyncStatus(syncCoordinator.getStatus());
    }
    return el;
  }

  function collectPreset() {
    const p = sceneApi.state.params;
    return {
      audio: { gain: audioEngine.gainNode?.gain?.value || 1, sensitivity: audioEngine.sensitivity, smoothing: audioEngine.smoothing, fftSize: audioEngine.fftSize, lowHz: audioEngine.bandSplit.low, midHz: audioEngine.bandSplit.mid, beatCooldown: audioEngine.beatCooldownMs },
      visuals: { theme: p.theme, fogDensity: p.fogDensity, bloomBase: p.bloomStrengthBase, bloomReactive: p.bloomReactiveGain, pixelRatio: p.pixelRatioCap, autoRotate: p.autoRotate, particleDensity: p.particleDensity, performanceMode: p.performanceMode, useHdrBackground: p.useHdrBackground, visualMode: p.visualMode, enableDispersion: p.enableDispersion, dispersion: p.dispersion },
      mapping: { ...p.map },
      explosion: { onBeat: p.explosion.onBeat, cooldownMs: p.explosion.cooldownMs, durationMs: sceneApi.state.explosionDuration },
    };
  }
  function loadSavedSettingsSnapshot() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn('Failed to parse saved settings snapshot', err);
      return null;
    }
  }
  function persistSettingsSnapshot(snapshot) {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(snapshot));
      return true;
    } catch (err) {
      console.error('Failed to save settings snapshot', err);
      return false;
    }
  }
  function loadAllPresets() { try { return JSON.parse(localStorage.getItem('cosmic_presets')||'{}'); } catch { return {}; } }
  function saveAllPresets(obj) { localStorage.setItem('cosmic_presets', JSON.stringify(obj)); }
  function applyPreset(p, { silent = false } = {}) {
    if (!p) return;
    try {
      if (p.visuals?.theme) sceneApi.changeTheme(p.visuals.theme);
      if (typeof p.visuals?.fogDensity === 'number') sceneApi.state.scene.fog.density = p.visuals.fogDensity;
      if (typeof p.visuals?.bloomBase === 'number') sceneApi.state.params.bloomStrengthBase = p.visuals.bloomBase;
      if (typeof p.visuals?.bloomReactive === 'number') sceneApi.state.params.bloomReactiveGain = p.visuals.bloomReactive;
      if (typeof p.visuals?.pixelRatio === 'number') sceneApi.setPixelRatioCap(p.visuals.pixelRatio);
      if (typeof p.visuals?.autoRotate === 'number') sceneApi.state.params.autoRotate = p.visuals.autoRotate;
      if (typeof p.visuals?.particleDensity === 'number') { sceneApi.state.params.particleDensity = p.visuals.particleDensity; sceneApi.rebuildParticles(); }
      if (typeof p.visuals?.useHdrBackground === 'boolean') { sceneApi.state.params.useHdrBackground = p.visuals.useHdrBackground; sceneApi.changeTheme(sceneApi.state.params.theme); }
      if (typeof p.visuals?.visualMode === 'string') { sceneApi.state.params.visualMode = p.visuals.visualMode; if (typeof sceneApi.setVisualMode === 'function') sceneApi.setVisualMode(p.visuals.visualMode); }
      if (typeof p.visuals?.enableDispersion === 'boolean') sceneApi.state.params.enableDispersion = p.visuals.enableDispersion;
      if (p.visuals?.dispersion && typeof p.visuals.dispersion === 'object') sceneApi.state.params.dispersion = { ...sceneApi.state.params.dispersion, ...p.visuals.dispersion };

      if (p.audio) {
        if (typeof p.audio.gain === 'number') audioEngine.setGain(p.audio.gain);
        if (typeof p.audio.sensitivity === 'number') audioEngine.setSensitivity(p.audio.sensitivity);
        if (typeof p.audio.smoothing === 'number') audioEngine.setSmoothing(p.audio.smoothing);
        if (typeof p.audio.fftSize === 'number') audioEngine.setFFTSize(p.audio.fftSize);
        if (typeof p.audio.lowHz === 'number' && typeof p.audio.midHz === 'number') audioEngine.setBandSplit(p.audio.lowHz, p.audio.midHz);
        if (typeof p.audio.beatCooldown === 'number') audioEngine.setBeatCooldown(p.audio.beatCooldown);
        if (typeof p.audio.subHz === 'number') audioEngine.setSubHz(p.audio.subHz);
        if (typeof p.audio.envAttack === 'number') audioEngine.setEnvAttack(p.audio.envAttack);
        if (typeof p.audio.envRelease === 'number') audioEngine.setEnvRelease(p.audio.envRelease);
        if (typeof p.audio.agcEnabled === 'boolean') audioEngine.setBandAgcEnabled(p.audio.agcEnabled);
        if (typeof p.audio.agcDecay === 'number') audioEngine.setBandAgcDecay(p.audio.agcDecay);
        if (p.audio.drop) {
          if (typeof p.audio.drop.enabled === 'boolean') audioEngine.setDropEnabled(p.audio.drop.enabled);
          if (typeof p.audio.drop.flux === 'number') audioEngine.setDropFluxThresh(p.audio.drop.flux);
          if (typeof p.audio.drop.bass === 'number') audioEngine.setDropBassThresh(p.audio.drop.bass);
          if (typeof p.audio.drop.centroidSlope === 'number') audioEngine.setDropCentroidSlopeThresh(p.audio.drop.centroidSlope);
          if (typeof p.audio.drop.minBeats === 'number') audioEngine.setDropMinBeats(p.audio.drop.minBeats);
          if (typeof p.audio.drop.cooldownMs === 'number') audioEngine.setDropCooldownMs(p.audio.drop.cooldownMs);
        }
      }

      if (p.mapping) Object.assign(sceneApi.state.params.map, p.mapping);
      if (p.explosion) {
        if (typeof p.explosion.onBeat === 'boolean') sceneApi.state.params.explosion.onBeat = p.explosion.onBeat;
        if (typeof p.explosion.cooldownMs === 'number') sceneApi.state.params.explosion.cooldownMs = p.explosion.cooldownMs;
        if (typeof p.explosion.durationMs === 'number') sceneApi.state.explosionDuration = p.explosion.durationMs;
      }
      if (!silent) showToast('Preset applied');
    } catch(err) {
      if (!silent) showToast('Apply failed');
      console.error('Failed to apply preset', err);
    }
  }

  function buildQuick() {
    const el = h('div', { class: 'section' }, [ h('div', { class: 'section-title' }, 'Quick') ]);
    el.appendChild(buildAudio());
    el.appendChild(buildVisuals());
    return el;
  }

  const builders = {
    quick: buildQuick,
    source: buildSource,
    audio: buildAudio,
    visuals: buildVisuals,
    shader: buildShader,
    mapping: buildMapping,
    tempo: buildTempo,
    presets: buildPresets,
    session: buildSession,
  };

  function render(tabId = 'quick') {
    const mode = sceneApi.state.params.visualMode || 'overlay';
    const visibleTabs = tabs.filter((t) => {
      if (t.id === 'visuals') return mode !== 'shader-only';
      if (t.id === 'mapping') return mode !== 'shader-only';
      if (t.id === 'shader') return mode !== 'classic';
      return true;
    });
    if (!visibleTabs.some(t => t.id === tabId)) tabId = visibleTabs[0]?.id || 'quick';
    tabsEl.replaceChildren();
    for (const t of visibleTabs) {
      const b = h('button', { class: 'tab' + (t.id === tabId ? ' active' : ''), onClick: ()=> render(t.id) }, t.label);
      tabsEl.appendChild(b);
    }
    content.replaceChildren();
    const builder = builders[tabId];
    Promise.resolve(builder()).then((node) => { content.appendChild(node); });
  }

  btnReset.addEventListener('click', ()=> { try { window.location.reload(); } catch(_) {} });
  btnSaveSettings.addEventListener('click', ()=> {
    const snapshot = collectPreset();
    if (persistSettingsSnapshot(snapshot)) showToast('Settings saved'); else showToast('Save failed');
  });
  btnSavePreset.addEventListener('click', ()=> {
    const name = prompt('Preset name'); if (!name) return;
    const preset = collectPreset(); const all = loadAllPresets(); all[name] = preset; saveAllPresets(all); showToast('Preset saved');
  });

  // Factory reset / startup overrides via query params
  // ?reset or ?factory -> clear saved settings and skip auto-apply
  // ?preset=Name -> apply a built-in preset by name on load
  const qs = new URLSearchParams(location.search || '');
  const doFactoryReset = qs.has('reset') || qs.has('factory');
  if (doFactoryReset) {
    try {
      localStorage.removeItem('cosmic_saved_settings');
      localStorage.removeItem('cosmic_default_preset');
      // keep user presets unless ?factory was used
      if (qs.has('factory')) localStorage.removeItem('cosmic_presets');
    } catch(_) {}
  }

  if (!doFactoryReset) {
    const savedSettings = loadSavedSettingsSnapshot();
    if (savedSettings) applyPreset(savedSettings, { silent: true });
    try {
      const defName = localStorage.getItem('cosmic_default_preset');
      if (defName) {
        import('./presets.js').then((mod) => {
          const p = mod?.BUILT_IN_PRESETS?.[defName];
          if (p) applyPreset(p, { silent: true });
        }).catch(()=>{});
      }
    } catch(_) {}
  }

  // Optional preset apply via URL (?preset=Rave%20161)
  try {
    const presetName = qs.get('preset');
    if (presetName) {
      import('./presets.js').then((mod) => {
        const p = mod?.BUILT_IN_PRESETS?.[presetName];
        if (p) applyPreset(p, { silent: true });
      }).catch(()=>{});
    }
  } catch(_) {}

  render('quick');

  // external labels update (FPS etc.)
  function updateFpsLabel(v) {
    const n = document.getElementById('fps-label'); if (n) n.textContent = String(Math.round(v));
  }
  function updateBpmLabel(bpm) {
    const n = document.getElementById('auto-bpm');
    if (n) n.textContent = String(Math.round(bpm || 0));
  }
  function updateTapAndDrift({ tapBpm, bpm }) {
    const t = document.getElementById('tap-bpm');
    if (t && typeof tapBpm === 'number') t.textContent = String(Math.round(tapBpm || 0));
    const a = document.getElementById('auto-bpm');
    if (a && typeof bpm === 'number') a.textContent = String(Math.round(bpm || 0));
  }
  function updateDriftDetails({ tapBpm, beatGrid, aubioTempo, aubioConf }) {
    const lb = document.getElementById('live-bpm');
    if (lb && typeof aubioTempo === 'number') lb.textContent = String(Math.round(aubioTempo || 0));
    const lc = document.getElementById('live-conf');
    if (lc && typeof aubioConf === 'number') lc.textContent = (aubioConf || 0).toFixed(2);
  }
  function updateSyncStatus(status = {}) {
    if (!showProjectorControls) return;
    const node = (syncStatusNode && typeof document !== 'undefined' && document.body.contains(syncStatusNode))
      ? syncStatusNode
      : document.getElementById('sync-status-pill');
    const now = Date.now();
    const connected = !!status.connected;
    const auto = status.autoSync !== false;
    if (node) {
      let label = connected ? 'Connected' : 'No link';
      let tone = connected ? 'connected' : 'disconnected';
      const lastFeatures = typeof status.lastFeaturesAt === 'number' ? status.lastFeaturesAt : 0;
      const lastHeartbeat = typeof status.lastHeartbeatAt === 'number' ? status.lastHeartbeatAt : 0;
      if (connected) {
        if (lastFeatures > 0) {
          const ageMs = Math.max(0, now - lastFeatures);
          if (ageMs > 1800) {
            label = 'Connected (idle)';
          } else {
            const ageSec = Math.round(ageMs / 100) / 10;
            label = `Connected (${ageSec.toFixed(1)}s)`;
          }
        }
      } else if (lastHeartbeat > 0) {
        tone = 'pending';
        const ageSec = Math.max(0, Math.round((now - lastHeartbeat) / 1000));
        label = ageSec > 0 ? `Reconnecting (${ageSec}s)` : 'Reconnecting';
      }
      if (!auto) label += ' - Manual';
      node.className = `sync-pill ${tone}`;
      node.textContent = label;
      syncStatusNode = node;
    }
    if (syncAutoCheckbox) {
      syncAutoCheckbox.checked = auto;
    }
  }

  return { open, close, updateFpsLabel, updateBpmLabel, updateTapAndDrift, updateDriftDetails, updateSyncStatus };
}
