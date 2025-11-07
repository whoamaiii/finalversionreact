/**
 * Session Persistence - Atomic storage for session snapshots
 * 
 * Implements crash-resistant storage using the same atomic write pattern
 * as PresetManager: .tmp → .bak → promote to primary
 */

const STORAGE_KEYS = {
  primary: 'cosmicSessionState.v1',
  working: 'cosmicSessionState.v1.tmp',
  backup: 'cosmicSessionState.v1.bak',
};

/**
 * SessionPersistence - Handles atomic writes of session snapshots
 */
export class SessionPersistence {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  /**
   * Save snapshot atomically
   * @param {string} compressedSnapshot - Compressed snapshot string
   * @returns {boolean} Success status
   */
  save(compressedSnapshot) {
    if (!this.storage) return false;

    try {
      // Step 1: Write to temporary key first to validate we have space
      // This prevents corrupting backup if quota is exceeded
      this.storage.setItem(STORAGE_KEYS.working, compressedSnapshot);
    } catch (err) {
      console.error('[SessionPersistence] Failed to write temp copy:', err);
      this._handleQuotaError(err);
      return false;
    }

    try {
      // Step 2: Get current primary before overwriting
      const previous = this.storage.getItem(STORAGE_KEYS.primary);

      // Step 3: Write new data to primary key
      // If this fails, we still have the backup intact
      this.storage.setItem(STORAGE_KEYS.primary, compressedSnapshot);

      // Step 4: Only NOW that primary succeeded, backup the old primary
      // This ensures we always have valid data in either primary or backup
      if (previous) {
        try {
          this.storage.setItem(STORAGE_KEYS.backup, previous);
        } catch (backupErr) {
          // Backup write failed, but primary succeeded
          // This is non-critical - log and continue
          console.warn('[SessionPersistence] Backup write failed, but primary succeeded:', backupErr);
        }
      }

      // Step 5: Clean up temporary copy
      try {
        this.storage.removeItem(STORAGE_KEYS.working);
      } catch (_) {
        // Cleanup failure is non-critical
      }

      return true; // Success
    } catch (err) {
      console.error('[SessionPersistence] Save failed:', err);
      this._handleQuotaError(err);

      // Try to clean up working copy
      try {
        this.storage.removeItem(STORAGE_KEYS.working);
      } catch (_) {}

      return false; // Failed
    }
  }

  /**
   * Load latest snapshot
   * @returns {string|null} Compressed snapshot string or null
   */
  load() {
    if (!this.storage) return null;

    const tryLoad = (key) => {
      try {
        const raw = this.storage.getItem(key);
        if (raw) return raw;
      } catch (err) {
        console.warn(`[SessionPersistence] Failed to load from ${key}:`, err);
      }
      return null;
    };

    // Try primary first, then backup, then working (recovery)
    const primary = tryLoad(STORAGE_KEYS.primary);
    if (primary) return primary;

    const backup = tryLoad(STORAGE_KEYS.backup);
    if (backup) return backup;

    const working = tryLoad(STORAGE_KEYS.working);
    if (working) return working;

    return null;
  }

  /**
   * Check if a snapshot exists
   * @returns {boolean}
   */
  hasSnapshot() {
    if (!this.storage) return false;
    try {
      return !!(
        this.storage.getItem(STORAGE_KEYS.primary) ||
        this.storage.getItem(STORAGE_KEYS.backup) ||
        this.storage.getItem(STORAGE_KEYS.working)
      );
    } catch (_) {
      return false;
    }
  }

  /**
   * Clear all snapshots
   * @returns {boolean} Success status
   */
  clear() {
    if (!this.storage) return false;
    try {
      this.storage.removeItem(STORAGE_KEYS.primary);
      this.storage.removeItem(STORAGE_KEYS.backup);
      this.storage.removeItem(STORAGE_KEYS.working);
      return true;
    } catch (err) {
      console.error('[SessionPersistence] Failed to clear snapshots:', err);
      return false;
    }
  }

  /**
   * Handle quota exceeded errors
   * @private
   */
  _handleQuotaError(err) {
    if (err.name === 'QuotaExceededError') {
      try {
        // Try to show toast if available
        if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
          window.showToast('Storage full! Session snapshot not saved. Free up space.', 5000);
        }
      } catch (_) {
        // Toast unavailable, user will see console warnings
      }
      console.warn('[SessionPersistence] Storage quota exceeded. Consider clearing old snapshots.');
    }
  }

  /**
   * Get storage size estimate (for debugging)
   * @returns {Object} Size information
   */
  getStorageSize() {
    if (!this.storage) return { total: 0, primary: 0, backup: 0, working: 0 };

    const getSize = (key) => {
      try {
        const item = this.storage.getItem(key);
        return item ? new Blob([item]).size : 0;
      } catch (_) {
        return 0;
      }
    };

    return {
      primary: getSize(STORAGE_KEYS.primary),
      backup: getSize(STORAGE_KEYS.backup),
      working: getSize(STORAGE_KEYS.working),
      total: getSize(STORAGE_KEYS.primary) + getSize(STORAGE_KEYS.backup) + getSize(STORAGE_KEYS.working),
    };
  }
}

