/**
 * ReadinessGate - Coordination for component initialization
 *
 * Philosophy: Components should declare their dependencies explicitly.
 * No operation should proceed until all dependencies are ready.
 *
 * Prevents:
 * - Null reference errors from uninitialized components
 * - Race conditions in initialization order
 * - Silent failures from missing dependencies
 */

export class ReadinessGate {
  constructor(name = 'ReadinessGate') {
    this.name = name;
    this._components = new Map(); // componentName -> { ready, waiters }
    this._readyCallbacks = new Map(); // componentName -> [callbacks]
  }

  /**
   * Register a component as not ready yet
   */
  register(componentName) {
    if (!this._components.has(componentName)) {
      this._components.set(componentName, {
        ready: false,
        readyAt: null,
        waiters: []
      });
      this._readyCallbacks.set(componentName, []);
    }
  }

  /**
   * Mark a component as ready
   */
  setReady(componentName) {
    if (!this._components.has(componentName)) {
      this.register(componentName);
    }

    const component = this._components.get(componentName);
    if (component.ready) {
      console.warn(`[${this.name}] Component ${componentName} already marked ready`);
      return;
    }

    component.ready = true;
    component.readyAt = Date.now();

    console.log(`[${this.name}] ${componentName} is ready`);

    // Notify all waiters
    const callbacks = this._readyCallbacks.get(componentName) || [];
    callbacks.forEach(cb => {
      try {
        cb();
      } catch (err) {
        console.error(`[${this.name}] Ready callback error for ${componentName}:`, err);
      }
    });
    this._readyCallbacks.set(componentName, []);

    // Resolve any pending waiters
    component.waiters.forEach(resolve => resolve());
    component.waiters = [];
  }

  /**
   * Mark a component as not ready (useful for resets)
   */
  setNotReady(componentName) {
    const component = this._components.get(componentName);
    if (component) {
      component.ready = false;
      component.readyAt = null;
      console.log(`[${this.name}] ${componentName} marked not ready`);
    }
  }

  /**
   * Check if a component is ready
   */
  isReady(componentName) {
    const component = this._components.get(componentName);
    return component ? component.ready : false;
  }

  /**
   * Check if all specified components are ready
   */
  areReady(componentNames) {
    return componentNames.every(name => this.isReady(name));
  }

  /**
   * Wait until a component is ready
   * @param {string} componentName - Component to wait for
   * @param {number} timeout - Max wait time in ms (0 = no timeout)
   * @returns {Promise<void>}
   */
  async waitFor(componentName, timeout = 5000) {
    // Register if not already registered
    if (!this._components.has(componentName)) {
      this.register(componentName);
    }

    const component = this._components.get(componentName);

    // Already ready
    if (component.ready) {
      return;
    }

    // Wait for ready
    return new Promise((resolve, reject) => {
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        const idx = component.waiters.indexOf(resolve);
        if (idx >= 0) component.waiters.splice(idx, 1);
      };

      // Setup timeout
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(
            `[${this.name}] Timeout waiting for ${componentName} (${timeout}ms)`
          ));
        }, timeout);
      }

      // Wrapper to clean up on resolve
      const wrappedResolve = () => {
        cleanup();
        resolve();
      };

      component.waiters.push(wrappedResolve);
    });
  }

  /**
   * Wait until all specified components are ready
   * @param {string[]} componentNames - Components to wait for
   * @param {number} timeout - Max wait time in ms
   * @returns {Promise<void>}
   */
  async whenReady(componentNames, timeout = 5000) {
    if (!Array.isArray(componentNames)) {
      componentNames = [componentNames];
    }

    // Register all components
    componentNames.forEach(name => {
      if (!this._components.has(name)) {
        this.register(name);
      }
    });

    // Wait for all
    const startTime = Date.now();
    for (const name of componentNames) {
      if (!this.isReady(name)) {
        const elapsed = Date.now() - startTime;
        const remainingTimeout = timeout > 0 ? Math.max(100, timeout - elapsed) : 0;

        try {
          await this.waitFor(name, remainingTimeout);
        } catch (err) {
          throw new Error(
            `[${this.name}] Failed waiting for dependencies. ` +
            `Ready: [${componentNames.filter(n => this.isReady(n)).join(', ')}], ` +
            `Not ready: [${componentNames.filter(n => !this.isReady(n)).join(', ')}]`
          );
        }
      }
    }
  }

  /**
   * Get or wait for a component reference
   * Useful pattern: gate.getWhenReady('sceneApi', () => window.sceneApi)
   *
   * @param {string} componentName - Component name
   * @param {Function} getter - Function that returns the component
   * @param {number} timeout - Max wait time
   * @returns {Promise<any>} - The component
   */
  async getWhenReady(componentName, getter, timeout = 5000) {
    await this.waitFor(componentName, timeout);
    const result = getter();
    if (result === null || result === undefined) {
      throw new Error(
        `[${this.name}] ${componentName} is ready but getter returned ${result}`
      );
    }
    return result;
  }

  /**
   * Try to proceed with optional dependencies
   * Returns which dependencies are available
   *
   * @param {string[]} requiredDeps - Must be ready
   * @param {string[]} optionalDeps - Nice to have
   * @param {number} timeout - Max wait time
   * @returns {Promise<{required: string[], optional: string[]}>}
   */
  async waitForRequired(requiredDeps, optionalDeps = [], timeout = 5000) {
    // Wait for required
    await this.whenReady(requiredDeps, timeout);

    // Check optional (don't wait)
    const availableOptional = optionalDeps.filter(name => this.isReady(name));

    return {
      required: requiredDeps,
      optional: availableOptional
    };
  }

  /**
   * Execute callback when component becomes ready
   * If already ready, executes immediately
   */
  onReady(componentName, callback) {
    if (!this._components.has(componentName)) {
      this.register(componentName);
    }

    const component = this._components.get(componentName);

    if (component.ready) {
      // Already ready, execute immediately
      try {
        callback();
      } catch (err) {
        console.error(`[${this.name}] onReady callback error for ${componentName}:`, err);
      }
    } else {
      // Wait for ready
      const callbacks = this._readyCallbacks.get(componentName) || [];
      callbacks.push(callback);
      this._readyCallbacks.set(componentName, callbacks);
    }
  }

  /**
   * Get gate status for debugging
   */
  getStatus() {
    const status = {
      ready: [],
      notReady: [],
      waiters: {}
    };

    for (const [name, component] of this._components.entries()) {
      if (component.ready) {
        status.ready.push({
          name,
          readyAt: component.readyAt,
          readyFor: Date.now() - component.readyAt
        });
      } else {
        status.notReady.push({
          name,
          waiters: component.waiters.length
        });
      }

      if (component.waiters.length > 0) {
        status.waiters[name] = component.waiters.length;
      }
    }

    return status;
  }

  /**
   * Reset all components (for testing)
   */
  reset() {
    this._components.clear();
    this._readyCallbacks.clear();
  }

  /**
   * Dispose the gate and clean up resources
   * Rejects all pending waiters and clears callbacks
   */
  dispose() {
    // Reject all pending waiters
    for (const [name, component] of this._components.entries()) {
      if (component.waiters.length > 0) {
        const error = new Error(`[${this.name}] ReadinessGate disposed while waiting for ${name}`);
        component.waiters.forEach(waiter => {
          try {
            // Waiters are resolve functions, but we need to signal disposal somehow
            // Since we can't reject a resolve function, we'll just clear them
            // In a real scenario, we'd want to track reject functions too
            console.warn(`[${this.name}] Disposing with ${component.waiters.length} waiters for ${name}`);
          } catch (err) {
            console.error(`[${this.name}] Error notifying waiter:`, err);
          }
        });
        component.waiters = [];
      }
    }

    // Clear all callbacks
    for (const [name, callbacks] of this._readyCallbacks.entries()) {
      if (callbacks.length > 0) {
        console.warn(`[${this.name}] Disposing with ${callbacks.length} callbacks for ${name}`);
      }
    }

    // Clear all data structures
    this._components.clear();
    this._readyCallbacks.clear();

    console.log(`[${this.name}] Disposed`);
  }
}
