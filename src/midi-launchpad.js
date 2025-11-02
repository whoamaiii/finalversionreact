/**
 * Launchpad Web MIDI integration (minimal, no external deps)
 *
 * Goals:
 * - Connect to any MIDI device whose name contains "Launchpad"
 * - MIDI Learn for a small set of actions (pad1..pad5, panic, perf toggle, intensity up/down)
 * - Forward actions to PerformanceController locally and broadcast via SyncCoordinator
 * - Provide lightweight LED feedback on learned pads (best-effort; works on MK1 and newer)
 */

const STORAGE_KEY = 'reactive_midi_bindings_v1';
const LED_BLINK_DURATION_MS = 140; // Duration of LED blink feedback

function readJson(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function bindingToString(binding) {
  if (!binding || typeof binding.number !== 'number') return '—';
  const ch = (typeof binding.channel === 'number' ? binding.channel + 1 : 1);
  if (binding.type === 'note') return `Note ${binding.number} (ch ${ch})`;
  if (binding.type === 'cc') return `CC ${binding.number} (ch ${ch})`;
  return '—';
}

function prettyDeviceLabel(input, output) {
  const inName = input?.name || 'None';
  const outName = output?.name || 'None';
  return inName === outName ? inName : `${inName} / ${outName}`;
}

function isNoteOn(status, data2) {
  return (status & 0xF0) === 0x90 && data2 > 0;
}
function isNoteOff(status, data2) {
  return ((status & 0xF0) === 0x80) || ((status & 0xF0) === 0x90 && data2 === 0);
}
function isCc(status) {
  return (status & 0xF0) === 0xB0;
}

function descriptorForMessage(status, data1) {
  if ((status & 0xF0) === 0x90 || (status & 0xF0) === 0x80) {
    return { type: 'note', number: data1, channel: (status & 0x0F) };
  }
  if ((status & 0xF0) === 0xB0) {
    return { type: 'cc', number: data1, channel: (status & 0x0F) };
  }
  return null;
}

function sameBinding(a, b) {
  if (!a || !b) return false;
  return a.type === b.type && a.number === b.number && (a.channel === b.channel);
}

export class LaunchpadMIDI {
  constructor({ pads, sceneApi, sync } = {}) {
    this.pads = pads || null;
    this.sceneApi = sceneApi || null;
    this.sync = sync || null;
    this.bindings = readJson(STORAGE_KEY, {});
    this.learningAction = null;
    this.access = null;
    this.input = null;
    this.output = null;
    this._statusHandler = null;
    this._onMidiMessage = this._onMidiMessage.bind(this);
    this._ackTimers = new Set(); // Store timeout IDs for cleanup
    // Ephemeral effect shots driven directly by MIDI
    this._shots = {
      portal: 0,
      pullback: 0,
      rift: 0,
      blackout: 0,
      flare: 0,
    };
    this._hold = { vortex: false };
    this._stutterSeq = []; // array of endTimes for pulses
  }

  get isSupported() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  getStatus() {
    return {
      supported: this.isSupported,
      connected: !!(this.input && this.output),
      learning: this.learningAction || null,
      deviceLabel: prettyDeviceLabel(this.input, this.output),
      numBindings: Object.keys(this.bindings || {}).length,
    };
  }

  onStatus(handler) {
    this._statusHandler = typeof handler === 'function' ? handler : null;
    this._emitStatus();
  }

  _emitStatus() {
    try { this._statusHandler && this._statusHandler(this.getStatus()); } catch (_) {}
  }

  async connect() {
    if (!this.isSupported) { this._emitStatus(); return false; }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      const inputs = Array.from(this.access.inputs.values());
      const outputs = Array.from(this.access.outputs.values());
      const pick = (list) => list.find((d) => /launchpad/i.test(d.name || '')) || list[0] || null;
      this.input = pick(inputs);
      this.output = pick(outputs);
      if (this.input) this.input.onmidimessage = this._onMidiMessage;
      this._emitStatus();
      return !!(this.input && this.output);
    } catch (err) {
      console.warn('MIDI connect failed', err);
      this._emitStatus();
      return false;
    }
  }

  disconnect() {
    // Clear output first to prevent _ackLearn from creating new timers during cleanup
    const savedOutput = this.output;
    this.output = null;

    // Clear input handler
    try { if (this.input) this.input.onmidimessage = null; } catch (_) {}
    this.input = null;

    // Clear all pending timers to prevent race conditions
    // Create a copy to avoid modification during iteration
    const timersToClean = new Set(this._ackTimers);
    // Clear the set first to prevent callbacks from trying to modify it
    this._ackTimers.clear();
    // Now clear all the timeouts
    timersToClean.forEach(timerId => clearTimeout(timerId));

    this._emitStatus();
  }

  startLearn(actionKey) {
    if (!actionKey) return false;
    this.learningAction = actionKey;
    this._emitStatus();
    return true;
  }

  clearBindings() {
    this.bindings = {};
    writeJson(STORAGE_KEY, this.bindings);
    this._emitStatus();
  }

  getBindings() { return { ...(this.bindings || {}) }; }
  describeBinding(binding) { return bindingToString(binding); }
  blink(actionKey) { const b = this.bindings?.[actionKey]; if (b) this._ackLearn(b); }

  _ackLearn(binding) {
    if (!binding || !this.output) return;

    // Don't create new timers if we're disconnecting or already disconnected
    if (!this._ackTimers || !Array.isArray(this._ackTimers)) return;

    try {
      const channel = binding.channel || 0;
      if (binding.type === 'note') {
        this.output.send([0x90 | (channel & 0x0F), binding.number, 127]);
        const timerId = setTimeout(() => {
          // Double-check we're still connected
          if (this.output && this._ackTimers instanceof Set) {
            try {
              this.output.send([0x90 | (channel & 0x0F), binding.number, 0]);
            } catch (_) {}
            // Remove timer from set
            this._ackTimers.delete(timerId);
          }
        }, LED_BLINK_DURATION_MS);

        // Only add timer if we're still connected
        if (this._ackTimers instanceof Set) {
          this._ackTimers.add(timerId);
        } else {
          // If we disconnected before adding, clear the timer immediately
          clearTimeout(timerId);
        }
      } else if (binding.type === 'cc') {
        this.output.send([0xB0 | (channel & 0x0F), binding.number, 127]);
        const timerId = setTimeout(() => {
          // Double-check we're still connected
          if (this.output && this._ackTimers instanceof Set) {
            try {
              this.output.send([0xB0 | (channel & 0x0F), binding.number, 0]);
            } catch (_) {}
            // Remove timer from set
            this._ackTimers.delete(timerId);
          }
        }, LED_BLINK_DURATION_MS);

        // Only add timer if we're still connected
        if (this._ackTimers instanceof Set) {
          this._ackTimers.add(timerId);
        } else {
          // If we disconnected before adding, clear the timer immediately
          clearTimeout(timerId);
        }
      }
    } catch (_) {}
  }

  _led(binding, on) {
    if (!binding || !this.output) return;
    try {
      const channel = binding.channel || 0;
      const value = on ? 127 : 0; // simple green on/off on MK1
      if (binding.type === 'note') {
        this.output.send([0x90 | (channel & 0x0F), binding.number, value]);
      } else if (binding.type === 'cc') {
        this.output.send([0xB0 | (channel & 0x0F), binding.number, value]);
      }
    } catch (_) {}
  }

  _handleAction(actionKey, pressed) {
    const now = performance.now ? performance.now() : Date.now();
    const sendPad = (evt) => { try { this.pads?._handleRemotePadEvent?.(evt); } catch (_) {} try { this.sync?.sendPadEvent?.(evt); } catch (_) {} };
    // Performance pads (geometry/shader deltas)
    if (actionKey === 'panic') {
      if (pressed) try { this.pads?.panic?.(); } catch (_) {}
      return;
    }
    // New macro actions (big looks)
    if (actionKey === 'portalSlam' && pressed) { this._shots.portal = now + 420; this._ackLearn(this.bindings.portalSlam); return; }
    if (actionKey === 'pullbackVortex' && pressed) { this._shots.pullback = now + 420; this._ackLearn(this.bindings.pullbackVortex); return; }
    if (actionKey === 'chromaticRift' && pressed) { this._shots.rift = now + 420; this._ackLearn(this.bindings.chromaticRift); return; }
    if (actionKey === 'echoStutter' && pressed) { this._stutterSeq = [now + 160, now + 320, now + 480]; this._ackLearn(this.bindings.echoStutter); return; }
    if (actionKey === 'blackout' && pressed) { this._shots.blackout = now + 420; this._ackLearn(this.bindings.blackout); return; }
    if (actionKey === 'solarFlare' && pressed) { try { this.sceneApi.triggerShockwave?.(1.25); } catch (_) {} this._shots.flare = now + 380; this._ackLearn(this.bindings.solarFlare); return; }
    if (actionKey === 'vortexHold') { this._hold.vortex = !!pressed; this._led(this.bindings.vortexHold, pressed); return; }
  }

  _onMidiMessage(e) {
    const data = e?.data;
    if (!data || data.length < 2) return;
    const status = data[0] || 0; const d1 = data[1] || 0; const d2 = data[2] || 0;
    const binding = descriptorForMessage(status, d1);
    if (!binding) return;

    if (this.learningAction) {
      this.bindings[this.learningAction] = binding;
      writeJson(STORAGE_KEY, this.bindings);
      const learned = this.learningAction;
      this.learningAction = null;
      this._emitStatus();
      this._ackLearn(binding);
      console.log('[MIDI] Learned', learned, binding);
      return;
    }

    let pressed = false;
    if (isNoteOn(status, d2)) pressed = true; else if (isNoteOff(status, d2)) pressed = false; else if (isCc(status)) pressed = d2 > 0; else return;

    const actions = Object.keys(this.bindings);
    for (let i = 0; i < actions.length; i += 1) {
      const key = actions[i];
      if (sameBinding(this.bindings[key], binding)) {
        this._handleAction(key, pressed);
        break;
      }
    }
  }

  // Provide additional per-frame deltas to merge with PerformanceController
  getDeltas() {
    const now = performance.now ? performance.now() : Date.now();
    const out = {};
    const env = (t0, dur = 360) => {
      if (now >= t0) return 0;  // Effect has expired (now has passed the end time)
      const remaining = t0 - now;  // Time until effect ends
      // Only activate if we're within the effect window (not before it starts)
      if (remaining > dur) return 0;  // Haven't started yet
      const elapsed = dur - remaining;  // Time since effect started
      const t = Math.max(0, Math.min(1, elapsed / Math.max(1, dur)));  // Clamp to [0, 1]
      return Math.sin(Math.PI * t);
    };
    // Portal Slam — big forward zoom, travel, warp, brightness, centering
    const ePortal = env(this._shots.portal, 420);
    if (ePortal > 0) {
      out.dispersionZoom = (out.dispersionZoom || 0) + 14.0 * ePortal;
      out.dispersionTravelBoost = (out.dispersionTravelBoost || 0) + 0.65 * ePortal;
      out.dispersionWarp = (out.dispersionWarp || 0) + 1.2 * ePortal;
      out.dispersionBrightnessBoost = (out.dispersionBrightnessBoost || 0) + 0.35 * ePortal;
      out.centering = Math.max(out.centering || 0, 1.0);
    }
    // Pullback Vortex — hard zoom out + twist spike
    const ePull = env(this._shots.pullback, 420);
    if (ePull > 0) {
      out.dispersionZoom = (out.dispersionZoom || 0) - 12.0 * ePull;
      out.dispersionTwistBoost = (out.dispersionTwistBoost || 0) + 1.4 * ePull;
      out.dispersionBrightnessBoost = (out.dispersionBrightnessBoost || 0) - 0.15 * ePull;
    }
    // Chromatic Rift — heavy chromatic + opacity + warp
    const eRift = env(this._shots.rift, 420);
    if (eRift > 0) {
      out.chromatic = (out.chromatic || 0) + 0.0032 * eRift;
      out.dispersionOpacityBoost = (out.dispersionOpacityBoost || 0) + 0.42 * eRift;
      out.dispersionWarp = (out.dispersionWarp || 0) + 0.7 * eRift;
    }
    // Echo Stutter — triple zoom pulses
    if (Array.isArray(this._stutterSeq) && this._stutterSeq.length) {
      let k = 0;
      this._stutterSeq = this._stutterSeq.filter((t) => t > now);
      for (const t of this._stutterSeq) k += env(t, 160);
      if (k > 0) {
        out.dispersionZoom = (out.dispersionZoom || 0) + 9.0 * k;
        out.dispersionTravelBoost = (out.dispersionTravelBoost || 0) + 0.32 * k;
        out.centering = Math.max(out.centering || 0, 0.8);
      }
    }
    // Blackout Gate — crush brightness & pull back slightly
    const eBlack = env(this._shots.blackout, 420);
    if (eBlack > 0) {
      out.dispersionBrightnessBoost = (out.dispersionBrightnessBoost || 0) - 1.1 * eBlack;
      out.dispersionZoom = (out.dispersionZoom || 0) - 6.0 * eBlack;
    }
    // Solar Flare — shockwave companion: bright + chroma
    const eFlare = env(this._shots.flare, 380);
    if (eFlare > 0) {
      out.dispersionBrightnessBoost = (out.dispersionBrightnessBoost || 0) + 0.5 * eFlare;
      out.chromatic = (out.chromatic || 0) + 0.0022 * eFlare;
      out.dispersionWarp = (out.dispersionWarp || 0) + 0.6 * eFlare;
    }
    // Vortex Hold — sustained twist while pressed
    if (this._hold.vortex) {
      out.dispersionTwistBoost = (out.dispersionTwistBoost || 0) + 1.1;
      out.dispersionTravelBoost = (out.dispersionTravelBoost || 0) + 0.12;
    }
    return Object.keys(out).length ? out : null;
  }
}

export default LaunchpadMIDI;


