/**
 * AsyncOperationRegistry - Elegant async operation lifecycle management
 *
 * Philosophy: Async operations should be first-class citizens with:
 * - Unique identity (tokens)
 * - Cancellation support
 * - Automatic stale result filtering
 * - Timeout coordination
 *
 * Makes race conditions impossible by design.
 */

export class AsyncOperationRegistry {
  constructor(name = 'AsyncRegistry') {
    this.name = name;
    this._operations = new Map(); // tokenId -> operation metadata
    this._nextId = 1;
    this._activeCategory = new Map(); // category -> current tokenId
  }

  /**
   * Register a new async operation
   * @param {string} category - Operation category (e.g., 'bpm-analysis', 'file-load')
   * @param {Object} options - { timeout, onCancel }
   * @returns {AsyncOperationToken}
   */
  register(category, options = {}) {
    const tokenId = this._nextId++;

    const token = new AsyncOperationToken(
      tokenId,
      category,
      this,
      options
    );

    this._operations.set(tokenId, {
      token,
      category,
      createdAt: Date.now(),
      status: 'active',
      options
    });

    // Cancel previous operation in same category if exists
    const prevTokenId = this._activeCategory.get(category);
    if (prevTokenId !== undefined) {
      const prevOp = this._operations.get(prevTokenId);
      if (prevOp && prevOp.status === 'active') {
        prevOp.token._cancel('superseded');
      }
    }

    this._activeCategory.set(category, tokenId);

    return token;
  }

  /**
   * Check if a token is still active (not cancelled, not completed)
   */
  isActive(tokenId) {
    const op = this._operations.get(tokenId);
    return op && op.status === 'active';
  }

  /**
   * Mark token as completed
   */
  _complete(tokenId, status = 'completed') {
    const op = this._operations.get(tokenId);
    if (op) {
      op.status = status;
      op.completedAt = Date.now();
    }
  }

  /**
   * Cancel all operations in a category
   */
  cancelCategory(category) {
    const tokenId = this._activeCategory.get(category);
    if (tokenId !== undefined) {
      const op = this._operations.get(tokenId);
      if (op && op.status === 'active') {
        op.token._cancel('manual');
      }
    }
  }

  /**
   * Clean up old completed operations
   */
  cleanup(maxAge = 60000) {
    const now = Date.now();
    for (const [tokenId, op] of this._operations.entries()) {
      if (op.status !== 'active' && (now - op.completedAt) > maxAge) {
        this._operations.delete(tokenId);
      }
    }
  }

  /**
   * Get registry stats for debugging
   */
  getStats() {
    const stats = {
      total: this._operations.size,
      active: 0,
      completed: 0,
      cancelled: 0,
      failed: 0,
      byCategory: {}
    };

    for (const op of this._operations.values()) {
      stats[op.status]++;
      stats.byCategory[op.category] = (stats.byCategory[op.category] || 0) + 1;
    }

    return stats;
  }
}

/**
 * Token representing a single async operation
 */
export class AsyncOperationToken {
  constructor(id, category, registry, options = {}) {
    this.id = id;
    this.category = category;
    this._registry = registry;
    this._options = options;
    this._cancelled = false;
    this._cancelReason = null;
    this._cancelCallbacks = [];
  }

  /**
   * Wrap a promise with automatic cancellation handling
   * @param {Promise} promise - The operation to wrap
   * @param {number} timeout - Optional timeout in ms
   * @returns {Promise} - Rejects if cancelled or timeout
   */
  async wrap(promise, timeout = null) {
    timeout = timeout ?? this._options.timeout;

    return new Promise((resolve, reject) => {
      let timeoutId = null;
      let isResolved = false;

      // Cancellation handler
      const onCancel = (reason) => {
        if (isResolved) return;
        isResolved = true;
        if (timeoutId) clearTimeout(timeoutId);
        reject(new CancelledError(this.category, reason));
      };

      this._cancelCallbacks.push(onCancel);

      // Timeout handler
      if (timeout && timeout > 0) {
        timeoutId = setTimeout(() => {
          if (isResolved) return;
          isResolved = true;
          this._cancel('timeout');
          reject(new TimeoutError(this.category, timeout));
        }, timeout);
      }

      // Actual operation
      promise
        .then(result => {
          if (isResolved) {
            // Operation completed but we already timed out/cancelled
            console.warn(`[${this._registry.name}] Late result for ${this.category}:${this.id} (already resolved)`);
            return;
          }
          isResolved = true;
          if (timeoutId) clearTimeout(timeoutId);

          // Check if still active (not superseded by another operation)
          if (this._registry.isActive(this.id)) {
            this._registry._complete(this.id, 'completed');
            resolve(result);
          } else {
            console.warn(`[${this._registry.name}] Discarding stale result for ${this.category}:${this.id}`);
            reject(new CancelledError(this.category, 'stale'));
          }
        })
        .catch(err => {
          if (isResolved) return;
          isResolved = true;
          if (timeoutId) clearTimeout(timeoutId);
          this._registry._complete(this.id, 'failed');
          reject(err);
        });
    });
  }

  /**
   * Check if this token has been cancelled
   */
  isCancelled() {
    return this._cancelled;
  }

  /**
   * Internal: Cancel this operation
   */
  _cancel(reason) {
    if (this._cancelled) return;

    this._cancelled = true;
    this._cancelReason = reason;
    this._registry._complete(this.id, 'cancelled');

    // Execute onCancel callback if provided
    if (this._options.onCancel) {
      try {
        this._options.onCancel(reason);
      } catch (err) {
        console.error(`[${this._registry.name}] onCancel error:`, err);
      }
    }

    // Notify all waiting promises
    this._cancelCallbacks.forEach(cb => {
      try {
        cb(reason);
      } catch (err) {
        console.error(`[${this._registry.name}] Cancel callback error:`, err);
      }
    });
    this._cancelCallbacks = [];
  }

  /**
   * Manually complete this token (call after operation succeeds)
   */
  complete() {
    if (this._registry.isActive(this.id)) {
      this._registry._complete(this.id, 'completed');
    }
  }
}

/**
 * Error thrown when an operation is cancelled
 */
export class CancelledError extends Error {
  constructor(category, reason) {
    super(`Operation cancelled: ${category} (${reason})`);
    this.name = 'CancelledError';
    this.category = category;
    this.reason = reason;
    this.isCancelled = true;
  }
}

/**
 * Error thrown when an operation times out
 */
export class TimeoutError extends Error {
  constructor(category, timeout) {
    super(`Operation timed out: ${category} (${timeout}ms)`);
    this.name = 'TimeoutError';
    this.category = category;
    this.timeout = timeout;
    this.isTimeout = true;
  }
}
