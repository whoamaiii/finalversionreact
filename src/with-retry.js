/**
 * withRetry - Elegant retry logic for async operations
 *
 * Philosophy: Failure is temporary. Network hiccups shouldn't break features.
 * This utility adds intelligent retry logic with exponential backoff to any
 * async operation.
 *
 * Makes network failures graceful and predictable.
 */

/**
 * Backoff strategies for retry delays
 */
const BackoffStrategy = {
  /**
   * Linear backoff: delay * attempt (1s, 2s, 3s, 4s...)
   */
  linear: (baseDelay, attempt) => baseDelay * attempt,

  /**
   * Exponential backoff: delay * 2^(attempt-1) (1s, 2s, 4s, 8s...)
   * Standard for network retries - prevents hammering failed services
   */
  exponential: (baseDelay, attempt) => baseDelay * Math.pow(2, attempt - 1),

  /**
   * Fixed backoff: same delay every time (1s, 1s, 1s...)
   */
  fixed: (baseDelay) => baseDelay,
};

/**
 * Default retry configuration
 */
const DEFAULT_OPTIONS = {
  maxAttempts: 3,
  baseDelay: 1000, // 1 second
  backoff: 'exponential',
  shouldRetry: () => true, // Retry all errors by default
  onRetry: null, // Optional callback on each retry
  onFinalError: null, // Optional callback on final failure
};

/**
 * Retry an async operation with exponential backoff
 *
 * @param {Function} operation - Async function to retry
 * @param {Object} options - Retry configuration
 * @param {number} options.maxAttempts - Maximum number of attempts (default: 3)
 * @param {number} options.baseDelay - Base delay in ms (default: 1000)
 * @param {string} options.backoff - Backoff strategy: 'linear', 'exponential', 'fixed' (default: 'exponential')
 * @param {Function} options.shouldRetry - Function to determine if error should trigger retry (default: always retry)
 * @param {Function} options.onRetry - Callback called on each retry attempt (attempt, error) => void
 * @param {Function} options.onFinalError - Callback called when all retries exhausted (error, attempts) => void
 * @returns {Promise} - Resolves with operation result or rejects with final error
 *
 * @example
 * // Basic usage with defaults (3 attempts, exponential backoff)
 * const result = await withRetry(() => fetch('/api/data'));
 *
 * @example
 * // Custom retry logic
 * const result = await withRetry(
 *   () => loadFromCDN(url),
 *   {
 *     maxAttempts: 5,
 *     baseDelay: 2000,
 *     backoff: 'exponential',
 *     shouldRetry: (err) => err.isNetwork || err.statusCode === 503,
 *     onRetry: (attempt, err) => {
 *       console.log(`Retry attempt ${attempt}: ${err.message}`);
 *     },
 *     onFinalError: (err, attempts) => {
 *       console.error(`Failed after ${attempts} attempts:`, err);
 *     }
 *   }
 * );
 */
export async function withRetry(operation, options = {}) {
  // Merge with defaults
  const config = { ...DEFAULT_OPTIONS, ...options };

  // Validate maxAttempts
  if (config.maxAttempts < 1) {
    throw new Error('maxAttempts must be at least 1');
  }

  // Get backoff function
  const backoffFn = BackoffStrategy[config.backoff] || BackoffStrategy.exponential;

  // Track attempts
  let lastError = null;
  let attempt = 0;

  while (attempt < config.maxAttempts) {
    attempt++;

    try {
      // Attempt the operation
      const result = await operation();
      return result; // Success!
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      const shouldRetry = config.shouldRetry(error);

      if (!shouldRetry) {
        // Error is not retryable, fail immediately
        throw error;
      }

      // Check if we have attempts left
      if (attempt >= config.maxAttempts) {
        // No more attempts, fail
        break;
      }

      // Calculate delay for next attempt
      const delay = backoffFn(config.baseDelay, attempt);

      // Call retry callback if provided
      if (config.onRetry) {
        try {
          config.onRetry(attempt, error, delay);
        } catch (callbackErr) {
          console.error('[withRetry] onRetry callback error:', callbackErr);
        }
      }

      // Wait before retrying
      await sleep(delay);
    }
  }

  // All attempts exhausted - call final error callback
  if (config.onFinalError) {
    try {
      config.onFinalError(lastError, attempt);
    } catch (callbackErr) {
      console.error('[withRetry] onFinalError callback error:', callbackErr);
    }
  }

  // Throw the last error
  throw lastError;
}

/**
 * Helper: Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pre-configured retry strategies for common use cases
 */
export const RetryPresets = {
  /**
   * Network requests - 3 attempts, exponential backoff
   */
  network: {
    maxAttempts: 3,
    baseDelay: 1000,
    backoff: 'exponential',
    shouldRetry: (err) => {
      // Retry on network errors or 5xx server errors
      return err.isNetwork ||
             err.name === 'NetworkError' ||
             err.name === 'TypeError' || // Fetch network errors
             (err.statusCode >= 500 && err.statusCode < 600);
    },
  },

  /**
   * CDN loads - 5 attempts, exponential backoff, longer delays
   */
  cdn: {
    maxAttempts: 5,
    baseDelay: 2000,
    backoff: 'exponential',
    shouldRetry: (err) => {
      // Retry on network errors, 5xx, or rate limiting
      return err.isNetwork ||
             err.name === 'NetworkError' ||
             err.name === 'TypeError' ||
             (err.statusCode >= 500 && err.statusCode < 600) ||
             err.statusCode === 429; // Rate limited
    },
  },

  /**
   * Quick retries - 2 attempts, fixed delay
   */
  quick: {
    maxAttempts: 2,
    baseDelay: 500,
    backoff: 'fixed',
  },

  /**
   * Patient retries - 10 attempts, linear backoff
   */
  patient: {
    maxAttempts: 10,
    baseDelay: 1000,
    backoff: 'linear',
  },
};

/**
 * Error class for when all retries are exhausted
 */
export class RetryExhaustedError extends Error {
  constructor(message, originalError, attempts) {
    super(message);
    this.name = 'RetryExhaustedError';
    this.originalError = originalError;
    this.attempts = attempts;
    this.isRetryExhausted = true;
  }
}
