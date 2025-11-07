/**
 * AutoSaveCoordinator - Manages automatic state snapshot saving
 * 
 * Implements smart save triggers:
 * - Time-based: Every 5 seconds during active use
 * - Event-based: After preset change, audio source switch, MIDI mapping change
 * - Idle detection: Stop saving if no activity for 5 minutes
 * 
 * Features:
 * - Debouncing to prevent save storms
 * - Throttling (max 1 save per second)
 * - Background saving (non-blocking)
 */

import { StateSnapshot } from './state-snapshot.js';
import { SessionPersistence } from '../storage/sessionPersistence.js';
import { SnapshotHistory } from './snapshotHistory.js';

const SAVE_INTERVAL_MS = 5000; // Save every 5 seconds during active use
const IDLE_THRESHOLD_MS = 300000; // 5 minutes of inactivity
const MAX_SAVE_FREQUENCY_MS = 1000; // Max 1 save per second
const DEBOUNCE_MS = 200; // Debounce rapid changes

export class AutoSaveCoordinator {
  constructor(context, options = {}) {
    this.context = context;
    this.persistence = new SessionPersistence(options.storage);
    this.history = new SnapshotHistory(options.storage);
    
    // State tracking
    this._lastSaveTime = 0;
    this._lastActivityTime = Date.now();
    this._pendingSave = null;
    this._isSaving = false;
    this._saveIntervalId = null;
    this._isIdle = false;
    
    // Event listeners
    this._listeners = new Map();
    
    // Performance tracking
    this._saveCount = 0;
    this._saveErrors = 0;
  }

  /**
   * Start auto-saving
   */
  start() {
    if (this._saveIntervalId) return; // Already started
    
    // Start periodic saves
    this._saveIntervalId = setInterval(() => {
      this._checkAndSave();
    }, SAVE_INTERVAL_MS);
    
    // Track activity
    this._trackActivity();
    
    console.log('[AutoSaveCoordinator] Started');
  }

  /**
   * Stop auto-saving
   */
  stop() {
    if (this._saveIntervalId) {
      clearInterval(this._saveIntervalId);
      this._saveIntervalId = null;
    }
    
    // Save final snapshot before stopping
    this.saveNow('shutdown');
    
    // Remove event listeners
    this._removeEventListeners();
    
    console.log('[AutoSaveCoordinator] Stopped');
  }

  /**
   * Save immediately (with debouncing)
   * @param {string} reason - Reason for save (for logging)
   * @param {Array<string>} tags - Tags to add to snapshot
   */
  saveNow(reason = 'manual', tags = []) {
    const now = Date.now();
    
    // Throttle: Don't save more than once per second
    if (now - this._lastSaveTime < MAX_SAVE_FREQUENCY_MS) {
      // Schedule a debounced save instead
      this._scheduleDebouncedSave(reason, tags);
      return;
    }
    
    // Clear any pending debounced save
    if (this._pendingSave) {
      clearTimeout(this._pendingSave);
      this._pendingSave = null;
    }
    
    this._performSave(reason, tags);
  }

  /**
   * Schedule a debounced save
   * @private
   */
  _scheduleDebouncedSave(reason, tags) {
    if (this._pendingSave) {
      clearTimeout(this._pendingSave);
    }
    
    this._pendingSave = setTimeout(() => {
      this._pendingSave = null;
      this._performSave(reason, tags);
    }, DEBOUNCE_MS);
  }

  /**
   * Perform the actual save operation
   * @private
   */
  async _performSave(reason, tags = []) {
    if (this._isSaving) return; // Already saving
    
    const now = Date.now();
    
    // Check if we're idle
    if (now - this._lastActivityTime > IDLE_THRESHOLD_MS) {
      if (!this._isIdle) {
        this._isIdle = true;
        console.log('[AutoSaveCoordinator] Entered idle mode (no saves)');
      }
      return; // Don't save when idle
    }
    
    this._isIdle = false;
    this._isSaving = true;
    this._lastActivityTime = now;
    
    try {
      const startTime = performance.now();
      
      // Capture snapshot
      const snapshot = StateSnapshot.capture(this.context, tags);
      
      // Compress
      const compressed = snapshot.compress();
      
      // Save atomically
      const success = this.persistence.save(compressed);
      
      if (success) {
        this._lastSaveTime = now;
        this._saveCount++;
        
        // Add to history (except for very frequent periodic saves)
        if (reason !== 'periodic' || this._saveCount % 3 === 0) {
          // Only add every 3rd periodic save to history to avoid flooding
          try {
            this.history.add(snapshot, { bookmark: false });
          } catch (err) {
            console.warn('[AutoSaveCoordinator] Failed to add to history:', err);
          }
        }
        
        const duration = performance.now() - startTime;
        if (duration > 50) {
          console.warn(`[AutoSaveCoordinator] Save took ${duration.toFixed(1)}ms (slow)`);
        }
      } else {
        this._saveErrors++;
        console.warn('[AutoSaveCoordinator] Save failed');
      }
    } catch (err) {
      this._saveErrors++;
      console.error('[AutoSaveCoordinator] Save error:', err);
    } finally {
      this._isSaving = false;
    }
  }

  /**
   * Check if we should save and perform save if needed
   * @private
   */
  _checkAndSave() {
    const now = Date.now();
    
    // Don't save if idle
    if (now - this._lastActivityTime > IDLE_THRESHOLD_MS) {
      if (!this._isIdle) {
        this._isIdle = true;
        console.log('[AutoSaveCoordinator] Entered idle mode');
      }
      return;
    }
    
    this._isIdle = false;
    
    // Check if enough time has passed since last save
    if (now - this._lastSaveTime >= SAVE_INTERVAL_MS) {
      this._performSave('periodic');
    }
  }

  /**
   * Track user activity
   * @private
   */
  _trackActivity() {
    // Track mouse/keyboard activity
    const activityEvents = ['mousedown', 'keydown', 'touchstart', 'wheel'];
    
    const onActivity = () => {
      this._lastActivityTime = Date.now();
      if (this._isIdle) {
        this._isIdle = false;
        console.log('[AutoSaveCoordinator] Activity detected, resuming saves');
      }
    };
    
    activityEvents.forEach(event => {
      window.addEventListener(event, onActivity, { passive: true });
      this._listeners.set(event, onActivity);
    });
  }

  /**
   * Remove event listeners
   * @private
   */
  _removeEventListeners() {
    this._listeners.forEach((handler, event) => {
      window.removeEventListener(event, handler);
    });
    this._listeners.clear();
  }

  /**
   * Register event-based save triggers
   * Call this with your event emitter or callback system
   * @param {Function} onEvent - Callback that receives (eventName, data)
   */
  registerEventSource(onEvent) {
    // This is a hook for external systems to notify us of events
    // For example, preset changes, audio source switches, etc.
    // Implementation depends on your event system
    this._eventSource = onEvent;
  }

  /**
   * Handle external event (call this when preset changes, audio switches, etc.)
   * @param {string} eventName - Event name (e.g., 'preset-changed', 'audio-source-switched')
   * @param {Object} data - Event data
   */
  handleEvent(eventName, data = {}) {
    // Mark activity
    this._lastActivityTime = Date.now();
    
    // Determine tags based on event
    const tags = [];
    if (eventName === 'preset-changed') {
      tags.push('preset-change');
    } else if (eventName === 'audio-source-switched') {
      tags.push('audio-change');
    }
    
    // Schedule save
    this.saveNow(eventName, tags);
  }

  /**
   * Create a bookmark snapshot
   * @param {string} label - Label for the bookmark
   */
  createBookmark(label) {
    const snapshot = StateSnapshot.capture(this.context, ['bookmark']);
    snapshot.bookmarkLabel = label;
    
    try {
      const compressed = snapshot.compress();
      const success = this.persistence.save(compressed);
      
      if (success) {
        this.history.add(snapshot, { bookmark: true, bookmarkLabel: label });
        this._lastSaveTime = Date.now();
        return snapshot;
      }
    } catch (err) {
      console.error('[AutoSaveCoordinator] Failed to create bookmark:', err);
    }
    
    return null;
  }

  /**
   * Get statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      saveCount: this._saveCount,
      saveErrors: this._saveErrors,
      isIdle: this._isIdle,
      lastSaveTime: this._lastSaveTime,
      lastActivityTime: this._lastActivityTime,
      storageSize: this.persistence.getStorageSize(),
      historyStats: this.history.getStats(),
    };
  }
}

