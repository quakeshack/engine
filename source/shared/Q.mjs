import { EPSILON } from './Defs.mjs';

/**
 * Utility class for common engine functions.
 */
export default class Q {
  /**
   * Converts a Uint8Array or array of bytes to a string, stopping at the first zero byte.
   * @param {Uint8Array|number[]} src - Source byte array.
   * @returns {string} The resulting string.
   */
  static memstr(src) {
    const dest = [];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === 0) {
        break;
      }
      dest[i] = String.fromCharCode(src[i]);
    }
    return dest.join('');
  }

  /**
   * Converts a string to an ArrayBuffer of bytes (8-bit, zero-padded).
   * @param {string} src - Source string.
   * @returns {ArrayBuffer} The resulting ArrayBuffer.
   */
  static strmem(src) {
    const buf = new ArrayBuffer(src.length);
    const dest = new Uint8Array(buf);
    for (let i = 0; i < src.length; i++) {
      dest[i] = src.charCodeAt(i) & 255;
    }
    return buf;
  }

  /**
   * Checks if a value is NaN.
   * @param {number} value - Value to check.
   * @returns {boolean} True if value is NaN.
   */
  static isNaN(value) {
    return Number.isNaN(value);
  }

  /**
   * Converts a string to an integer.
   * NOTE: Use `+value|0` during regular use in the main/rendering loop.
   * @param {string} value - String to convert.
   * @returns {number} The integer value.
   */
  static atoi(value) {
    return parseInt(value);
  }

  /**
   * Converts a string to a float.
   * NOTE: Use `+value` during regular use in the main/rendering loop.
   * @param {string} value - String to convert.
   * @returns {number} The float value.
   */
  static atof(value) {
    return parseFloat(value);
  }

  /**
   * Encodes a byte array to a base64 string.
   * @param {Uint8Array|number[]} src - Source byte array.
   * @returns {string} Base64-encoded string.
   */
  static btoa(src) {
    const str = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const val = [];
    const len = src.length - (src.length % 3);
    let c; let i;
    for (i = 0; i < len; i += 3) {
      c = (src[i] << 16) + (src[i + 1] << 8) + src[i + 2];
      val[val.length] = str.charAt(c >> 18) + str.charAt((c >> 12) & 63) + str.charAt((c >> 6) & 63) + str.charAt(c & 63);
    }
    if ((src.length - len) === 1) {
      c = src[len];
      val[val.length] = str.charAt(c >> 2) + str.charAt((c & 3) << 4) + '==';
    } else if ((src.length - len) === 2) {
      c = (src[len] << 8) + src[len + 1];
      val[val.length] = str.charAt(c >> 10) + str.charAt((c >> 4) & 63) + str.charAt((c & 15) << 2) + '=';
    }
    return val.join('');
  }

  /**
   * Turns seconds like 3692 into a string like "01:01:32".
   * @param {number} secs seconds
   * @returns {string} hours:mins:seconds
   */
  static secsToTime(secs) {
    let negative = secs < 0;
    let seconds = Math.floor(Math.abs(secs));
    let minutes = Math.floor(seconds / 60);
    let hours = 0;
    if (minutes > 0) {
      seconds -= minutes * 60;
      hours = Math.floor(minutes / 60);
      if (hours !== 0) {
        minutes -= hours * 60;
      }
    }

    return `${negative ? '-' : ''}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  /**
   * Yields execution to the event loop (async).
   * @returns {Promise<void>} Promise that resolves on next tick.
   */
  static yield() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Sleeps for a given number of milliseconds (async).
   * @param {number} msec - Milliseconds to sleep.
   * @returns {Promise<void>} Promise that resolves after the delay.
   */
  static sleep(msec) {
    return new Promise((resolve) => setTimeout(resolve, msec));
  }

  /**
   * Compares two floating point numbers for near-equality.
   * @param {number} a - First number.
   * @param {number} b - Second number.
   * @param {number} epsilon Tolerance for comparison, optional.
   * @returns {boolean} True if numbers are nearly equal.
   */
  static compareFloat(a, b, epsilon = EPSILON) {
    return Math.abs(a - b) < epsilon;
  }
};

/**
 * Helper functions for enums.
 * @readonly
 */
export const enumHelpers = Object.freeze({
  /**
   * @param {string|number|null} val enum value
   * @returns {string} enum key
   */
  toKey(val) {
    // @ts-ignore
    return /** @type {string} */ (Object.entries(this).find(([, v]) => v === val)?.[0] ?? `unknown (${val})`);
  },

  /**
   * @param {string} name enum key
   * @returns {string|number|null} enum value
   */
  fromKey(name) {
    // @ts-ignore
    return this[name] ?? null;
  },
});

export const AsyncFunction = (async function() {}).constructor;
