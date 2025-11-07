/**
 * ResourceLifecycle - State machine for resource management
 *
 * Philosophy: Resources have clear states and transitions:
 * uninitialized → initializing → ready → closing → closed
 *
 * Prevents:
 * - Using resources before they're ready
 * - Re-initializing active resources
 * - Race conditions during cleanup
 * - Resource leaks from incomplete cleanup
 */

const STATES = {
  UNINITIALIZED: 'uninitialized',
  INITIALIZING: 'initializing',
  READY: 'ready',
  CLOSING: 'closing',
  CLOSED: 'closed',
  ERROR: 'error'
};

const VALID_TRANSITIONS = {
  uninitialized: ['initializing'],
  initializing: ['ready', 'error', 'closed'],
  ready: ['closing', 'error'],
  closing: ['closed', 'error'],
  closed: ['initializing'], // Allow re-initialization
  error: ['initializing', 'closed']
};

export class ResourceLifecycle {
  constructor(resourceName = 'Resource') {
    this.resourceName = resourceName;
    this._state = STATES.UNINITIALIZED;
    this._stateListeners = [];
    this._transitionPromise = null;
    this._error = null;
  }

  /**
   * Get current state
   */
  get state() {
    return this._state;
  }

  /**
   * Check if resource is in a specific state
   */
  is(state) {
    return this._state === state;
  }

  /**
   * Check if resource is ready for use
   */
  get isReady() {
    return this._state === STATES.READY;
  }

  /**
   * Check if resource is currently transitioning
   */
  get isTransitioning() {
    return this._transitionPromise !== null;
  }

  /**
   * Transition to a new state with an async operation
   * Prevents concurrent transitions and enforces state machine rules
   *
   * @param {string} targetState - Target state to transition to
   * @param {Function} operation - Async function to execute during transition
   * @returns {Promise} - Resolves when transition completes
   */
  async transition(targetState, operation = null) {
    // Validate transition
    const validTargets = VALID_TRANSITIONS[this._state];
    if (!validTargets || !validTargets.includes(targetState)) {
      throw new Error(
        `[${this.resourceName}] Invalid transition: ${this._state} → ${targetState}`
      );
    }

    // Prevent concurrent transitions
    if (this._transitionPromise) {
      console.warn(
        `[${this.resourceName}] Waiting for pending transition to complete before ${targetState}`
      );
      await this._transitionPromise;

      // Re-check if transition is still valid after waiting
      const currentValidTargets = VALID_TRANSITIONS[this._state];
      if (!currentValidTargets || !currentValidTargets.includes(targetState)) {
        throw new Error(
          `[${this.resourceName}] State changed during wait, transition to ${targetState} no longer valid`
        );
      }
    }

    // Execute transition
    const previousState = this._state;
    this._state = targetState;
    this._notifyListeners(previousState, targetState);

    if (operation) {
      this._transitionPromise = (async () => {
        try {
          await operation();
          this._error = null;
          return true;
        } catch (err) {
          console.error(`[${this.resourceName}] Transition error (${previousState} → ${targetState}):`, err);
          this._error = err;

          // Transition to error state if not already closing/closed
          if (this._state !== STATES.CLOSED && this._state !== STATES.CLOSING) {
            this._state = STATES.ERROR;
            this._notifyListeners(targetState, STATES.ERROR);
          }

          throw err;
        } finally {
          this._transitionPromise = null;
        }
      })();

      return this._transitionPromise;
    }

    return Promise.resolve();
  }

  /**
   * Convenience: Initialize resource
   */
  async initialize(operation) {
    await this.transition(STATES.INITIALIZING);
    try {
      if (operation) await operation();
      await this.transition(STATES.READY);
    } catch (err) {
      console.error(`[${this.resourceName}] Initialization failed:`, err);
      throw err;
    }
  }

  /**
   * Convenience: Close resource
   */
  async close(operation) {
    if (this._state === STATES.CLOSED) {
      console.warn(`[${this.resourceName}] Already closed`);
      return;
    }

    if (this._state === STATES.UNINITIALIZED) {
      this._state = STATES.CLOSED;
      return;
    }

    await this.transition(STATES.CLOSING);
    try {
      if (operation) await operation();
      await this.transition(STATES.CLOSED);
    } catch (err) {
      console.error(`[${this.resourceName}] Close error:`, err);
      // Force to closed state even on error
      this._state = STATES.CLOSED;
      this._notifyListeners(STATES.CLOSING, STATES.CLOSED);
      throw err;
    }
  }

  /**
   * Wait until resource reaches a specific state
   */
  async waitFor(targetState, timeout = 5000) {
    if (this._state === targetState) {
      return true;
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(
          `[${this.resourceName}] Timeout waiting for state: ${targetState} (current: ${this._state})`
        ));
      }, timeout);

      const listener = (from, to) => {
        if (to === targetState) {
          cleanup();
          resolve(true);
        } else if (to === STATES.ERROR || to === STATES.CLOSED) {
          cleanup();
          reject(new Error(
            `[${this.resourceName}] Reached ${to} while waiting for ${targetState}`
          ));
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        const idx = this._stateListeners.indexOf(listener);
        if (idx >= 0) this._stateListeners.splice(idx, 1);
      };

      this._stateListeners.push(listener);
    });
  }

  /**
   * Assert resource is ready, throw if not
   */
  assertReady() {
    if (this._state !== STATES.READY) {
      throw new Error(
        `[${this.resourceName}] Resource not ready (current state: ${this._state})`
      );
    }
  }

  /**
   * Listen to state changes
   */
  onStateChange(callback) {
    this._stateListeners.push(callback);
    return () => {
      const idx = this._stateListeners.indexOf(callback);
      if (idx >= 0) this._stateListeners.splice(idx, 1);
    };
  }

  /**
   * Notify listeners of state change
   */
  _notifyListeners(from, to) {
    console.log(`[${this.resourceName}] State: ${from} → ${to}`);
    this._stateListeners.forEach(listener => {
      try {
        listener(from, to);
      } catch (err) {
        console.error(`[${this.resourceName}] State listener error:`, err);
      }
    });
  }

  /**
   * Get last error
   */
  getError() {
    return this._error;
  }

  /**
   * Reset to initial state (for testing or recovery)
   */
  reset() {
    if (this._state !== STATES.CLOSED && this._state !== STATES.ERROR) {
      console.warn(`[${this.resourceName}] Forcing reset from ${this._state}`);
    }
    this._state = STATES.UNINITIALIZED;
    this._error = null;
    this._transitionPromise = null;
  }
}

export { STATES };
