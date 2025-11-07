/**
 * StateSnapshot - Captures complete application state for crash recovery
 * 
 * This class provides a comprehensive snapshot of the entire application state,
 * including presets, audio settings, UI state, performance metrics, and session metadata.
 * Designed for seamless crash recovery - like Apple's Time Machine for live VJ shows.
 */

import { capturePresetSnapshot } from './preset-io.js';

const SNAPSHOT_VERSION = 1;

/**
 * StateSnapshot class - captures and restores complete application state
 */
export class StateSnapshot {
  constructor(data = {}) {
    this.version = data.version || SNAPSHOT_VERSION;
    this.timestamp = data.timestamp || Date.now();
    this.tags = new Set(data.tags || []);
    this.bookmarkLabel = data.bookmarkLabel || null;
    
    // Core state
    this.preset = data.preset || null; // { id, name, snapshot }
    this.audioSource = data.audioSource || null; // { type: 'mic'|'system'|'file', deviceId, deviceLabel }
    this.uiState = data.uiState || {}; // { settingsOpen, activeTab, etc. }
    this.performanceState = data.performanceState || {}; // { qualityLevel, fpsHistory }
    
    // Session metadata
    this.sessionMetadata = data.sessionMetadata || {
      startTime: this.timestamp,
      totalRuntime: 0,
      lastActivity: this.timestamp,
    };
  }

  /**
   * Capture current application state
   * @param {Object} context - Application context objects
   * @param {Object} context.sceneApi - Scene API
   * @param {Object} context.audioEngine - Audio engine
   * @param {Object} context.presetManager - Preset manager
   * @param {Object} context.uiState - Current UI state
   * @param {Object} context.performanceState - Performance metrics
   * @param {Array<string>} tags - Tags to mark this snapshot (e.g., 'preset-change', 'pre-crash')
   * @returns {StateSnapshot}
   */
  static capture(context, tags = []) {
    const { sceneApi, audioEngine, presetManager, uiState = {}, performanceState = {} } = context;
    
    if (!sceneApi || !audioEngine) {
      throw new Error('StateSnapshot.capture requires sceneApi and audioEngine');
    }

    const snapshot = new StateSnapshot({
      timestamp: Date.now(),
      tags: Array.isArray(tags) ? tags : [],
    });

    // Capture preset state
    const activePresetId = presetManager?.activePresetId || null;
    if (activePresetId && presetManager) {
      const preset = presetManager.getPreset(activePresetId);
      if (preset) {
        snapshot.preset = {
          id: preset.id,
          name: preset.name,
          // Store full snapshot for recovery
          snapshot: capturePresetSnapshot({ sceneApi, audioEngine }),
        };
      }
    }

    // Capture audio source
    snapshot.audioSource = StateSnapshot._captureAudioSource(audioEngine);

    // Capture UI state
    snapshot.uiState = {
      settingsOpen: uiState.settingsOpen || false,
      activeTab: uiState.activeTab || null,
      ...uiState,
    };

    // Capture performance state
    snapshot.performanceState = {
      qualityLevel: performanceState.qualityLevel || null,
      fpsHistory: performanceState.fpsHistory || [],
      ...performanceState,
    };

    // Update session metadata
    if (context.sessionStartTime) {
      snapshot.sessionMetadata = {
        startTime: context.sessionStartTime,
        totalRuntime: Date.now() - context.sessionStartTime,
        lastActivity: Date.now(),
      };
    }

    return snapshot;
  }

  /**
   * Capture audio source information
   * @private
   */
  static _captureAudioSource(audioEngine) {
    if (!audioEngine) return null;

    // Try to determine current audio source
    const source = audioEngine.source;
    if (!source || typeof source !== 'object') return null;

    // Bug fix #13: Add defensive null checks to prevent TypeErrors
    // Check if it's a MediaStream (mic/system audio)
    if (source.mediaStream && typeof source.mediaStream === 'object') {
      const stream = source.mediaStream;

      // Verify stream has getAudioTracks method before calling
      if (typeof stream.getAudioTracks === 'function') {
        const tracks = stream.getAudioTracks();
        const track = tracks?.[0];

        if (track && typeof track.getSettings === 'function') {
          try {
            const settings = track.getSettings();
            return {
              type: 'mic', // Could be mic or system audio
              deviceId: settings?.deviceId || null,
              deviceLabel: track.label || null,
            };
          } catch (err) {
            console.warn('[StateSnapshot] Failed to get track settings:', err);
          }
        }
      }
    }

    // Check if it's an AudioBufferSourceNode (file)
    if (source.buffer && typeof source.buffer === 'object') {
      return {
        type: 'file',
        deviceId: null,
        deviceLabel: null,
      };
    }

    // Fallback: check localStorage for stored device ID
    try {
      const storedDeviceId = localStorage.getItem('cosmic_mic_device_id');
      if (storedDeviceId) {
        return {
          type: 'mic',
          deviceId: storedDeviceId,
          deviceLabel: null,
        };
      }
    } catch (_) {
      // localStorage access failed
    }

    return null;
  }

  /**
   * Serialize snapshot to JSON
   * @returns {string} JSON string
   */
  serialize() {
    const data = {
      version: this.version,
      timestamp: this.timestamp,
      tags: Array.from(this.tags),
      bookmarkLabel: this.bookmarkLabel,
      preset: this.preset,
      audioSource: this.audioSource,
      uiState: this.uiState,
      performanceState: this.performanceState,
      sessionMetadata: this.sessionMetadata,
    };
    return JSON.stringify(data);
  }

  /**
   * Deserialize snapshot from JSON
   * @param {string} json - JSON string
   * @returns {StateSnapshot}
   */
  static deserialize(json) {
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      return new StateSnapshot(data);
    } catch (err) {
      console.error('[StateSnapshot] Failed to deserialize:', err);
      throw new Error('Invalid snapshot data');
    }
  }

  /**
   * Compress snapshot (placeholder for future LZ-string integration)
   * For now, just returns the serialized JSON
   * @returns {string} Compressed string
   */
  compress() {
    const serialized = this.serialize();
    // TODO: Add LZ-string compression when library is available
    // For now, return as-is (compression can be added later)
    return serialized;
  }

  /**
   * Decompress snapshot
   * @param {string} compressed - Compressed string
   * @returns {StateSnapshot}
   */
  static decompress(compressed) {
    // TODO: Add LZ-string decompression when library is available
    // For now, assume it's just JSON
    return StateSnapshot.deserialize(compressed);
  }

  /**
   * Get human-readable description
   * @returns {string}
   */
  getDescription() {
    const parts = [];
    if (this.bookmarkLabel) {
      parts.push(`Bookmark: ${this.bookmarkLabel}`);
    }
    if (this.preset?.name) {
      parts.push(`Preset: ${this.preset.name}`);
    }
    if (this.audioSource?.type) {
      parts.push(`Audio: ${this.audioSource.type}`);
    }
    return parts.join(' | ') || 'Empty snapshot';
  }

  /**
   * Get time since snapshot (human-readable)
   * @returns {string}
   */
  getTimeAgo() {
    const ms = Date.now() - this.timestamp;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return `${seconds}s ago`;
  }

  /**
   * Check if snapshot has a specific tag
   * @param {string} tag - Tag to check
   * @returns {boolean}
   */
  hasTag(tag) {
    return this.tags.has(tag);
  }

  /**
   * Add a tag to the snapshot
   * @param {string} tag - Tag to add
   */
  addTag(tag) {
    this.tags.add(tag);
  }

  /**
   * Remove a tag from the snapshot
   * @param {string} tag - Tag to remove
   */
  removeTag(tag) {
    this.tags.delete(tag);
  }
}

