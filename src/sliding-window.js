/**
 * SlidingWindow - Efficient fixed-size buffer for live audio performance
 *
 * A sliding window automatically maintains the newest N items, discarding
 * the oldest when capacity is reached. Perfect for real-time audio analysis
 * where fresh data is critical and historical data becomes stale.
 *
 * Use cases:
 * - Audio feature calibration during rapid track changes
 * - Beat detection history with fixed memory footprint
 * - Tempo estimation sample buffers
 * - Any time-series data with recency bias
 *
 * @example
 * const window = new SlidingWindow(100); // Keep newest 100 items
 * window.push(0.5); // Add sample
 * window.push(0.7);
 * const stats = window.getStats(); // Get mean, median, percentiles
 */
export class SlidingWindow {
  /**
   * Create a new sliding window
   * @param {number} maxSize - Maximum number of items to retain
   */
  constructor(maxSize) {
    this.maxSize = Math.max(1, Math.floor(maxSize));
    this.items = [];
  }

  /**
   * Add an item to the window, removing oldest if at capacity
   * @param {*} item - Item to add
   * @returns {number} Current number of items in window
   */
  push(item) {
    // Remove oldest if at capacity
    if (this.items.length >= this.maxSize) {
      this.items.shift();
    }
    this.items.push(item);
    return this.items.length;
  }

  /**
   * Add multiple items at once (batch operation)
   * @param {Array} items - Items to add
   * @returns {number} Current number of items in window
   */
  pushBatch(items) {
    for (const item of items) {
      this.push(item);
    }
    return this.items.length;
  }

  /**
   * Get all items in the window (newest to oldest order is preserved)
   * @returns {Array} Copy of all items
   */
  getAll() {
    return this.items.slice();
  }

  /**
   * Get the N newest items
   * @param {number} n - Number of items to retrieve
   * @returns {Array} The newest N items
   */
  getNewest(n) {
    return this.items.slice(-n);
  }

  /**
   * Get the N oldest items
   * @param {number} n - Number of items to retrieve
   * @returns {Array} The oldest N items
   */
  getOldest(n) {
    return this.items.slice(0, n);
  }

  /**
   * Clear all items from the window
   */
  clear() {
    this.items.length = 0;
  }

  /**
   * Get current number of items in window
   */
  get length() {
    return this.items.length;
  }

  /**
   * Check if window is at full capacity
   */
  get isFull() {
    return this.items.length >= this.maxSize;
  }

  /**
   * Get the newest (most recent) item
   */
  get newest() {
    return this.items[this.items.length - 1];
  }

  /**
   * Get the oldest item
   */
  get oldest() {
    return this.items[0];
  }

  /**
   * Calculate statistics for numeric data in the window
   * Useful for audio calibration and adaptive thresholds
   * @returns {Object|null} Statistics object or null if empty
   */
  getStats() {
    if (!this.items.length) return null;

    // Calculate basic stats
    const sum = this.items.reduce((a, b) => a + b, 0);
    const mean = sum / this.items.length;

    // Sort for percentile calculations
    const sorted = this.items.slice().sort((a, b) => a - b);

    // Calculate percentiles
    const percentile = (p) => {
      const position = p * (sorted.length - 1);
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      const weight = position - lower;

      if (lower === upper || upper >= sorted.length) {
        return sorted[lower];
      }
      return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    };

    // Calculate variance and standard deviation
    const variance = this.items.reduce((acc, val) => {
      const diff = val - mean;
      return acc + diff * diff;
    }, 0) / this.items.length;
    const std = Math.sqrt(variance);

    return {
      count: this.items.length,
      sum,
      mean,
      std,
      variance,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      median: percentile(0.5),
      p25: percentile(0.25),
      p75: percentile(0.75),
      p90: percentile(0.90),
      p95: percentile(0.95),
      p99: percentile(0.99),
      // Useful for adaptive thresholds in audio
      p60: percentile(0.60),
      p70: percentile(0.70),
      p80: percentile(0.80),
    };
  }

  /**
   * Apply a function to each item and return results
   * @param {Function} fn - Function to apply
   * @returns {Array} Results
   */
  map(fn) {
    return this.items.map(fn);
  }

  /**
   * Filter items by a predicate
   * @param {Function} fn - Filter function
   * @returns {Array} Filtered items
   */
  filter(fn) {
    return this.items.filter(fn);
  }

  /**
   * Reduce items to a single value
   * @param {Function} fn - Reducer function
   * @param {*} initialValue - Initial accumulator value
   * @returns {*} Reduced value
   */
  reduce(fn, initialValue) {
    return this.items.reduce(fn, initialValue);
  }

  /**
   * Check if any item satisfies a condition
   * @param {Function} fn - Test function
   * @returns {boolean} True if any item passes the test
   */
  some(fn) {
    return this.items.some(fn);
  }

  /**
   * Check if all items satisfy a condition
   * @param {Function} fn - Test function
   * @returns {boolean} True if all items pass the test
   */
  every(fn) {
    return this.items.every(fn);
  }

  /**
   * Find the first item that satisfies a condition
   * @param {Function} fn - Test function
   * @returns {*} First matching item or undefined
   */
  find(fn) {
    return this.items.find(fn);
  }

  /**
   * Convert window to JSON (for serialization)
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      maxSize: this.maxSize,
      items: this.items,
      length: this.items.length,
      isFull: this.isFull,
    };
  }

  /**
   * Create a SlidingWindow from JSON
   * @param {Object} json - JSON representation
   * @returns {SlidingWindow} New instance
   */
  static fromJSON(json) {
    const window = new SlidingWindow(json.maxSize);
    window.items = json.items || [];
    return window;
  }
}

/**
 * TimeWindowedBuffer - Sliding window with time-based expiry
 * Items are automatically removed when they exceed a maximum age
 */
export class TimeWindowedBuffer extends SlidingWindow {
  /**
   * Create a time-windowed buffer
   * @param {number} maxSize - Maximum number of items
   * @param {number} maxAgeMs - Maximum age in milliseconds
   */
  constructor(maxSize, maxAgeMs) {
    super(maxSize);
    this.maxAgeMs = Math.max(0, maxAgeMs);
  }

  /**
   * Add an item with timestamp
   * @param {*} item - Item to add
   * @param {number} [timestamp] - Optional timestamp (defaults to now)
   * @returns {number} Current number of items
   */
  push(item, timestamp = null) {
    const now = timestamp !== null ? timestamp : (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // Remove expired items
    this._removeExpired(now);

    // Add new item with timestamp
    const entry = { item, timestamp: now };

    // Use parent's push logic for size limiting
    if (this.items.length >= this.maxSize) {
      this.items.shift();
    }
    this.items.push(entry);

    return this.items.length;
  }

  /**
   * Remove items older than maxAgeMs
   * @private
   */
  _removeExpired(now) {
    if (this.maxAgeMs <= 0) return;

    while (this.items.length && (now - this.items[0].timestamp) > this.maxAgeMs) {
      this.items.shift();
    }
  }

  /**
   * Get all non-expired items
   * @returns {Array} Items (without timestamps)
   */
  getAll() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._removeExpired(now);
    return this.items.map(entry => entry.item);
  }

  /**
   * Get statistics for non-expired numeric data
   * @returns {Object|null} Statistics
   */
  getStats() {
    const items = this.getAll();
    if (!items.length) return null;

    // Temporarily swap items for stats calculation
    const originalItems = this.items;
    this.items = items;
    const stats = super.getStats();
    this.items = originalItems;

    return stats;
  }
}
