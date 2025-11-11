/**
 * LocalStorage Mutex
 * ==================
 * Coordinates concurrent writes to localStorage across components
 * to prevent race conditions and data corruption.
 *
 * Usage:
 *   import { storageMutex } from './storage/localStorage-mutex.js';
 *
 *   await storageMutex.withLock('myKey', async () => {
 *     // Critical section - exclusive access
 *     const data = localStorage.getItem('myKey');
 *     const updated = doSomething(data);
 *     localStorage.setItem('myKey', updated);
 *   });
 */

class LocalStorageMutex {
  constructor() {
    // Map of key -> timestamp when lock was acquired
    this.locks = new Map();

    // Map of key -> array of waiting promises
    this.waitQueue = new Map();
  }

  /**
   * Acquire exclusive lock for a storage key
   * @param {string} key - The storage key to lock
   * @param {number} timeout - Max time to wait for lock in ms
   * @returns {Promise<void>}
   * @throws {Error} If timeout expires before acquiring lock
   */
  async acquire(key, timeout = 5000) {
    const start = Date.now();

    while (this.locks.has(key)) {
      if (Date.now() - start > timeout) {
        throw new Error(`[LocalStorageMutex] Timeout acquiring lock for: ${key}`);
      }

      // Wait a short time before checking again
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this.locks.set(key, Date.now());
  }

  /**
   * Release lock for a storage key
   * @param {string} key - The storage key to unlock
   */
  release(key) {
    this.locks.delete(key);
  }

  /**
   * Execute function with exclusive lock (recommended API)
   * @param {string} key - The storage key to lock
   * @param {Function} fn - Async function to execute with lock held
   * @param {number} timeout - Max time to wait for lock
   * @returns {Promise<any>} Result of fn()
   */
  async withLock(key, fn, timeout = 5000) {
    await this.acquire(key, timeout);

    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  /**
   * Check if a key is currently locked
   * @param {string} key - The storage key to check
   * @returns {boolean}
   */
  isLocked(key) {
    return this.locks.has(key);
  }

  /**
   * Get lock statistics for debugging
   * @returns {Object}
   */
  getStats() {
    return {
      activeLocks: this.locks.size,
      lockedKeys: Array.from(this.locks.keys()),
      oldestLock: this.locks.size > 0
        ? Math.min(...this.locks.values())
        : null
    };
  }

  /**
   * Force-release all locks (use only in emergencies)
   */
  releaseAll() {
    const count = this.locks.size;
    this.locks.clear();
    this.waitQueue.clear();
    console.warn(`[LocalStorageMutex] Force-released ${count} locks`);
  }
}

// Singleton instance
export const storageMutex = new LocalStorageMutex();

// Expose for debugging
if (typeof window !== 'undefined') {
  window.__storageMutex = storageMutex;
}
