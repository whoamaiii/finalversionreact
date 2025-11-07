/**
 * ListenerManager - Guaranteed event listener cleanup
 *
 * Philosophy: Every listener added must be removed. Memory leaks from
 * accumulated event listeners are preventable with proper tracking.
 *
 * This class provides:
 * - Central registry of all listeners
 * - Automatic cleanup of all listeners
 * - WeakMap storage for bound functions (no memory leaks)
 * - Prevention of duplicate listener registration
 *
 * Makes listener lifecycle management bulletproof.
 */

export class ListenerManager {
  constructor(name = 'ListenerManager') {
    this.name = name;

    // Map of target → Map of event → Set of handlers
    // Using Map instead of WeakMap for targets so we can iterate for cleanup
    this._listeners = new Map();

    // WeakMap to store bound versions of functions
    // This prevents memory leaks from storing function references
    this._boundFunctions = new WeakMap();

    // Track statistics for debugging
    this._stats = {
      added: 0,
      removed: 0,
      active: 0,
    };
  }

  /**
   * Add an event listener with automatic tracking
   *
   * @param {EventTarget} target - The target to attach listener to (DOM element, object, etc.)
   * @param {string} event - The event name
   * @param {Function} handler - The event handler function
   * @param {Object|boolean} options - Event listener options (capture, once, passive, etc.)
   * @returns {Function} - The bound handler (for manual removal if needed)
   */
  add(target, event, handler, options = false) {
    if (!target || typeof target.addEventListener !== 'function') {
      console.warn(`[${this.name}] Invalid target for addEventListener:`, target);
      return handler;
    }

    if (typeof handler !== 'function') {
      console.warn(`[${this.name}] Handler must be a function:`, handler);
      return handler;
    }

    // Get or create the bound version of the handler
    // This ensures we can remove the exact same function reference later
    let boundHandler = this._boundFunctions.get(handler);
    if (!boundHandler) {
      // If handler is already bound (has a name like "bound functionName"), use it directly
      // Otherwise create a new bound version
      boundHandler = handler.name && handler.name.startsWith('bound ') ? handler : handler.bind(target);
      this._boundFunctions.set(handler, boundHandler);
    }

    // Get or create target map
    if (!this._listeners.has(target)) {
      this._listeners.set(target, new Map());
    }
    const targetMap = this._listeners.get(target);

    // Get or create event set
    if (!targetMap.has(event)) {
      targetMap.set(event, new Set());
    }
    const eventSet = targetMap.get(event);

    // Check if already registered (prevent duplicates)
    if (eventSet.has(boundHandler)) {
      console.warn(`[${this.name}] Listener already registered:`, { event, handler: handler.name });
      return boundHandler;
    }

    // Add to registry
    eventSet.add(boundHandler);

    // Actually attach the listener
    try {
      target.addEventListener(event, boundHandler, options);
      this._stats.added++;
      this._stats.active++;
    } catch (err) {
      console.error(`[${this.name}] Error adding listener:`, err);
      eventSet.delete(boundHandler);
      throw err;
    }

    return boundHandler;
  }

  /**
   * Remove a specific event listener
   *
   * @param {EventTarget} target - The target to remove listener from
   * @param {string} event - The event name
   * @param {Function} handler - The original handler function (will be mapped to bound version)
   * @param {Object|boolean} options - Event listener options (must match add() options)
   * @returns {boolean} - True if listener was found and removed
   */
  remove(target, event, handler, options = false) {
    if (!target || typeof target.removeEventListener !== 'function') {
      console.warn(`[${this.name}] Invalid target for removeEventListener:`, target);
      return false;
    }

    const targetMap = this._listeners.get(target);
    if (!targetMap) return false;

    const eventSet = targetMap.get(event);
    if (!eventSet) return false;

    // Get the bound version
    const boundHandler = this._boundFunctions.get(handler) || handler;

    if (!eventSet.has(boundHandler)) {
      return false; // Not registered
    }

    // Remove from registry
    eventSet.delete(boundHandler);
    this._stats.removed++;
    this._stats.active--;

    // Clean up empty maps
    if (eventSet.size === 0) {
      targetMap.delete(event);
    }
    if (targetMap.size === 0) {
      this._listeners.delete(target);
    }

    // Actually remove the listener
    try {
      target.removeEventListener(event, boundHandler, options);
      return true;
    } catch (err) {
      console.error(`[${this.name}] Error removing listener:`, err);
      return false;
    }
  }

  /**
   * Remove all listeners for a specific target
   *
   * @param {EventTarget} target - The target to clean up
   * @returns {number} - Number of listeners removed
   */
  removeAllForTarget(target) {
    const targetMap = this._listeners.get(target);
    if (!targetMap) return 0;

    let removed = 0;

    // Iterate through all events for this target
    for (const [event, eventSet] of targetMap.entries()) {
      for (const handler of eventSet) {
        try {
          target.removeEventListener(event, handler);
          removed++;
          this._stats.removed++;
          this._stats.active--;
        } catch (err) {
          console.error(`[${this.name}] Error removing listener:`, err);
        }
      }
    }

    // Clean up the target map
    this._listeners.delete(target);

    return removed;
  }

  /**
   * Remove all listeners for a specific event across all targets
   *
   * @param {string} event - The event name
   * @returns {number} - Number of listeners removed
   */
  removeAllForEvent(event) {
    let removed = 0;

    for (const [target, targetMap] of this._listeners.entries()) {
      const eventSet = targetMap.get(event);
      if (!eventSet) continue;

      for (const handler of eventSet) {
        try {
          target.removeEventListener(event, handler);
          removed++;
          this._stats.removed++;
          this._stats.active--;
        } catch (err) {
          console.error(`[${this.name}] Error removing listener:`, err);
        }
      }

      // Clean up
      targetMap.delete(event);
      if (targetMap.size === 0) {
        this._listeners.delete(target);
      }
    }

    return removed;
  }

  /**
   * Remove ALL tracked listeners
   * Use this in dispose/cleanup methods to guarantee no leaks
   *
   * @returns {number} - Number of listeners removed
   */
  removeAll() {
    let removed = 0;

    for (const [target, targetMap] of this._listeners.entries()) {
      for (const [event, eventSet] of targetMap.entries()) {
        for (const handler of eventSet) {
          try {
            target.removeEventListener(event, handler);
            removed++;
            this._stats.removed++;
            this._stats.active--;
          } catch (err) {
            console.error(`[${this.name}] Error removing listener:`, err);
          }
        }
      }
    }

    // Clear all maps
    this._listeners.clear();

    console.log(`[${this.name}] Removed all listeners (count: ${removed})`);
    return removed;
  }

  /**
   * Check if a specific listener is registered
   *
   * @param {EventTarget} target
   * @param {string} event
   * @param {Function} handler
   * @returns {boolean}
   */
  has(target, event, handler) {
    const targetMap = this._listeners.get(target);
    if (!targetMap) return false;

    const eventSet = targetMap.get(event);
    if (!eventSet) return false;

    const boundHandler = this._boundFunctions.get(handler) || handler;
    return eventSet.has(boundHandler);
  }

  /**
   * Get count of active listeners
   *
   * @param {EventTarget} [target] - Optional: count for specific target only
   * @param {string} [event] - Optional: count for specific event only (requires target)
   * @returns {number}
   */
  count(target = null, event = null) {
    if (target && event) {
      const targetMap = this._listeners.get(target);
      if (!targetMap) return 0;
      const eventSet = targetMap.get(event);
      return eventSet ? eventSet.size : 0;
    }

    if (target) {
      const targetMap = this._listeners.get(target);
      if (!targetMap) return 0;
      let count = 0;
      for (const eventSet of targetMap.values()) {
        count += eventSet.size;
      }
      return count;
    }

    // Total count across all targets
    return this._stats.active;
  }

  /**
   * Get statistics about listener management
   *
   * @returns {Object} - Stats object
   */
  getStats() {
    return {
      ...this._stats,
      targets: this._listeners.size,
      events: Array.from(this._listeners.values()).reduce(
        (sum, targetMap) => sum + targetMap.size,
        0
      ),
    };
  }

  /**
   * Get detailed breakdown of all listeners (for debugging)
   *
   * @returns {Array} - Array of listener details
   */
  getListenerBreakdown() {
    const breakdown = [];

    for (const [target, targetMap] of this._listeners.entries()) {
      for (const [event, eventSet] of targetMap.entries()) {
        breakdown.push({
          target: target.constructor.name || 'Unknown',
          event,
          count: eventSet.size,
          handlers: Array.from(eventSet).map(h => h.name || 'anonymous'),
        });
      }
    }

    return breakdown;
  }

  /**
   * Reset statistics (for testing)
   */
  resetStats() {
    this._stats = {
      added: 0,
      removed: 0,
      active: this.count(),
    };
  }
}
