/**
 * Shared utility functions
 *
 * Common helper functions used across multiple modules to reduce code duplication.
 */

/**
 * Deep clone an object using structuredClone (modern browsers) with JSON fallback
 *
 * @param {*} value - Value to clone (any cloneable type)
 * @returns {*} Deep copy of the value
 *
 * Note: Uses structuredClone when available (supports Maps, Sets, Dates, typed arrays)
 * Falls back to JSON.parse(JSON.stringify()) for older browsers (limited to JSON-safe types)
 */
export function deepClone(value) {
  if (value === null || value === undefined) return value;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch (_) {
    // structuredClone not available or failed, fall back to JSON
  }
  return JSON.parse(JSON.stringify(value));
}
