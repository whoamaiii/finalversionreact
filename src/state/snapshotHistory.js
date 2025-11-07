/**
 * SnapshotHistory - Manages multi-snapshot history with intelligent pruning
 * 
 * Features:
 * - Circular buffer (last 20 snapshots)
 * - Smart pruning (keep all <30min, hourly up to 4h, daily up to 7d)
 * - Bookmark system (user-named snapshots that never auto-prune)
 * - Tag-based filtering (preset-change, pre-crash, etc.)
 */

import { StateSnapshot } from './state-snapshot.js';
import { SessionPersistence } from './storage/sessionPersistence.js';

const STORAGE_KEY = 'cosmicSessionHistory.v1';
const MAX_SNAPSHOTS = 20; // Circular buffer size
const PRUNE_RULES = {
  keepAllMinutes: 30,      // Keep all snapshots from last 30 minutes
  keepHourlyHours: 4,       // Keep 1 per hour for last 4 hours
  keepDailyDays: 7,         // Keep 1 per day for last 7 days
};

export class SnapshotHistory {
  constructor(storage = window.localStorage) {
    this.storage = storage;
    this._snapshots = this._loadHistory();
    this._prune(); // Prune on initialization
  }

  /**
   * Add a snapshot to history
   * @param {StateSnapshot} snapshot - Snapshot to add
   * @param {Object} options - Options
   * @param {boolean} options.bookmark - Mark as bookmark (never auto-prune)
   * @param {string} options.bookmarkLabel - Label for bookmark
   */
  add(snapshot, options = {}) {
    if (!(snapshot instanceof StateSnapshot)) {
      throw new Error('SnapshotHistory.add requires StateSnapshot instance');
    }

    // Add bookmark tag if specified
    if (options.bookmark) {
      snapshot.addTag('bookmark');
      if (options.bookmarkLabel) {
        snapshot.bookmarkLabel = options.bookmarkLabel;
      }
    }

    // Add to array
    this._snapshots.push({
      snapshot,
      timestamp: snapshot.timestamp,
      compressed: snapshot.compress(),
    });

    // Enforce circular buffer limit
    if (this._snapshots.length > MAX_SNAPSHOTS) {
      // Remove oldest non-bookmark snapshot
      const nonBookmarkIndex = this._snapshots.findIndex(
        item => !item.snapshot.hasTag('bookmark')
      );
      if (nonBookmarkIndex >= 0) {
        this._snapshots.splice(nonBookmarkIndex, 1);
      } else {
        // All are bookmarks, remove oldest bookmark
        this._snapshots.shift();
      }
    }

    // Prune according to rules
    this._prune();

    // Persist
    this._persist();
  }

  /**
   * Get all snapshots (most recent first)
   * @returns {Array<StateSnapshot>}
   */
  list() {
    return this._snapshots
      .map(item => {
        try {
          return StateSnapshot.decompress(item.compressed);
        } catch (err) {
          console.warn('[SnapshotHistory] Failed to decompress snapshot:', err);
          return null;
        }
      })
      .filter(Boolean)
      .reverse(); // Most recent first
  }

  /**
   * Get snapshots filtered by tags
   * @param {Array<string>} tags - Tags to filter by
   * @returns {Array<StateSnapshot>}
   */
  filterByTags(tags) {
    const tagSet = new Set(tags);
    return this.list().filter(snapshot => {
      return Array.from(snapshot.tags).some(tag => tagSet.has(tag));
    });
  }

  /**
   * Get bookmarked snapshots
   * @returns {Array<StateSnapshot>}
   */
  getBookmarks() {
    return this.filterByTags(['bookmark']);
  }

  /**
   * Get snapshot by timestamp
   * @param {number} timestamp - Snapshot timestamp
   * @returns {StateSnapshot|null}
   */
  getByTimestamp(timestamp) {
    const item = this._snapshots.find(item => item.timestamp === timestamp);
    if (!item) return null;
    
    try {
      return StateSnapshot.decompress(item.compressed);
    } catch (err) {
      console.warn('[SnapshotHistory] Failed to decompress snapshot:', err);
      return null;
    }
  }

  /**
   * Get latest snapshot
   * @returns {StateSnapshot|null}
   */
  getLatest() {
    if (this._snapshots.length === 0) return null;
    const latest = this._snapshots[this._snapshots.length - 1];
    try {
      return StateSnapshot.decompress(latest.compressed);
    } catch (err) {
      console.warn('[SnapshotHistory] Failed to decompress latest snapshot:', err);
      return null;
    }
  }

  /**
   * Remove snapshot by timestamp
   * @param {number} timestamp - Timestamp to remove
   * @returns {boolean} Success status
   */
  remove(timestamp) {
    const index = this._snapshots.findIndex(item => item.timestamp === timestamp);
    if (index >= 0) {
      this._snapshots.splice(index, 1);
      this._persist();
      return true;
    }
    return false;
  }

  /**
   * Clear all snapshots (except bookmarks if preserveBookmarks=true)
   * @param {boolean} preserveBookmarks - Keep bookmarked snapshots
   */
  clear(preserveBookmarks = false) {
    if (preserveBookmarks) {
      this._snapshots = this._snapshots.filter(item => {
        try {
          const snapshot = StateSnapshot.decompress(item.compressed);
          return snapshot.hasTag('bookmark');
        } catch (_) {
          return false;
        }
      });
    } else {
      this._snapshots = [];
    }
    this._persist();
  }

  /**
   * Prune snapshots according to intelligent rules
   * @private
   */
  _prune() {
    const now = Date.now();
    const keep = [];
    const toRemove = [];

    // Decompress all snapshots for analysis
    const snapshots = this._snapshots.map(item => {
      try {
        return {
          ...item,
          snapshot: StateSnapshot.decompress(item.compressed),
        };
      } catch (_) {
        return null;
      }
    }).filter(Boolean);

    // Group by time windows
    const recent = []; // < 30 minutes
    const hourly = []; // 30 minutes - 4 hours
    const daily = []; // 4 hours - 7 days
    const old = []; // > 7 days

    snapshots.forEach(item => {
      const age = now - item.timestamp;
      const minutes = age / (1000 * 60);
      const hours = minutes / 60;
      const days = hours / 24;

      // Never prune bookmarks
      if (item.snapshot.hasTag('bookmark')) {
        keep.push(item);
        return;
      }

      // Never prune pre-crash snapshots
      if (item.snapshot.hasTag('pre-crash')) {
        keep.push(item);
        return;
      }

      if (minutes < PRUNE_RULES.keepAllMinutes) {
        recent.push(item);
      } else if (hours < PRUNE_RULES.keepHourlyHours) {
        hourly.push(item);
      } else if (days < PRUNE_RULES.keepDailyDays) {
        daily.push(item);
      } else {
        old.push(item);
      }
    });

    // Keep all recent
    keep.push(...recent);

    // Keep 1 per hour from hourly window
    const hourlyByHour = new Map();
    hourly.forEach(item => {
      const hour = Math.floor((now - item.timestamp) / (1000 * 60 * 60));
      if (!hourlyByHour.has(hour) || item.timestamp > hourlyByHour.get(hour).timestamp) {
        hourlyByHour.set(hour, item);
      }
    });
    keep.push(...Array.from(hourlyByHour.values()));

    // Keep 1 per day from daily window
    const dailyByDay = new Map();
    daily.forEach(item => {
      const day = Math.floor((now - item.timestamp) / (1000 * 60 * 60 * 24));
      if (!dailyByDay.has(day) || item.timestamp > dailyByDay.get(day).timestamp) {
        dailyByDay.set(day, item);
      }
    });
    keep.push(...Array.from(dailyByDay.values()));

    // Remove old snapshots
    toRemove.push(...old);

    // Remove duplicates from hourly/daily that weren't selected
    hourly.forEach(item => {
      if (!keep.includes(item)) {
        toRemove.push(item);
      }
    });
    daily.forEach(item => {
      if (!keep.includes(item)) {
        toRemove.push(item);
      }
    });

    // Update snapshots array
    const keepTimestamps = new Set(keep.map(item => item.timestamp));
    this._snapshots = this._snapshots.filter(item => keepTimestamps.has(item.timestamp));
  }

  /**
   * Load history from storage
   * @private
   */
  _loadHistory() {
    if (!this.storage) return [];

    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return [];

      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];

      return data.map(item => ({
        timestamp: item.timestamp,
        compressed: item.compressed,
        snapshot: null, // Will be decompressed on demand
      }));
    } catch (err) {
      console.warn('[SnapshotHistory] Failed to load history:', err);
      return [];
    }
  }

  /**
   * Persist history to storage
   * @private
   */
  _persist() {
    if (!this.storage) return;

    try {
      const data = this._snapshots.map(item => ({
        timestamp: item.timestamp,
        compressed: item.compressed,
      }));

      this.storage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      console.error('[SnapshotHistory] Failed to persist history:', err);
      if (err.name === 'QuotaExceededError') {
        // Try to prune more aggressively
        this._prune();
        try {
          const data = this._snapshots.map(item => ({
            timestamp: item.timestamp,
            compressed: item.compressed,
          }));
          this.storage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (_) {
          console.error('[SnapshotHistory] Still failed after pruning');
        }
      }
    }
  }

  /**
   * Get statistics
   * @returns {Object} Statistics
   */
  getStats() {
    const snapshots = this.list();
    const bookmarks = this.getBookmarks();
    
    return {
      total: snapshots.length,
      bookmarks: bookmarks.length,
      oldest: snapshots.length > 0 ? snapshots[snapshots.length - 1].timestamp : null,
      newest: snapshots.length > 0 ? snapshots[0].timestamp : null,
    };
  }
}

