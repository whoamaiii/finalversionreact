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

import { StateSnapshot } from '../state-snapshot.js';
import { SessionPersistence } from '../storage/sessionPersistence.js';
import { SnapshotHistory } from './snapshotHistory.js';

const SAVE_INTERVAL_MS = 5000; // Save every 5 seconds during active use
const IDLE_THRESHOLD_MS = 300000; // 5 minutes of inactivity
const MAX_SAVE_FREQUENCY_MS = 1000; // Max 1 save per second
const DEBOUNCE_MS = 200; // Debounce rapid changes
const ERROR_LOG_THROTTLE_MS = 60000; // Only log same error once per minute
const CIRCUIT_BREAKER_THRESHOLD = 5; // Disable saves after 5 consecutive errors
const CIRCUIT_BREAKER_RESET_MS = 60000; // Re-enable after 1 minute

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

    // Error throttling and circuit breaker
    this._lastErrorLogTime = new Map(); // Track when we last logged each error type
    this._consecutiveErrors = 0;
    this._circuitBreakerOpen = false;
    this._circuitBreakerOpenTime = 0;
    this._circuitBreakerResetCount = 0; // Track how many times we've reset
    this._circuitBreakerMaxResets = 3; // After 3 resets, permanently disable
    this._permanentFailureShown = false; // Track if we showed permanent failure toast

    // Auto-cleanup on page unload to prevent memory leaks
    this._unloadHandler = () => this.stop();
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this._unloadHandler);
    }
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
    // Remove unload handler first
    if (this._unloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this._unloadHandler);
      this._unloadHandler = null;
    }

    // Clear interval
    if (this._saveIntervalId) {
      clearInterval(this._saveIntervalId);
      this._saveIntervalId = null;
    }

    // Save final snapshot before stopping
    this.saveNow('shutdown');

    // Remove activity event listeners
    this._removeEventListeners();

    console.log('[AutoSaveCoordinator] Stopped and cleaned up');
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
    
    // Check circuit breaker with exponential backoff
    if (this._circuitBreakerOpen) {
      // Calculate backoff time (exponential: 60s, 120s, 240s)
      const backoffMs = CIRCUIT_BREAKER_RESET_MS * Math.pow(2, this._circuitBreakerResetCount);
      const timeOpen = now - this._circuitBreakerOpenTime;

      if (timeOpen > backoffMs) {
        // Check if we've reset too many times
        if (this._circuitBreakerResetCount >= this._circuitBreakerMaxResets) {
          console.error('[AutoSaveCoordinator] Circuit breaker permanently open after',
            this._circuitBreakerResetCount, 'resets. Auto-save disabled.');

          // Show user notification (once)
          if (!this._permanentFailureShown) {
            this._permanentFailureShown = true;
            import('./toast.js')
              .then(({ showToast }) => {
                showToast('Auto-save permanently disabled due to repeated failures. Check storage.', 10000);
              })
              .catch(() => {});
          }
          return; // Give up permanently
        }

        // Attempt reset
        this._circuitBreakerOpen = false;
        this._circuitBreakerResetCount++;
        this._throttledLog('info',
          `[AutoSaveCoordinator] Circuit breaker reset attempt ${this._circuitBreakerResetCount}/${this._circuitBreakerMaxResets}`,
          `Next backoff: ${backoffMs / 1000}s`);
      } else {
        // Still in backoff period
        return;
      }
    }
    
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
        // SUCCESS: Reset all error tracking
        this._consecutiveErrors = 0;
        this._circuitBreakerResetCount = 0; // Reset the reset counter
        this._lastSaveTime = now;
        this._saveCount++;
        
        // Add to history (except for very frequent periodic saves)
        if (reason !== 'periodic' || this._saveCount % 3 === 0) {
          // Only add every 3rd periodic save to history to avoid flooding
          try {
            this.history.add(snapshot, { bookmark: false });
          } catch (err) {
            this._throttledLog('warn', '[AutoSaveCoordinator] Failed to add to history:', err);
          }
        }
        
        const duration = performance.now() - startTime;
        if (duration > 50) {
          this._throttledLog('warn', `[AutoSaveCoordinator] Save took ${duration.toFixed(1)}ms (slow)`);
        }
      } else {
        this._handleSaveError('Save failed', null);
      }
    } catch (err) {
      this._handleSaveError('Save error', err);
    } finally {
      this._isSaving = false;
    }
  }

  /**
   * Handle save errors with throttling and circuit breaker
   * @private
   */
  _handleSaveError(message, err) {
    this._saveErrors++;
    this._consecutiveErrors++;
    
    // Throttle error logging to prevent console spam
    const errorKey = err ? `${err.name}:${err.message}` : message;
    this._throttledLog('error', `[AutoSaveCoordinator] ${message}:`, err || '');
    
    // Open circuit breaker if too many consecutive errors
    if (this._consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD && !this._circuitBreakerOpen) {
      this._circuitBreakerOpen = true;
      this._circuitBreakerOpenTime = Date.now();
      console.warn(`[AutoSaveCoordinator] Circuit breaker opened after ${this._consecutiveErrors} consecutive errors. Saves disabled for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`);
    }
  }

  /**
   * Throttled logging to prevent console spam
   * Bug fix #14: Improved key generation and throttle indicator
   * @private
   */
  _throttledLog(level, ...args) {
    const now = Date.now();

    // Better key generation: handle objects, errors, and non-string values
    const key = args.map(arg => {
      if (arg === null) return 'null';
      if (arg === undefined) return 'undefined';
      if (arg instanceof Error) return `Error:${arg.name}:${arg.message}`;
      if (typeof arg === 'object') {
        // Use a stable stringification for objects
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg); // Fallback for circular refs
        }
      }
      return String(arg);
    }).join('|');

    const lastLogTime = this._lastErrorLogTime.get(key) || 0;
    const timeSinceLastLog = now - lastLogTime;

    if (timeSinceLastLog > ERROR_LOG_THROTTLE_MS) {
      this._lastErrorLogTime.set(key, now);

      // Add throttle indicator if this was recently throttled
      const wasThrottled = lastLogTime > 0;
      const throttleIndicator = wasThrottled
        ? `[throttled for ${Math.floor(timeSinceLastLog / 1000)}s]`
        : '';

      if (level === 'error') {
        console.error(...args, throttleIndicator);
      } else if (level === 'warn') {
        console.warn(...args, throttleIndicator);
      } else {
        console.log(...args, throttleIndicator);
      }
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
        // Reset error tracking on successful bookmark
        this._consecutiveErrors = 0;
        return snapshot;
      }
    } catch (err) {
      this._throttledLog('error', '[AutoSaveCoordinator] Failed to create bookmark:', err);
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
      consecutiveErrors: this._consecutiveErrors,
      circuitBreakerOpen: this._circuitBreakerOpen,
      circuitBreakerResetCount: this._circuitBreakerResetCount,
      circuitBreakerBackoffMs: this._circuitBreakerOpen
        ? CIRCUIT_BREAKER_RESET_MS * Math.pow(2, this._circuitBreakerResetCount)
        : 0,
      isIdle: this._isIdle,
      lastSaveTime: this._lastSaveTime,
      lastActivityTime: this._lastActivityTime,
      storageSize: this.persistence.getStorageSize(),
      historyStats: this.history.getStats(),
    };
  }

  /**
   * Dispose of all resources and clean up references
   * Call this when the coordinator is no longer needed
   */
  dispose() {
    // Stop saves and remove all listeners
    this.stop();

    // Clear all references to prevent memory leaks
    this.context = null;
    this.persistence = null;
    this.history = null;
    this._eventSource = null;
    this._lastErrorLogTime.clear();

    console.log('[AutoSaveCoordinator] Disposed');
  }
}

